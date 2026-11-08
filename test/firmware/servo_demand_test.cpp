// Host-side checks of firmware/patient-monitor/ServoDemand.h and
// SensorPresence.h, compiled and run by servo-demand.test.js. No Arduino
// needed: the headers are plain C++ on purpose.
//
// ServoDemand is why the one firmware every board runs turns its servo: a
// patient device's own Case (CASE_ALERT), the whole queue on an internal
// board (QUEUE_DEPTH), or both. SensorPresence keeps a board without a DHT11
// quiet.

#include <cstdio>
#include <cstdint>

#include "../../firmware/patient-monitor/ServoDemand.h"
#include "../../firmware/patient-monitor/SensorPresence.h"

static int failures = 0;
#define CHECK(cond) do { if (!(cond)) { std::printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond); failures++; } } while (0)

using pm::ServoDemand;
using pm::SensorPresence;

static void still_until_asked() {
  ServoDemand demand;
  CHECK(!demand.active());
  CHECK(demand.sweepPeriodMs() == 0);
  CHECK(demand.continuousWrite() == pm::CONTINUOUS_STOP);
}

static void a_case_alert_alone_sweeps_as_before() {
  ServoDemand demand;
  CHECK(demand.setCaseAlert(true));
  CHECK(!demand.setCaseAlert(true));   // a repeat
  CHECK(demand.active());
  CHECK(demand.sweepPeriodMs() == pm::SWEEP_PERIOD_MS);
  CHECK(demand.continuousWrite() == pm::CONTINUOUS_CASE_ALERT);
  CHECK(demand.setCaseAlert(false));
  CHECK(!demand.active());
}

static void the_queue_alone_turns_faster_as_it_fills() {
  ServoDemand demand;
  CHECK(demand.setQueue(20, 1));   // 1 Case of a full-speed depth of 5
  CHECK(demand.active());
  CHECK(demand.openCases() == 1);
  CHECK(demand.sweepPeriodMs() == 7200);
  CHECK(!demand.setQueue(20, 1));   // the same again: nothing to do
  CHECK(demand.setQueue(100, 5));
  CHECK(demand.sweepPeriodMs() == 1080);
  CHECK(demand.continuousWrite() == 180);
  CHECK(pm::queueSweepPeriodMs(1) == 8640);   // the slowest
  uint32_t previous = pm::queueSweepPeriodMs(1);
  for (int intensity = 2; intensity <= 100; intensity++) {
    uint32_t period = pm::queueSweepPeriodMs(intensity);
    CHECK(period <= previous);   // never slower for more Cases
    CHECK(period % 2 == 0);
    previous = period;
  }
  CHECK(demand.setQueue(0, 0));   // the queue is empty
  CHECK(!demand.active());
  CHECK(demand.continuousWrite() == pm::CONTINUOUS_STOP);
}

static void out_of_range_is_kept_in_range() {
  ServoDemand demand;
  demand.setQueue(250, -3);
  CHECK(demand.queueIntensity() == 100);
  CHECK(demand.openCases() == 0);
  demand.setQueue(-5, 2);
  CHECK(demand.queueIntensity() == 0);
  CHECK(!demand.active());
  CHECK(pm::queueSweepPeriodMs(-1) == 0);
  CHECK(pm::queueSweepPeriodMs(1000) == 1080);
}

static void either_turns_it_and_the_faster_wins() {
  ServoDemand demand;
  demand.setCaseAlert(true);
  demand.setQueue(20, 1);   // slower than the case alert
  CHECK(demand.sweepPeriodMs() == pm::SWEEP_PERIOD_MS);
  CHECK(demand.continuousWrite() == pm::CONTINUOUS_CASE_ALERT);
  demand.setQueue(100, 9);   // faster
  CHECK(demand.sweepPeriodMs() == 1080);
  CHECK(demand.continuousWrite() == 180);
  demand.setQueue(0, 0);   // the queue empties: the case alert still turns it
  CHECK(demand.active());
  CHECK(demand.sweepPeriodMs() == pm::SWEEP_PERIOD_MS);
  demand.setQueue(40, 2);
  demand.setCaseAlert(false);   // the Case is closed: the queue still turns it
  CHECK(demand.active());
  CHECK(demand.sweepPeriodMs() == pm::queueSweepPeriodMs(40));
}

static void a_board_without_a_sensor_says_so_once() {
  SensorPresence sensor;
  CHECK(sensor.report(false) == SensorPresence::FAILED);
  CHECK(sensor.report(false) == SensorPresence::FAILED);
  CHECK(sensor.report(false) == SensorPresence::NONE);   // never read anything
  CHECK(sensor.missing());
  for (int i = 0; i < 10000; i++) CHECK(sensor.report(false) == SensorPresence::QUIET);   // a day of readings, silent
  CHECK(sensor.report(true) == SensorPresence::BACK);   // plugged in
  CHECK(!sensor.missing());
  CHECK(sensor.report(true) == SensorPresence::QUIET);
}

static void a_sensor_that_stops_is_reported_then_quiet() {
  SensorPresence sensor;
  CHECK(sensor.report(true) == SensorPresence::QUIET);
  CHECK(sensor.report(false) == SensorPresence::FAILED);   // one bad read happens
  CHECK(sensor.report(true) == SensorPresence::QUIET);   // and is forgotten
  CHECK(sensor.report(false) == SensorPresence::FAILED);
  CHECK(sensor.report(false) == SensorPresence::FAILED);
  CHECK(sensor.report(false) == SensorPresence::STOPPED);
  CHECK(sensor.missing());
  CHECK(sensor.everRead());
  CHECK(sensor.report(false) == SensorPresence::QUIET);
}

int main() {
  still_until_asked();
  a_case_alert_alone_sweeps_as_before();
  the_queue_alone_turns_faster_as_it_fills();
  out_of_range_is_kept_in_range();
  either_turns_it_and_the_faster_wins();
  a_board_without_a_sensor_says_so_once();
  a_sensor_that_stops_is_reported_then_quiet();
  if (failures) {
    std::printf("%d check(s) failed\n", failures);
    return 1;
  }
  std::printf("servo demand and sensor presence: all checks passed\n");
  return 0;
}
