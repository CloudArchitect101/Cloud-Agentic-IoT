// Host-side checks of firmware/libraries/CloudAgenticDevice/src/DeviceCommands.h,
// compiled and run by device-commands.test.js. No Arduino needed: the header is
// plain C++ on purpose.
//
// The last test plays a command that reaches the board twice through the steps
// handleMessage() takes, and counts how often the servo would move.

#include <cctype>
#include <cstdio>
#include <cstdint>
#include <cstring>
#include <string>

#include "../../firmware/libraries/CloudAgenticDevice/src/DeviceCommands.h"

static int failures = 0;
#define CHECK(cond) do { if (!(cond)) { std::printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond); failures++; } } while (0)

using cad::CommandResult;

static void outcome_names() {
  // The answer's outcome, which the device-command-ack Lambda and
  // DeviceCommandAckService read: done, failed or refused, nothing else.
  CHECK(std::strcmp(cad::resultName(CommandResult::Done), "done") == 0);
  CHECK(std::strcmp(cad::resultName(CommandResult::Failed), "failed") == 0);
  CHECK(std::strcmp(cad::resultName(CommandResult::Refused), "refused") == 0);
}

static void command_id_rule() {
  CHECK(cad::validCommandId("a0Bbm00000AbCdEFGH"));    // a Salesforce record Id, 18 characters
  CHECK(cad::validCommandId("a0Bbm00000AbCdE"));       // and its 15-character form
  CHECK(cad::validCommandId("x"));
  CHECK(cad::validCommandId("retry_2-of-3"));
  CHECK(!cad::validCommandId(""));
  CHECK(!cad::validCommandId(nullptr));

  const std::string forty(40, 'a');
  CHECK(cad::validCommandId(forty.c_str()));
  CHECK(!cad::validCommandId((forty + "a").c_str()));
  CHECK(!cad::validCommandId(std::string(1000, 'a').c_str()));

  // Every byte on its own, against the rule as the contract states it:
  // A-Z a-z 0-9 _ - and nothing else. Nothing that means something in an MQTT
  // topic (/ + #) or needs escaping in JSON (" \ and control characters).
  for (int byte = 1; byte < 256; byte++) {
    char id[2] = { (char)byte, '\0' };
    bool expected = (byte < 128 && std::isalnum(byte)) || byte == '_' || byte == '-';
    CHECK(cad::validCommandId(id) == expected);
    if (cad::validCommandId(id) != expected) { std::printf("  byte %d\n", byte); break; }
  }
  CHECK(!cad::validCommandId("a0B/../x"));
  CHECK(!cad::validCommandId("a0B+"));
  CHECK(!cad::validCommandId("a0B bm"));
  CHECK(!cad::validCommandId("a0B\"bm"));
  CHECK(!cad::validCommandId("caf\xc3\xa9"));          // UTF-8
}

static void copy_text() {
  char out[8];
  CHECK(std::strcmp(cad::copyText(out, sizeof out, "LIVE"), "LIVE") == 0);
  CHECK(std::strcmp(cad::copyText(out, sizeof out, "SET_TELEMETRY_INTERVAL"), "SET_TEL") == 0);   // cut to fit
  CHECK(std::strcmp(cad::copyText(out, sizeof out, ""), "") == 0);
  CHECK(std::strcmp(cad::copyText(out, sizeof out, nullptr), "") == 0);
  // What would need escaping in JSON, or is not printable ASCII, becomes '?':
  // the answer stays as long as the buffer allows, and stays readable JSON.
  CHECK(std::strcmp(cad::copyText(out, sizeof out, "a\"b\\c"), "a?b?c") == 0);
  CHECK(std::strcmp(cad::copyText(out, sizeof out, "a\nb\tc\x7f"), "a?b?c?") == 0);
  CHECK(std::strcmp(cad::copyText(out, sizeof out, "caf\xc3\xa9"), "caf??") == 0);
  CHECK(std::strcmp(cad::copyText(out, sizeof out, " ~"), " ~") == 0);

  char one[1];
  CHECK(std::strcmp(cad::copyText(one, sizeof one, "LIVE"), "") == 0);

  // A whole detail's worth, and no more.
  char detail[cad::MAX_DETAIL_LENGTH + 1];
  const std::string longest(500, 'x');
  CHECK(std::strlen(cad::copyText(detail, sizeof detail, longest.c_str())) == cad::MAX_DETAIL_LENGTH);
}

static std::string recordId(int n) {
  char buf[24];
  std::snprintf(buf, sizeof buf, "a0Bbm%08dXYZ", n);
  return buf;
}

static void recent_commands_remember_and_find() {
  cad::RecentCommands recent;
  CommandResult result = CommandResult::Done;
  CHECK(!recent.find(recordId(1).c_str(), result));    // nothing yet
  CHECK(!recent.find("", result));                     // and an empty slot is never a match

  recent.remember(recordId(1).c_str(), CommandResult::Done);
  recent.remember(recordId(2).c_str(), CommandResult::Failed);
  recent.remember(recordId(3).c_str(), CommandResult::Refused);
  CHECK(recent.find(recordId(1).c_str(), result) && result == CommandResult::Done);
  CHECK(recent.find(recordId(2).c_str(), result) && result == CommandResult::Failed);
  CHECK(recent.find(recordId(3).c_str(), result) && result == CommandResult::Refused);
  CHECK(!recent.find(recordId(4).c_str(), result));

  // Exact matches only: case counts, and a prefix is another id.
  recent.remember("abc", CommandResult::Done);
  CHECK(!recent.find("ABC", result));
  CHECK(!recent.find("ab", result));
  CHECK(!recent.find("abcd", result));

  // 40 characters are kept whole: two ids that differ only in the last are two.
  std::string a(40, 'q'), b(40, 'q');
  b[39] = 'r';
  recent.remember(a.c_str(), CommandResult::Done);
  CHECK(recent.find(a.c_str(), result));
  CHECK(!recent.find(b.c_str(), result));

  // An invalid id is neither remembered nor found, and takes no one's place.
  cad::RecentCommands fresh;
  fresh.remember(recordId(1).c_str(), CommandResult::Done);
  for (int i = 0; i < 20; i++) fresh.remember("not/valid", CommandResult::Done);
  fresh.remember(std::string(41, 'a').c_str(), CommandResult::Done);
  fresh.remember(nullptr, CommandResult::Done);
  CHECK(!fresh.find("not/valid", result));
  CHECK(!fresh.find(std::string(41, 'a').c_str(), result));
  CHECK(!fresh.find(nullptr, result));
  CHECK(fresh.find(recordId(1).c_str(), result));
}

// The last CAPACITY ids, the oldest overwritten first.
static void recent_commands_forget_the_oldest() {
  CHECK(cad::RecentCommands::CAPACITY == 8);
  cad::RecentCommands recent;
  CommandResult result = CommandResult::Done;
  for (int n = 1; n <= 8; n++) recent.remember(recordId(n).c_str(), CommandResult::Done);
  for (int n = 1; n <= 8; n++) CHECK(recent.find(recordId(n).c_str(), result));

  recent.remember(recordId(9).c_str(), CommandResult::Failed);
  CHECK(!recent.find(recordId(1).c_str(), result));    // the oldest went
  for (int n = 2; n <= 9; n++) CHECK(recent.find(recordId(n).c_str(), result));

  // An id remembered again keeps its slot and takes the new result: it does
  // not push a second copy in, which would forget another id early.
  recent.remember(recordId(5).c_str(), CommandResult::Refused);
  CHECK(recent.find(recordId(5).c_str(), result) && result == CommandResult::Refused);
  for (int n = 2; n <= 9; n++) CHECK(recent.find(recordId(n).c_str(), result));

  // Round and round: after 100 more, exactly the last 8 are there.
  for (int n = 100; n < 200; n++) recent.remember(recordId(n).c_str(), CommandResult::Done);
  int found = 0;
  for (int n = 1; n < 200; n++) {
    if (recent.find(recordId(n).c_str(), result)) {
      found++;
      CHECK(n >= 192);
    }
  }
  CHECK(found == 8);
}

// One command, the same commandId, reaching the board twice (a send retried
// upstream after a timeout), through the steps handleMessage() takes:
//   1. a commandId it remembers is answered again with "already carried out";
//   2. otherwise the command is carried out;
//   3. and a valid commandId is remembered and answered.
struct Board {
  cad::RecentCommands recent;
  int servoMoves = 0;   // how many times the command was carried out
  std::string lastAnswer;

  void command(const char* operation, const char* commandId) {
    const char* id = cad::validCommandId(commandId) ? commandId : "";
    CommandResult result = CommandResult::Done;
    if (recent.find(id, result)) { answer(id, result, "already carried out"); return; }
    if (std::strcmp(operation, "RESTART") == 0) servoMoves++;
    else result = CommandResult::Refused;
    answer(id, result, "");
  }

  void answer(const char* id, CommandResult result, const char* detail) {
    lastAnswer = "";
    if (!*id) return;                                  // no commandId, no answer
    recent.remember(id, result);
    lastAnswer = std::string(cad::resultName(result)) + (*detail ? std::string(" ") + detail : "");
  }
};

static void a_command_sent_twice_is_carried_out_once() {
  Board board;
  board.command("RESTART", "a0Bbm00000AbCdEFGH");
  CHECK(board.servoMoves == 1);
  CHECK(board.lastAnswer == "done");
  board.command("RESTART", "a0Bbm00000AbCdEFGH");
  CHECK(board.servoMoves == 1);                        // not twice
  CHECK(board.lastAnswer == "done already carried out");

  // A second restart is another record, so another commandId: carried out.
  board.command("RESTART", "a0Bbm00000AbCdEFGI");
  CHECK(board.servoMoves == 2);

  // An operation the board does not know is remembered as refused too.
  board.command("FLY", "a0Bbm00000AbCdEFGJ");
  board.command("FLY", "a0Bbm00000AbCdEFGJ");
  CHECK(board.lastAnswer == "refused already carried out");

  // Without a valid commandId nothing can tell two sends apart: each is
  // carried out, and none is answered.
  board.command("RESTART", "");
  board.command("RESTART", "not/valid");
  CHECK(board.servoMoves == 4);
  CHECK(board.lastAnswer.empty());
}

int main() {
  outcome_names();
  command_id_rule();
  copy_text();
  recent_commands_remember_and_find();
  recent_commands_forget_the_oldest();
  a_command_sent_twice_is_carried_out_once();
  if (failures) { std::printf("%d check(s) failed\n", failures); return 1; }
  std::printf("all device command checks passed\n");
  return 0;
}
