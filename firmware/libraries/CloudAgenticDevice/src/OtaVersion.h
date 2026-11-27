#pragma once
/**
 * OtaVersion - whether an OTA job would take a board back to an older build.
 *
 * AWS IoT hands a board its pending jobs oldest first. A board that was
 * offline while two releases went out (2.7.0, then 2.8.0) would otherwise
 * install 2.7.0 and then 2.8.0, or, once it runs 2.8.0, get a stale 2.7.0 job
 * and go back. The pipeline cancels a release's older unstarted jobs
 * (scripts/ota.sh), and this is the board's own guard for what that cannot
 * reach: a job a board had already started, a job created by older tooling,
 * a cancel call that failed.
 *
 * Only a plain release (MAJOR.MINOR.PATCH) is ever skipped. A try
 * (<version>-try.<n>, scripts/ota.sh try) is a person's deliberate test on a
 * Dev board, so it always installs. A release of the same number as the try a
 * board runs installs too: 2.8.0-try.3 is older than 2.8.0.
 *
 * Plain C++, no Arduino, so test/firmware checks it on any machine.
 */

#include <stdint.h>

namespace cad {

// Reads "MAJOR.MINOR.PATCH" and an optional "-anything" after it. Digits only,
// at most 9 per part: no sign, no space, nothing a strtoul would let through.
inline bool parseVersion(const char* text, uint32_t core[3], bool* prerelease) {
  if (!text) return false;
  const char* p = text;
  for (int part = 0; part < 3; part++) {
    if (*p < '0' || *p > '9') return false;
    uint32_t value = 0;
    int digits = 0;
    while (*p >= '0' && *p <= '9') {
      if (++digits > 9) return false;
      value = value * 10 + (uint32_t)(*p - '0');
      p++;
    }
    core[part] = value;
    if (part < 2) {
      if (*p != '.') return false;
      p++;
    }
  }
  if (*p == '\0') { *prerelease = false; return true; }
  if (*p == '-' && p[1] != '\0') { *prerelease = true; return true; }
  return false;
}

// True when jobVersion is a plain release older than the build this board
// runs. Anything it cannot read is not "older": the board then does what it
// always did, so a new version format can never strand a fleet.
inline bool isOlderRelease(const char* jobVersion, const char* runningVersion) {
  uint32_t job[3], running[3];
  bool jobPre = false, runningPre = false;
  if (!parseVersion(jobVersion, job, &jobPre) || !parseVersion(runningVersion, running, &runningPre)) return false;
  if (jobPre) return false;
  for (int i = 0; i < 3; i++) {
    if (job[i] != running[i]) return job[i] < running[i];
  }
  return false;   // the same number: a release is never older than itself or its own try
}

}  // namespace cad
