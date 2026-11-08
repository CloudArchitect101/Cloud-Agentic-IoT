#pragma once
/**
 * ServoSweep - where the patient monitor's servo should be while it
 * turns: a sweep from 0 to 180 degrees and back, over and over. One full
 * sweep takes SWEEP_PERIOD_MS while a patient board's room is at 30 C or
 * more (ServoDemand.h); the queue's depth (QUEUE_DEPTH, ServoDemand.h) can make it
 * faster or slower with setPeriod, and the arm carries on from where it is.
 *
 * The angle comes from the clock, not from counting steps, so a pass of
 * loop() that took long (a reading, a reconnect, a dose) does not slow the
 * sweep down: the arm goes on where it should be by now. Nothing here waits,
 * so the MQTT loop never stalls.
 *
 * Plain C++ like the library's DeviceCommands.h, so test/firmware compiles
 * and checks it on any machine with a C++ compiler.
 */

#include <stdint.h>

namespace pm {

// One full sweep, 0 to 180 degrees and back to 0.
const uint32_t SWEEP_PERIOD_MS = 2000;
const int SWEEP_MAX_ANGLE = 180;

class ServoSweep {
 public:
  ServoSweep() : _active(false), _start(0), _period(SWEEP_PERIOD_MS), _written(-1) {}

  bool active() const { return _active; }
  uint32_t period() const { return _period; }

  /** One full sweep takes `period` ms from `now` on. The arm stays where it
   *  is and keeps its direction: only its speed changes. */
  void setPeriod(uint32_t period, uint32_t now) {
    period &= ~1u;   // even, so the way up and the way down take as long
    if (period < 2) period = 2;
    if (period == _period) return;
    uint32_t elapsed = (now - _start) % _period;
    uint32_t scaled = (uint32_t)((uint64_t)elapsed * period / _period);
    _period = period;
    _start = now - scaled;
  }

  /** Turns the sweep on or off at `now`. False when it already was: a
   *  repeated "on" leaves a sweep that is running alone. */
  bool set(bool on, uint32_t now) {
    if (on == _active) return false;
    _active = on;
    restart(now);
    return true;
  }

  /** Starts the sweep again from 0 at `now`, where a dose leaves the arm. */
  void restart(uint32_t now) {
    _start = now;
    _written = -1;
  }

  /** The angle for `now`, 0 to 180. */
  int angleAt(uint32_t now) {
    // Unsigned: right across millis() wrapping at 2^32. The start moves on by
    // whole sweeps, so the time since it never grows large.
    uint32_t elapsed = now - _start;
    if (elapsed >= _period) {
      _start += elapsed - elapsed % _period;
      elapsed %= _period;
    }
    const uint32_t half = _period / 2;
    uint32_t out = elapsed < half ? elapsed : _period - elapsed;   // 0 .. half
    return (int)(((uint64_t)out * SWEEP_MAX_ANGLE + half / 2) / half);
  }

  /** The angle to write to the servo at `now`, or -1 when there is nothing
   *  to write: the sweep is off, or the arm is already at that angle. */
  int next(uint32_t now) {
    if (!_active) return -1;
    int angle = angleAt(now);
    if (angle == _written) return -1;
    _written = angle;
    return angle;
  }

 private:
  bool _active;
  uint32_t _start;
  uint32_t _period;
  int _written;
};

}  // namespace pm
