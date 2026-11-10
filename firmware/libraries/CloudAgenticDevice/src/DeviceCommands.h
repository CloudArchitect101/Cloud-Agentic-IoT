#pragma once
/**
 * DeviceCommands - what a board needs to answer the commands it is sent, and
 * to carry each one out once: the outcomes it answers with, the commandId
 * rule, and the last few commands it carried out.
 *
 * Plain C++ like DeviceTiming.h, so test/firmware compiles and checks it on
 * any machine with a C++ compiler.
 */

#include <stddef.h>
#include <stdint.h>
#include <string.h>

namespace cad {

// What a command came to, as the answer on device/<thing>/ack says it.
// Failed: the board knows the operation but could not carry it out (an
// interval out of range). Refused: nothing on the board knows the operation.
enum class CommandResult : uint8_t { Done, Failed, Refused };

inline const char* resultName(CommandResult result) {
  switch (result) {
    case CommandResult::Done:    return "done";
    case CommandResult::Failed:  return "failed";
    case CommandResult::Refused: return "refused";
  }
  return "refused";
}

// A commandId is 1 to 40 of these characters. A Salesforce record Id (18)
// fits, and none of them needs escaping in JSON or means anything in an MQTT
// topic. COMMAND_ID in lambda/device-command and lambda/device-command-ack is
// the same rule; test/firmware/contract.test.js fails the build if they drift,
// because a commandId one side takes and the other drops leaves its command
// waiting for an answer that never comes.
const size_t MAX_COMMAND_ID_LENGTH = 40;
const char COMMAND_ID_CHARACTERS[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";

inline bool validCommandId(const char* id) {
  if (!id) return false;
  size_t length = 0;
  for (; id[length]; length++) {
    if (length == MAX_COMMAND_ID_LENGTH || !strchr(COMMAND_ID_CHARACTERS, id[length])) return false;
  }
  return length > 0;
}

// The most an answer's detail says, in characters.
const size_t MAX_DETAIL_LENGTH = 120;

/**
 * Copies `in` into `out`, which holds `size` bytes (at least 1), cut to fit,
 * with '?' for every character outside printable ASCII and for " and \. What
 * a board repeats from a command, its operation, then never needs escaping:
 * the answer stays inside the buffer it is written into, and never holds half
 * a UTF-8 character. Either would leave it as JSON the IoT rule cannot read.
 */
inline char* copyText(char* out, size_t size, const char* in) {
  size_t i = 0;
  for (; in && in[i] && i + 1 < size; i++) {
    unsigned char c = (unsigned char)in[i];
    out[i] = (c >= 0x20 && c <= 0x7E && c != '"' && c != '\\') ? (char)c : '?';
  }
  out[i] = '\0';
  return out;
}

/**
 * The last CAPACITY commands carried out, by commandId, and what each came to.
 *
 * One command can reach a board twice: a send retried upstream after a
 * timeout is a second message with the same commandId. The board answers the
 * second from here instead of carrying it out again, so one
 * DISPENSE_MEDICATION never moves the servo twice.
 *
 * RAM only, a fixed array: the oldest is overwritten, and a restart forgets
 * them all. That is enough because the board subscribes at QoS 0 with a
 * clean session, so the broker never delivers a message twice, even across a
 * restart, and a command sent twice upstream comes again within seconds, not
 * eight commands later.
 */
class RecentCommands {
 public:
  static const uint8_t CAPACITY = 8;

  RecentCommands() : _next(0) {
    for (uint8_t i = 0; i < CAPACITY; i++) {
      _ids[i][0] = '\0';
      _results[i] = CommandResult::Done;
    }
  }

  /** True when `id` was carried out among the last CAPACITY commands; sets
   *  `result` to what it came to. An invalid id is never found. */
  bool find(const char* id, CommandResult& result) const {
    int slot = slotOf(id);
    if (slot < 0) return false;
    result = _results[slot];
    return true;
  }

  /** Remembers what `id` came to, in place of the oldest. An id already
   *  remembered keeps its place; an invalid one is not remembered. */
  void remember(const char* id, CommandResult result) {
    if (!validCommandId(id)) return;
    int slot = slotOf(id);
    if (slot < 0) {
      slot = _next;
      _next = (uint8_t)((_next + 1) % CAPACITY);
      memcpy(_ids[slot], id, strlen(id) + 1);   // fits: validCommandId() checked the length
    }
    _results[slot] = result;
  }

 private:
  char _ids[CAPACITY][MAX_COMMAND_ID_LENGTH + 1];
  CommandResult _results[CAPACITY];
  uint8_t _next;

  int slotOf(const char* id) const {
    if (!validCommandId(id)) return -1;   // also keeps an empty slot from matching
    for (uint8_t i = 0; i < CAPACITY; i++) {
      if (strcmp(_ids[i], id) == 0) return i;
    }
    return -1;
  }
};

}  // namespace cad
