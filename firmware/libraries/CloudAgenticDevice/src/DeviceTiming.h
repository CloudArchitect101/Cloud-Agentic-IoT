#pragma once
/**
 * DeviceTiming - the fleet-safety arithmetic of CloudAgenticDevice: when to
 * retry a connection, when to send the next reading, and when live mode ends.
 *
 * Nothing here touches Arduino, so test/firmware compiles and checks it on any
 * machine with a C++ compiler. Randomness comes in as an argument
 * (esp_random() on a board) for the same reason.
 */

#include <stdint.h>

namespace cad {

// millis() wraps to zero every 49.7 days, and hospital hardware stays up
// longer than that. A plain "now >= at" would then stall for 49 days; a signed
// difference stays right across the wrap.
inline bool reached(uint32_t now, uint32_t at) {
  return (int32_t)(now - at) >= 0;
}

// True once `at` has come. `at` is only ever scheduled up to maxAheadMs into
// the future, so a deadline that looks further away than that is one that
// passed so long ago (24.8 days or more, a board left disconnected) that the
// signed difference flipped sign. That counts as due too.
inline bool due(uint32_t now, uint32_t at, uint32_t maxAheadMs) {
  return reached(now, at) || (uint32_t)(at - now) > maxAheadMs;
}

// A uniformly random value in [low, high], from a uniformly random 32-bit one.
inline uint32_t between(uint32_t low, uint32_t high, uint32_t random32) {
  if (high <= low) return low;
  return low + (uint32_t)(((uint64_t)random32 * ((uint64_t)(high - low) + 1)) >> 32);
}

/**
 * Exponential backoff with full jitter. After the n-th failure in a row, the
 * wait is random in [floorMs, min(capMs, baseMs * 2^(n-1))].
 *
 * Why it matters at fleet scale: when AWS IoT or a hospital's network drops,
 * every board loses its connection in the same second. Boards that all retry
 * every second, as this library used to, reconnect in lockstep and keep
 * hitting the account's connect quota (3,000 a second by default) together.
 * Random waits that double each time spread a million boards out instead:
 * with a five-minute cap they arrive at about 1,000,000 / 300 s = 3,333 a
 * second, the size of that quota. AWS describes the method in "Exponential
 * Backoff And Jitter" on the AWS Architecture Blog.
 *
 * The floor stays at one second because AWS IoT accepts one connect per
 * second per client ID, a quota that cannot be raised.
 */
class Backoff {
 public:
  Backoff(uint32_t baseMs, uint32_t capMs, uint32_t floorMs)
    : _base(baseMs), _cap(capMs), _floor(floorMs), _failures(0) {}

  /** Records a failed attempt; returns how long to wait before the next. */
  uint32_t fail(uint32_t random32) {
    if (_failures < 32) _failures++;
    uint32_t doublings = _failures - 1;
    uint32_t ceiling = _cap;
    // _base << doublings, unless that would pass the cap (or 32 bits).
    if (doublings < 32 && _base <= (_cap >> doublings)) ceiling = _base << doublings;
    if (ceiling < _floor) ceiling = _floor;
    return between(_floor, ceiling, random32);
  }

  /** A success: the next failure starts again from the shortest wait. */
  void reset() { _failures = 0; }

  uint32_t failures() const { return _failures; }
  uint32_t capMs() const { return _cap; }

 private:
  uint32_t _base, _cap, _floor, _failures;
};

// The fleet sets the reading interval within these bounds (SET_TELEMETRY_INTERVAL).
// Below 5 seconds a board would spend its time on TLS and radio; above a day
// it would look dead to anyone watching for it.
const uint32_t MIN_TELEMETRY_SECONDS = 5;
const uint32_t MAX_TELEMETRY_SECONDS = 86400;   // a day

inline bool validTelemetrySeconds(long seconds) {
  return seconds >= (long)MIN_TELEMETRY_SECONDS && seconds <= (long)MAX_TELEMETRY_SECONDS;
}

// Live mode (the LIVE command) asks for a reading every MIN_LIVE_SECONDS to
// MAX_LIVE_SECONDS, for 1 to MAX_LIVE_MINUTES minutes; 0 minutes ends it. The
// card that asks renews it while it stays open, so the cap is how long a board
// can go on streaming, and being billed for it, after its viewer has gone.
const uint32_t MIN_LIVE_SECONDS = 1;
const uint32_t MAX_LIVE_SECONDS = 60;
const uint32_t MAX_LIVE_MINUTES = 30;

// Ending live mode needs no interval, so 0 minutes is accepted whatever
// `seconds` says.
inline bool validLive(long seconds, long minutes) {
  if (minutes == 0) return true;
  return seconds >= (long)MIN_LIVE_SECONDS && seconds <= (long)MAX_LIVE_SECONDS
      && minutes >= 1 && minutes <= (long)MAX_LIVE_MINUTES;
}

/**
 * The live window: a reading every few seconds for a few minutes, on top of
 * the stored ones, while someone watches the board.
 *
 * The window is kept as the time it started and its length, and "open" is
 * measured as time elapsed since the start. That difference is right across
 * the millis() wrap for 49 days, where a deadline compared as "now < end"
 * would close a window that crosses the wrap at once.
 */
class LiveWindow {
 public:
  LiveWindow() : _open(false), _startedAt(0), _lengthMs(0), _intervalMs(0), _nextAt(0) {}

  /** A LIVE command at `now`, already checked with validLive(): the window
   *  opens for `minutes` from now, with a reading every `seconds`, the first
   *  one due at once so a viewer is not left waiting a whole interval. A
   *  command while it is open starts it over from now: the card renews it
   *  that way. 0 minutes closes it. */
  void start(uint32_t now, uint32_t seconds, uint32_t minutes) {
    _open = minutes > 0;
    _startedAt = now;
    _lengthMs = minutes * 60000u;
    _intervalMs = seconds * 1000u;
    _nextAt = now;
  }

  /** Open at `now`: started, and not yet run out. */
  bool open(uint32_t now) const {
    return _open && (uint32_t)(now - _startedAt) < _lengthMs;
  }

  /** True once per interval while the window is open. Like telemetry, the
   *  next reading is an interval from now, not from the slot that was missed:
   *  a board back from a dropped connection sends one reading, not a burst. */
  bool due(uint32_t now) {
    if (!open(now) || !cad::due(now, _nextAt, _intervalMs)) return false;
    _nextAt = now + _intervalMs;
    return true;
  }

  /** True once, the first time it is asked after the window ran out by
   *  itself: the moment to say so. A window closed by a 0-minute command
   *  never reports this; that command says so itself. The library asks on
   *  every pass of loop(), so the elapsed time it measures never comes near
   *  the 49 days after which it would repeat. */
  bool ended(uint32_t now) {
    if (!_open || open(now)) return false;
    _open = false;
    return true;
  }

 private:
  bool _open;
  uint32_t _startedAt, _lengthMs, _intervalMs, _nextAt;
};

}  // namespace cad
