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
  fleet_reconnect_storm();
  if (failures) { std::printf("%d check(s) failed\n", failures); return 1; }
  std::printf("all device timing checks passed\n");
  return 0;
}
