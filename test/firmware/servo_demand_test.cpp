// Host-side checks of firmware/patient-monitor/ServoDemand.h and
// SensorPresence.h, compiled and run by servo-demand.test.js. No Arduino
// needed: the headers are plain C++ on purpose.
//
// ServoDemand is why the one firmware every board runs turns its servo: a
// monitored board's own sensor at 30 C or more, or the whole queue on an
// internal board (QUEUE_DEPTH), which then ignores its own sensor. SensorPresence keeps a board without a DHT11
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

static void a_hot_room_alone_sweeps() {
  ServoDemand demand;
  CHECK(demand.setRoomHot(true));
  CHECK(!demand.setRoomHot(true));   // a repeat
  CHECK(demand.active());
  CHECK(demand.sweepPeriodMs() == pm::SWEEP_PERIOD_MS);
  CHECK(demand.continuousWrite() == pm::CONTINUOUS_ROOM_HOT);
  CHECK(demand.setRoomHot(false));
  CHECK(!demand.active());
}

static void hot_means_30_or_more() {
  CHECK(pm::roomIsHot(30.0f));
  CHECK(pm::roomIsHot(31.0f));
  CHECK(!pm::roomIsHot(29.9f));
  CHECK(!pm::roomIsHot(29.0f));
  CHECK(!pm::roomIsHot(-5.0f));
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

static void an_internal_board_ignores_its_own_sensor() {
  ServoDemand demand;
  demand.setRoomHot(true);   // warm before the first QUEUE_DEPTH arrives
  CHECK(demand.active());
  CHECK(!demand.internal());
  CHECK(demand.setQueue(0, 0));   // the empty queue arrives: now an internal board, and it stops
  CHECK(demand.internal());
  CHECK(!demand.roomHot());
  CHECK(!demand.active());
  CHECK(!demand.setRoomHot(true));   // its own 30 C or more changes nothing
  CHECK(!demand.active());
  CHECK(demand.continuousWrite() == pm::CONTINUOUS_STOP);
  demand.setQueue(100, 9);   // only the queue turns it
  CHECK(demand.sweepPeriodMs() == 1080);
  CHECK(demand.continuousWrite() == 180);
  demand.setQueue(40, 2);
  CHECK(demand.sweepPeriodMs() == pm::queueSweepPeriodMs(40));
  demand.setQueue(0, 0);
  CHECK(!demand.active());
}

static void a_monitored_board_is_never_internal() {
  ServoDemand demand;   // never sent QUEUE_DEPTH
  for (int i = 0; i < 100; i++) {
    demand.setRoomHot(i % 2 == 0);
    CHECK(demand.active() == (i % 2 == 0));
  }
  CHECK(!demand.internal());
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
  a_hot_room_alone_sweeps();
  hot_means_30_or_more();
  the_queue_alone_turns_faster_as_it_fills();
  out_of_range_is_kept_in_range();
  an_internal_board_ignores_its_own_sensor();
  a_monitored_board_is_never_internal();
  a_board_without_a_sensor_says_so_once();
  a_sensor_that_stops_is_reported_then_quiet();
  if (failures) {
    std::printf("%d check(s) failed\n", failures);
    return 1;
  }
  std::printf("servo demand and sensor presence: all checks passed\n");
  return 0;
}
