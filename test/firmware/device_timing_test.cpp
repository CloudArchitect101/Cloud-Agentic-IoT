// Host-side checks of firmware/libraries/CloudAgenticDevice/src/DeviceTiming.h,
// compiled and run by device-timing.test.js. No Arduino needed: the header is
// plain C++ on purpose.
//
// The last test is a fleet simulation: a million boards lose AWS at once, and
// the test measures how they come back against the account's connect quota.

#include <cstdio>
#include <cstdint>
#include <cstdlib>
#include <vector>

#include "../../firmware/libraries/CloudAgenticDevice/src/DeviceTiming.h"

static int failures = 0;
#define CHECK(cond) do { if (!(cond)) { std::printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond); failures++; } } while (0)

// xorshift32: a deterministic stand-in for esp_random().
static uint32_t rng_state = 2463534242u;
static uint32_t next_random() {
  rng_state ^= rng_state << 13;
  rng_state ^= rng_state >> 17;
  rng_state ^= rng_state << 5;
  return rng_state;
}

static void millis_wrap() {
  // 32 ms after a deadline set 16 ms before millis() wrapped to zero.
  CHECK(cad::reached(0x00000010u, 0xFFFFFFF0u));
  CHECK(!cad::reached(0xFFFFFFF0u, 0x00000010u));
  CHECK(cad::reached(5000, 5000));
  CHECK(!cad::reached(4999, 5000));

  // A deadline at most 30 s ahead that seems to be 25 days ahead was missed
  // long ago (a board left offline): due, not "wait 25 more days".
  CHECK(!cad::due(1000, 1000 + 29000, 30000));
  CHECK(cad::due(1000, 1000 + 0x80000005u, 30000));
  CHECK(cad::due(0xFFFFF000u, 0x00000100u - 0x2000u, 30000));
}

static void between_bounds() {
  CHECK(cad::between(10, 20, 0) == 10);
  CHECK(cad::between(10, 20, 0xFFFFFFFFu) == 20);
  CHECK(cad::between(0, 0, 12345) == 0);
  CHECK(cad::between(7, 3, 12345) == 7);
  CHECK(cad::between(0, 0xFFFFFFFFu, 0xFFFFFFFFu) == 0xFFFFFFFFu);
  for (int i = 0; i < 100000; i++) {
    uint32_t v = cad::between(1000, 4000, next_random());
    CHECK(v >= 1000 && v <= 4000);
    if (v < 1000 || v > 4000) break;
  }
}

static void backoff_doubles_to_the_cap() {
  cad::Backoff b(1000, 300000, 1000);
  CHECK(b.fail(0xFFFFFFFFu) == 1000);     // 1st failure: exactly the 1 s floor
  CHECK(b.fail(0xFFFFFFFFu) == 2000);     // then the ceiling doubles
  CHECK(b.fail(0xFFFFFFFFu) == 4000);
  CHECK(b.fail(0) == 1000);               // and the floor holds at any draw
  for (int i = 0; i < 4; i++) b.fail(0);  // 8 failures so far
  CHECK(b.fail(0xFFFFFFFFu) == 256000);   // 9th: 1000 * 2^8
  CHECK(b.fail(0xFFFFFFFFu) == 300000);   // 10th: 512 s would pass the cap
  for (int i = 0; i < 1000; i++) {        // no overflow, however long it fails
    uint32_t wait = b.fail(next_random());
    CHECK(wait >= 1000 && wait <= 300000);
    if (wait < 1000 || wait > 300000) break;
  }
  b.reset();
  CHECK(b.failures() == 0);
  CHECK(b.fail(0xFFFFFFFFu) == 1000);     // a success starts it over
}

static void telemetry_bounds() {
  CHECK(!cad::validTelemetrySeconds(0));
  CHECK(!cad::validTelemetrySeconds(4));
  CHECK(cad::validTelemetrySeconds(5));
  CHECK(cad::validTelemetrySeconds(30));
  CHECK(cad::validTelemetrySeconds(86400));
  CHECK(!cad::validTelemetrySeconds(86401));
  CHECK(!cad::validTelemetrySeconds(-30));
}

static void live_bounds() {
  CHECK(cad::validLive(2, 15));
  CHECK(cad::validLive(1, 1));
  CHECK(cad::validLive(60, 30));
  CHECK(!cad::validLive(0, 15));      // no interval
  CHECK(!cad::validLive(61, 15));
  CHECK(!cad::validLive(-2, 15));
  CHECK(!cad::validLive(2, 31));      // past the cap
  CHECK(!cad::validLive(2, -1));      // a command without minutes reads as -1
  CHECK(cad::validLive(0, 0));        // 0 minutes ends it, and needs no interval
  CHECK(cad::validLive(999, 0));
}

// After a LIVE command the first reading is due at once, then one per interval.
static void live_first_reading_at_once() {
  cad::LiveWindow w;
  CHECK(!w.open(0));                  // off until a command opens it
  CHECK(!w.due(0));

  const uint32_t t0 = 123456;
  w.start(t0, 2, 15);
  CHECK(w.open(t0));
  CHECK(w.due(t0));                   // at once, not 2 s later
  CHECK(!w.due(t0));                  // and once
  CHECK(!w.due(t0 + 1999));
  CHECK(w.due(t0 + 2000));
  CHECK(!w.due(t0 + 2001));

  // Not asked for 10 s (the board was offline): one reading on its return,
  // not the five it missed, and the next an interval after that one.
  CHECK(w.due(t0 + 12000));
  CHECK(!w.due(t0 + 12001));
  CHECK(!w.due(t0 + 13999));
  CHECK(w.due(t0 + 14000));
}

// The window runs out by itself `minutes` after the command, and says so once.
static void live_window_runs_out() {
  const uint32_t t0 = 5000, end = t0 + 15 * 60000u;

  cad::LiveWindow w;
  w.start(t0, 2, 15);
  CHECK(w.open(end - 1));
  CHECK(!w.open(end));
  CHECK(!w.ended(end - 1));
  CHECK(w.ended(end));
  CHECK(!w.ended(end + 1));           // once
  CHECK(!w.due(end + 1));

  // Asked every millisecond, as loop() does: 450 readings, at 0, 2, ... 898 s.
  cad::LiveWindow every;
  every.start(t0, 2, 15);
  uint32_t readings = 0, endings = 0, endedAt = 0;
  for (uint32_t now = t0; now != end + 5000; now++) {
    if (every.due(now)) readings++;
    if (every.ended(now)) { endings++; endedAt = now; }
  }
  CHECK(readings == 450);
  CHECK(endings == 1);
  CHECK(endedAt == end);
}

// The card renews the window while it stays open: each LIVE command starts it
// over from its own time, so it ends `minutes` after the last command.
static void live_second_command_extends() {
  const uint32_t t0 = 1000, renew = t0 + 10 * 60000u;

  cad::LiveWindow w;
  w.start(t0, 2, 15);
  CHECK(w.due(t0));
  w.start(renew, 5, 15);              // renewed, at another pace
  CHECK(w.due(renew));                // at once again, for a card just opened
  CHECK(!w.due(renew + 4999));        // the new pace
  CHECK(w.due(renew + 5000));
  CHECK(w.open(t0 + 15 * 60000u));    // past the first command's end
  CHECK(!w.ended(t0 + 15 * 60000u));  // and no "live: off" there
  CHECK(w.open(renew + 15 * 60000u - 1));
  CHECK(!w.open(renew + 15 * 60000u));
  CHECK(w.ended(renew + 15 * 60000u));

  // A shorter command shortens it: the last one is the one that counts.
  cad::LiveWindow s;
  s.start(t0, 2, 15);
  s.start(t0 + 60000, 2, 1);
  CHECK(s.open(t0 + 119999));
  CHECK(!s.open(t0 + 120000));
}

// LIVE with 0 minutes: off at once. The command says so itself, so the
// window must not say it again when the old one would have run out.
static void live_zero_minutes() {
  cad::LiveWindow never;
  never.start(1000, 2, 0);
  CHECK(!never.open(1000));
  CHECK(!never.due(1000));
  CHECK(!never.ended(1000));

  cad::LiveWindow w;
  w.start(1000, 2, 15);
  CHECK(w.due(1000));
  w.start(61000, 2, 0);               // turned off a minute in
  CHECK(!w.open(61000));
  CHECK(!w.due(63000));
  for (uint32_t now = 61000; now < 1000 + 16 * 60000u; now += 1000) {
    bool said = w.ended(now);
    CHECK(!said);
    if (said) break;
  }
}

// millis() wraps to zero every 49.7 days, and a window can straddle the wrap.
static void live_millis_wrap() {
  const uint32_t t0 = 0xFFFFFFFFu - 4999u;   // 5 s before the wrap

  cad::LiveWindow w;
  w.start(t0, 2, 1);
  uint32_t readings = 0, endings = 0, endedAfter = 0;
  for (uint32_t step = 0; step < 70000; step++) {
    uint32_t now = t0 + step;
    if (w.due(now)) readings++;
    if (w.ended(now)) { endings++; endedAfter = step; }
  }
  CHECK(readings == 30);              // 0, 2, ... 58 s: none lost at the wrap
  CHECK(endings == 1);
  CHECK(endedAfter == 60000);         // a minute, not at the wrap

  cad::LiveWindow b;
  b.start(t0, 2, 1);
  CHECK(b.open(t0 + 5000));           // millis() is 0 here
  CHECK(b.open(t0 + 59999));
  CHECK(!b.open(t0 + 60000));
  // Not asked for 25 days, past half the wrap: long over, not "just begun".
  CHECK(!b.open(t0 + 0x80000005u));
}

// A million boards lose AWS at second 0; AWS is back at second `outage`. From
// then on the account accepts `quota` connects a second (the default connect
// quota is 3,000) and refuses the rest, which count as failures. Each board
// retries on `policy`. Reports the busiest second once the first minute is
// over (in the first, every board tries at once whatever the policy), and when
// the last board is back.
struct StormResult { uint64_t attempts; uint32_t peakPerSecond; uint32_t allBackAt; };

template <typename NextWait>
static StormResult storm(uint32_t boards, uint32_t outage, uint32_t quota, NextWait policy) {
  const uint32_t horizon = 4 * 3600;
  std::vector<std::vector<uint32_t>> due(horizon + 1);
  std::vector<cad::Backoff> backoff(boards, cad::Backoff(1000, 300000, 1000));
  for (uint32_t b = 0; b < boards; b++) due[0].push_back(b);   // everyone notices at once
  StormResult r = {0, 0, 0};
  uint32_t connected = 0;
  for (uint32_t second = 0; second <= horizon && connected < boards; second++) {
    std::vector<uint32_t> now;
    now.swap(due[second]);
    if (second >= 60 && now.size() > r.peakPerSecond) r.peakPerSecond = (uint32_t)now.size();
    r.attempts += now.size();
    uint32_t accepted = 0;
    for (uint32_t b : now) {
      if (second >= outage && accepted < quota) { accepted++; connected++; r.allBackAt = second; continue; }
      uint32_t waitMs = policy(backoff[b]);
      uint32_t at = second + (waitMs + 999) / 1000;
      due[at > horizon ? horizon : at].push_back(b);
    }
  }
  if (connected < boards) r.allBackAt = UINT32_MAX;
  return r;
}

static void fleet_reconnect_storm() {
  const uint32_t boards = 1000000, outage = 600, quota = 3000;

  StormResult fixed = storm(boards, outage, quota, [](cad::Backoff&) { return 1000u; });
  StormResult jitter = storm(boards, outage, quota, [](cad::Backoff& b) { return b.fail(next_random()); });

  std::printf("fleet storm, %u boards, %u s outage, %u connects/s quota\n", boards, outage, quota);
  std::printf("  retry every 1 s (2.0.x):  busiest second after the first minute %u attempts, %llu attempts in all, all back %u s after AWS\n",
              fixed.peakPerSecond, (unsigned long long)fixed.attempts, fixed.allBackAt - outage);
  std::printf("  backoff + full jitter:    busiest second after the first minute %u attempts, %llu attempts in all, all back %u s after AWS\n",
              jitter.peakPerSecond, (unsigned long long)jitter.attempts, jitter.allBackAt - outage);

  CHECK(jitter.allBackAt != UINT32_MAX);
  // Backoff is not allowed to cost much recovery time: the quota alone needs
  // boards / quota = 334 s, and the longest wait is 300 s.
  CHECK(jitter.allBackAt - outage <= boards / quota + 300 + 60);
  // ...and it must take the load off AWS: after the first minute, a few
  // times the quota at most, where retrying every second keeps up a million
  // attempts a second for the whole outage.
  CHECK(jitter.peakPerSecond < 10 * quota);
  CHECK(jitter.attempts * 20 < fixed.attempts);
}

int main() {
  millis_wrap();
  between_bounds();
  backoff_doubles_to_the_cap();
  telemetry_bounds();
  live_bounds();
  live_first_reading_at_once();
  live_window_runs_out();
  live_second_command_extends();
  live_zero_minutes();
  live_millis_wrap();
  fleet_reconnect_storm();
  if (failures) { std::printf("%d check(s) failed\n", failures); return 1; }
  std::printf("all device timing checks passed\n");
  return 0;
}
