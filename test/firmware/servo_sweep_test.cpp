// Host-side checks of firmware/patient-monitor/ServoSweep.h, compiled and
// run by case-alert-sweep.test.js. No Arduino needed: the header is plain C++
// on purpose.
//
// The sweep is what the patient monitor's servo does while its room is hot or a Case waits for
// the care team: 0 to 180 degrees and back every SWEEP_PERIOD_MS, worked out
// from the clock, so nothing waits and a slow pass of loop() does not slow it.

#include <cstdio>
#include <cstdint>
#include <cstdlib>

#include "../../firmware/patient-monitor/ServoSweep.h"

static int failures = 0;
#define CHECK(cond) do { if (!(cond)) { std::printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond); failures++; } } while (0)

using pm::ServoSweep;
using pm::SWEEP_PERIOD_MS;

static void off_until_turned_on() {
  ServoSweep sweep;
  CHECK(!sweep.active());
  for (uint32_t now = 0; now < 5000; now += 7) CHECK(sweep.next(now) == -1);   // nothing to write
}

static void one_sweep_is_0_to_180_and_back() {
  ServoSweep sweep;
  CHECK(sweep.set(true, 1000));
  CHECK(sweep.angleAt(1000) == 0);
  CHECK(sweep.angleAt(1000 + SWEEP_PERIOD_MS / 4) == 90);
  CHECK(sweep.angleAt(1000 + SWEEP_PERIOD_MS / 2) == 180);
  CHECK(sweep.angleAt(1000 + 3 * SWEEP_PERIOD_MS / 4) == 90);
  CHECK(sweep.angleAt(1000 + SWEEP_PERIOD_MS) == 0);
  CHECK(sweep.angleAt(1000 + 7 * SWEEP_PERIOD_MS + SWEEP_PERIOD_MS / 2) == 180);   // and on, without end

  // Never out of range, and a step of 1 ms never moves the arm more than a degree.
  ServoSweep fresh;
  fresh.set(true, 0);
  int previous = fresh.angleAt(0);
  for (uint32_t now = 1; now < 3 * SWEEP_PERIOD_MS; now++) {
    int angle = fresh.angleAt(now);
    CHECK(angle >= 0 && angle <= 180);
    CHECK(std::abs(angle - previous) <= 1);
    previous = angle;
  }
}

static void writes_only_a_new_angle() {
  ServoSweep sweep;
  sweep.set(true, 0);
  CHECK(sweep.next(0) == 0);
  CHECK(sweep.next(1) == -1);   // still 0 degrees: nothing to write
  int writes = 0;
  for (uint32_t now = 0; now < SWEEP_PERIOD_MS; now++) {
    if (sweep.next(now) >= 0) writes++;
  }
  CHECK(writes == 360);   // one write per degree, up and down
}

static void a_slow_pass_does_not_slow_the_sweep() {
  ServoSweep sweep;
  sweep.set(true, 0);
  CHECK(sweep.next(10) >= 0);
  // A dose, a reading or a reconnect held loop() for 1.5 s: the arm goes
  // where it should be by now, not on from where it was.
  CHECK(sweep.next(10 + 1500) == sweep.angleAt(10 + 1500));
  CHECK(sweep.angleAt(1500) == 90);
}

static void a_repeat_changes_nothing() {
  ServoSweep sweep;
  CHECK(sweep.set(true, 0));
  int at = sweep.angleAt(700);
  CHECK(!sweep.set(true, 600));   // on again while already on
  CHECK(sweep.angleAt(700) == at);   // the sweep runs on, it does not jump back to 0
  CHECK(sweep.set(false, 800));   // off
  CHECK(!sweep.active());
  CHECK(!sweep.set(false, 900));
  CHECK(sweep.next(1000) == -1);
}

static void a_dose_starts_the_sweep_again_from_0() {
  ServoSweep sweep;
  sweep.set(true, 0);
  sweep.next(500);   // somewhere up the sweep
  sweep.restart(5000);   // the dose left the arm at 0
  CHECK(sweep.next(5000) == 0);
  CHECK(sweep.angleAt(5000 + SWEEP_PERIOD_MS / 2) == 180);
}

static void millis_wrapping_changes_nothing() {
  // millis() wraps to 0 after about 49.7 days, and the motor may be turning then.
  const uint32_t start = 0xFFFFFFFFu - 300;
  ServoSweep sweep;
  sweep.set(true, start);
  CHECK(sweep.angleAt(start + SWEEP_PERIOD_MS / 4) == 90);   // the clock only goes forward
  int previous = sweep.angleAt(start + SWEEP_PERIOD_MS / 4);
  for (uint32_t step = SWEEP_PERIOD_MS / 4 + 1; step < 3 * SWEEP_PERIOD_MS; step++) {
    uint32_t now = start + step;   // wraps past 0 on the way
    int angle = sweep.angleAt(now);
    CHECK(std::abs(angle - previous) <= 1);
    previous = angle;
  }
  CHECK(sweep.angleAt(start + 3 * SWEEP_PERIOD_MS + SWEEP_PERIOD_MS / 2) == 180);

  // And after days of turning, it is still on the same beat.
  ServoSweep longRunning;
  longRunning.set(true, 0);
  for (uint32_t now = 0; now < 0xF0000000u; now += 997u * 1000) longRunning.angleAt(now);
  CHECK(longRunning.angleAt(0xF0000000u - 0xF0000000u % SWEEP_PERIOD_MS + SWEEP_PERIOD_MS / 2) == 180);
}

static void a_new_period_changes_the_speed_not_the_place() {
  // QUEUE_DEPTH can speed the sweep up or slow it down while it runs.
  ServoSweep sweep;
  sweep.set(true, 0);
  int at = sweep.angleAt(500);   // 90 degrees, on the way up
  CHECK(at == 90);
  sweep.setPeriod(8000, 500);
  CHECK(sweep.period() == 8000);
  CHECK(sweep.angleAt(500) == 90);   // where it was
  CHECK(sweep.angleAt(500 + 2000) == 180);   // and on up, at the new speed: a quarter of 8 s to the top
  CHECK(sweep.angleAt(500 + 6000) == 0);

  // On the way down it keeps going down.
  ServoSweep down;
  down.set(true, 0);
  CHECK(down.angleAt(1500) == 90);   // 3/4 of the 2 s sweep: on the way back
  down.setPeriod(1000, 1500);
  CHECK(down.angleAt(1500) == 90);
  CHECK(down.angleAt(1500 + 125) < 90);   // still going down, faster

  // The same period, or an odd one, changes nothing it should not.
  ServoSweep same;
  same.set(true, 0);
  same.setPeriod(SWEEP_PERIOD_MS, 700);
  CHECK(same.angleAt(700) == 126);
  same.setPeriod(7201, 700);
  CHECK(same.period() == 7200);   // even: up and down take as long
  int previous = same.angleAt(700);
  for (uint32_t now = 701; now < 700 + 3 * 7200; now++) {
    int angle = same.angleAt(now);
    CHECK(angle >= 0 && angle <= 180);
    CHECK(std::abs(angle - previous) <= 1);
    previous = angle;
  }
}

int main() {
  off_until_turned_on();
  one_sweep_is_0_to_180_and_back();
  writes_only_a_new_angle();
  a_slow_pass_does_not_slow_the_sweep();
  a_repeat_changes_nothing();
  a_dose_starts_the_sweep_again_from_0();
  millis_wrapping_changes_nothing();
  a_new_period_changes_the_speed_not_the_place();
  if (failures) {
    std::printf("%d check(s) failed\n", failures);
    return 1;
  }
  std::printf("case alert sweep: all checks passed\n");
  return 0;
}
