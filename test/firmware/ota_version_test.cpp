// Host-side checks of firmware/libraries/CloudAgenticDevice/src/OtaVersion.h,
// compiled and run by ota-version.test.js: when a board skips a stale OTA
// release instead of going back to it.

#include <cstdio>

#include "../../firmware/libraries/CloudAgenticDevice/src/OtaVersion.h"

static int failures = 0;
#define CHECK(cond) do { if (!(cond)) { std::printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond); failures++; } } while (0)

static void an_older_release_is_skipped() {
  CHECK(cad::isOlderRelease("2.7.0", "2.8.0"));
  CHECK(cad::isOlderRelease("2.8.9", "2.9.0"));
  CHECK(cad::isOlderRelease("1.99.99", "2.0.0"));
  // Compared as numbers, not text: "2.10.0" sorts before "2.9.0" as text.
  CHECK(cad::isOlderRelease("2.9.0", "2.10.0"));
  CHECK(!cad::isOlderRelease("2.10.0", "2.9.0"));
  // Older than a try the board runs, by its number.
  CHECK(cad::isOlderRelease("2.7.0", "2.8.0-try.3"));
}

static void a_newer_or_equal_release_installs() {
  CHECK(!cad::isOlderRelease("2.8.0", "2.7.0"));
  CHECK(!cad::isOlderRelease("3.0.0", "2.99.99"));
  CHECK(!cad::isOlderRelease("2.8.0", "2.8.0"));
  // The release of the number a try carried replaces the try.
  CHECK(!cad::isOlderRelease("2.8.0", "2.8.0-try.3"));
}

static void a_try_always_installs() {
  CHECK(!cad::isOlderRelease("2.7.0-try.1", "2.8.0"));
  CHECK(!cad::isOlderRelease("2.8.0-try.1", "2.8.0"));
  CHECK(!cad::isOlderRelease("2.8.0-try.1", "2.8.0-try.2"));
}

static void anything_unreadable_is_never_older() {
  // The board then does what it always did, so a new version format cannot
  // strand a fleet on its current build.
  const char* bad[] = {"", "2", "2.7", "2.7.0.1", "v2.7.0", "2.7.x", " 2.7.0", "2.7.0 ", "-2.7.0",
                       "+2.7.0", "2..0", "2.7.0-", "1234567890.0.0", nullptr};
  for (const char** v = bad; *v; v++) {
    CHECK(!cad::isOlderRelease(*v, "9.9.9"));
    CHECK(!cad::isOlderRelease("0.0.1", *v));
  }
  CHECK(!cad::isOlderRelease(nullptr, "2.8.0"));
  CHECK(!cad::isOlderRelease("2.7.0", nullptr));
}

static void parses_the_parts() {
  uint32_t core[3];
  bool pre = true;
  CHECK(cad::parseVersion("12.0.345", core, &pre) && core[0] == 12 && core[1] == 0 && core[2] == 345 && !pre);
  CHECK(cad::parseVersion("2.8.0-try.11", core, &pre) && core[0] == 2 && core[1] == 8 && core[2] == 0 && pre);
  CHECK(cad::parseVersion("999999999.0.0", core, &pre) && core[0] == 999999999u);
}

int main() {
  an_older_release_is_skipped();
  a_newer_or_equal_release_installs();
  a_try_always_installs();
  anything_unreadable_is_never_older();
  parses_the_parts();
  std::printf("%s: %d failure(s)\n", failures ? "FAILED" : "ok", failures);
  return failures ? 1 : 0;
}
