#pragma once
/**
 * SensorPresence - whether the DHT11 is there, so a board without one stays
 * quiet.
 *
 * Every board runs this firmware, and an internal board (a nurse-station
 * indicator) has no sensor at all. Each failed read used to print
 * "DHT read failed" every reading interval, forever. Now:
 *
 *   - A failed read prints "DHT read failed", as before, until MISSING_AFTER
 *     reads in a row have failed. Then the sensor counts as missing: one line
 *     says so, and further failures print nothing.
 *   - A board that has never read anything says "no sensor" rather than
 *     "stopped answering", which is the normal state of an internal board.
 *   - A read that works again after that says the sensor is back, once.
 *
 * A failed read never publishes a reading, so nothing in AWS or Salesforce
 * reacts to a board without a sensor: no Patient Vitals, no room rule.
 *
 * Plain C++, checked on the host by test/firmware.
 */

#include <stdint.h>

namespace pm {

const int MISSING_AFTER = 3;

class SensorPresence {
 public:
  enum Event {
    QUIET,     // nothing to print
    FAILED,    // print "DHT read failed"
    NONE,      // never read anything: no sensor on this board
    STOPPED,   // it read before, and has stopped answering
    BACK       // it answers again
  };

  SensorPresence() : _misses(0), _everRead(false), _missing(false) {}

  bool missing() const { return _missing; }
  bool everRead() const { return _everRead; }

  /** One read, and what the console should say about it. */
  Event report(bool ok) {
    if (ok) {
      bool wasMissing = _missing;
      _misses = 0;
      _missing = false;
      _everRead = true;
      return wasMissing ? BACK : QUIET;
    }
    if (_missing) return QUIET;
    if (_misses < MISSING_AFTER) _misses++;
    if (_misses < MISSING_AFTER) return FAILED;
    _missing = true;
    return _everRead ? STOPPED : NONE;
  }

 private:
  int _misses;
  bool _everRead;
  bool _missing;
};

}  // namespace pm
