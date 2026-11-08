#pragma once
/**
 * ServoDemand - why the patient monitor's servo turns, and how fast.
 *
 * Every board runs this one firmware, and Salesforce decides what it is
 * told (DeviceRoles in Salesforce):
 *
 *   - CASE_ALERT: a patient device's own Case waits in the care team queue.
 *     The positional servo sweeps once every SWEEP_PERIOD_MS (2 s).
 *   - QUEUE_DEPTH: an internal board (a nurse-station indicator) follows the
 *     whole queue. intensity 0-100 comes from the number of open Cases; 0
 *     stops it. The faster the queue fills, the faster the sweep, from about
 *     7 s a sweep at 1 Case of 5 to about 1 s at full speed, as on the retired
 *     queue-indicator firmware.
 *
 * The servo turns while either asks for it, at the faster of the two, and
 * stops only when neither does. A continuous-rotation servo spins instead,
 * at the larger of the two speeds.
 *
 * Plain C++ like CaseAlertSweep.h, so test/firmware compiles and checks it on
 * any machine with a C++ compiler.
 */

#include <stdint.h>
#include "CaseAlertSweep.h"

namespace pm {

// A continuous-rotation servo stands still at 90 and turns faster the
// further the value is from it.
const int CONTINUOUS_STOP = 90;
const int CONTINUOUS_CASE_ALERT = 135;   // about half speed

/** An intensity from a QUEUE_DEPTH message, kept to 0-100. */
inline int clampIntensity(long value) {
  if (value < 0) return 0;
  if (value > 100) return 100;
  return (int)value;
}

/** One full sweep for a queue intensity of 1-100: 24 ms a degree at the
 *  slowest down to 3 at the fastest, there and back. 0 for an intensity of 0. */
inline uint32_t queueSweepPeriodMs(int intensity) {
  intensity = clampIntensity(intensity);
  if (intensity == 0) return 0;
  const uint32_t slowest = 24, fastest = 3;
  uint32_t msPerDegree = slowest - (slowest - fastest) * (uint32_t)intensity / 100;
  return 2u * (uint32_t)SWEEP_MAX_ANGLE * msPerDegree;
}

class ServoDemand {
 public:
  ServoDemand() : _caseAlert(false), _queueIntensity(0), _openCases(0) {}

  bool caseAlert() const { return _caseAlert; }
  int queueIntensity() const { return _queueIntensity; }
  int openCases() const { return _openCases; }

  /** False when it already was: nothing to change. */
  bool setCaseAlert(bool on) {
    if (on == _caseAlert) return false;
    _caseAlert = on;
    return true;
  }

  /** False when nothing changed. */
  bool setQueue(long intensity, long openCases) {
    int clamped = clampIntensity(intensity);
    int cases = openCases < 0 ? 0 : (openCases > 100000 ? 100000 : (int)openCases);
    if (clamped == _queueIntensity && cases == _openCases) return false;
    _queueIntensity = clamped;
    _openCases = cases;
    return true;
  }

  /** Whether the servo should turn at all. */
  bool active() const { return _caseAlert || _queueIntensity > 0; }

  /** One full sweep, at the faster of what is asked; 0 when nothing is. */
  uint32_t sweepPeriodMs() const {
    uint32_t period = 0;
    if (_caseAlert) period = SWEEP_PERIOD_MS;
    uint32_t queue = queueSweepPeriodMs(_queueIntensity);
    if (queue && (!period || queue < period)) period = queue;
    return period;
  }

  /** What to write to a continuous-rotation servo: 90 stands still. */
  int continuousWrite() const {
    int speed = 0;
    if (_caseAlert) speed = CONTINUOUS_CASE_ALERT - CONTINUOUS_STOP;
    int queue = _queueIntensity * 90 / 100;
    if (queue > speed) speed = queue;
    return CONTINUOUS_STOP + speed;
  }

 private:
  bool _caseAlert;
  int _queueIntensity;
  int _openCases;
};

}  // namespace pm
