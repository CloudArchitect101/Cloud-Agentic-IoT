#pragma once
/**
 * ServoDemand - why the board's servo turns, and how fast.
 *
 * Every board runs this one firmware, and Salesforce decides what it is
 * told (DeviceRoles in Salesforce):
 *
 *   - High temperature: a monitored board's own DHT11 reads ROOM_HOT_C
 *     (30 C) or more, wherever it sits (on a patient, in a fridge, in a
 *     room). ROOM_HOT_C keeps its first name for now.
 *     The board decides this itself, from every reading, with no Case and
 *     no cloud round trip, so it works while offline too. The positional
 *     servo sweeps once every SWEEP_PERIOD_MS (2 s) until a reading is
 *     below 30 C again.
 *   - QUEUE_DEPTH: an internal board (a nurse-station indicator) follows the
 *     whole queue. intensity 0-100 comes from the number of open Cases; 0
 *     stops it. The faster the queue fills, the faster the sweep, from about
 *     7 s a sweep at 1 Case of 5 to about 1 s at full speed.
 *
 * A board that has been sent QUEUE_DEPTH is an internal board, and from then
 * on its own DHT11 no longer turns the servo: only the queue does.
 * Salesforce sends the queue's depth to internal boards only, every time one
 * connects, so after a restart an internal board with a warm sensor may turn
 * for the few seconds until that first message arrives. A monitored board is
 * never sent QUEUE_DEPTH, so its sensor keeps turning it. Moving a board
 * between the two roles in Salesforce takes effect at its next restart.
 * The servo turns while either asks for it, at the faster of the two, and
 * stops only when neither does. A continuous-rotation servo spins instead,
 * at the larger of the two speeds.
 *
 * Plain C++ like ServoSweep.h, so test/firmware compiles and checks it on
 * any machine with a C++ compiler.
 */

#include <stdint.h>
#include "ServoSweep.h"

namespace pm {

// A continuous-rotation servo stands still at 90 and turns faster the
// further the value is from it.
const int CONTINUOUS_STOP = 90;
const int CONTINUOUS_ROOM_HOT = 135;   // about half speed

// The temperature is high at this many degrees or more, and normal again below it.
const float ROOM_HOT_C = 30.0f;

/** Whether a reading in degrees C is hot: at ROOM_HOT_C or more. */
inline bool roomIsHot(float celsius) { return celsius >= ROOM_HOT_C; }

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
  ServoDemand() : _roomHot(false), _internal(false), _queueIntensity(0), _openCases(0) {}

  bool roomHot() const { return _roomHot; }
  int queueIntensity() const { return _queueIntensity; }
  int openCases() const { return _openCases; }
  /** True once QUEUE_DEPTH has arrived: an internal board ignores its own sensor. */
  bool internal() const { return _internal; }

  /** False when it already was: nothing to change. Always off on an internal board. */
  bool setRoomHot(bool on) {
    if (_internal) on = false;
    if (on == _roomHot) return false;
    _roomHot = on;
    return true;
  }

  /** False when nothing changed. */
  bool setQueue(long intensity, long openCases) {
    int clamped = clampIntensity(intensity);
    int cases = openCases < 0 ? 0 : (openCases > 100000 ? 100000 : (int)openCases);
    // The first QUEUE_DEPTH makes this an internal board: its own reading stops counting.
    bool wasHot = _roomHot;
    _internal = true;
    _roomHot = false;
    if (clamped == _queueIntensity && cases == _openCases) return wasHot;
    _queueIntensity = clamped;
    _openCases = cases;
    return true;
  }

  /** Whether the servo should turn at all. */
  bool active() const { return _roomHot || _queueIntensity > 0; }

  /** One full sweep, at the faster of what is asked; 0 when nothing is. */
  uint32_t sweepPeriodMs() const {
    uint32_t period = 0;
    if (_roomHot) period = SWEEP_PERIOD_MS;
    uint32_t queue = queueSweepPeriodMs(_queueIntensity);
    if (queue && (!period || queue < period)) period = queue;
    return period;
  }

  /** What to write to a continuous-rotation servo: 90 stands still. */
  int continuousWrite() const {
    int speed = 0;
    if (_roomHot) speed = CONTINUOUS_ROOM_HOT - CONTINUOUS_STOP;
    int queue = _queueIntensity * 90 / 100;
    if (queue > speed) speed = queue;
    return CONTINUOUS_STOP + speed;
  }

 private:
  bool _roomHot;
  bool _internal;
  int _queueIntensity;
  int _openCases;
};

}  // namespace pm
