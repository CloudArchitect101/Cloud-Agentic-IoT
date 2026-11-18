#pragma once
/**
 * CaseAlertSweep - where the patient monitor's servo should be while a Case
 * waits for the care team (the CASE_ALERT command): a sweep from 0 to 180
 * degrees and back, over and over, one full sweep every SWEEP_PERIOD_MS.
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

class CaseAlertSweep {
 public:
  CaseAlertSweep() : _active(false), _start(0), _written(-1) {}

  bool active() const { return _active; }

  /** Turns the sweep on or off at `now`. False when it already was: a
   *  repeated CASE_ALERT on leaves a sweep that is running alone. */
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
    if (elapsed >= SWEEP_PERIOD_MS) {
      _start += elapsed - elapsed % SWEEP_PERIOD_MS;
      elapsed %= SWEEP_PERIOD_MS;
    }
    const uint32_t half = SWEEP_PERIOD_MS / 2;
    uint32_t out = elapsed < half ? elapsed : SWEEP_PERIOD_MS - elapsed;   // 0 .. half
    return (int)((out * SWEEP_MAX_ANGLE + half / 2) / half);
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
  int _written;
};

}  // namespace pm
