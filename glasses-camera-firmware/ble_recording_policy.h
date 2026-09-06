#pragma once
#include <stdint.h>
#include <stddef.h>
#include <string.h>

namespace blinks {
// The 6 September A/B test verified 50 ms, latency 0. Keep the same parameters
// during transfers; bounded notification backpressure handles queue pressure.
constexpr uint16_t intervalUnits = 40;  // 1.25 ms units
constexpr uint16_t latency = 0;
constexpr uint16_t timeoutUnits = 600;  // 10 ms units
constexpr uint32_t frameTimeoutMs = 20000;
constexpr uint32_t packetTimeoutMs = 2000;

// Called from loop(), never from a NimBLE callback. Allow initial GATT setup,
// retry a phone override, and back off if a central keeps rejecting requests.
struct ConnectionPolicy {
  uint32_t lastRequestMs = 0;
  uint8_t attempts = 0;
  void reset(uint32_t now) { lastRequestMs = now; attempts = 0; }
  bool requestDue(uint32_t now, uint16_t interval, uint16_t actualLatency) {
    if (interval == intervalUnits && actualLatency == latency) {
      attempts = 0;
      lastRequestMs = now;
      return false;
    }
    const uint32_t waitMs = attempts == 0 ? 5000 : attempts < 3 ? 10000 : 60000;
    if (uint32_t(now - lastRequestMs) < waitMs) return false;
    lastRequestMs = now;
    if (attempts < 3) ++attempts;
    return true;
  }
};

// Retry only an unaccepted packet. Recheck link identity, pause and subscription
// before every attempt, including after queue pressure yields to other tasks.
template <typename Ready, typename Clock, typename Enqueue, typename Wait>
bool queueWithRetry(uint32_t frameStarted, uint32_t& retries, Ready ready,
                    Clock now, Enqueue enqueue, Wait wait) {
  const uint32_t packetStarted = now();
  do {
    if (!ready() || uint32_t(now() - frameStarted) >= frameTimeoutMs) return false;
    if (enqueue()) return true;
    ++retries;
    wait();
  } while (uint32_t(now() - packetStarted) < packetTimeoutMs);
  return false;
}

// Existing phone framing: big-endian length/counter, then tagged JPEG pieces.
// The caller provides pacing and bounded enqueueing; false aborts the frame.
template <typename Send>
bool sendTaggedFrame(const uint8_t* jpeg, size_t length, uint32_t counter,
                     uint16_t mtu, Send send) {
  if (!jpeg || length == 0 || length > UINT32_MAX || mtu < 23) return false;
  uint8_t header[9] = {1};
  for (unsigned i = 0; i < 4; ++i) {
    header[1 + i] = uint8_t(uint32_t(length) >> (24 - 8 * i));
    header[5 + i] = uint8_t(counter >> (24 - 8 * i));
  }
  if (!send(header, sizeof(header))) return false;
  const size_t payload = mtu >= 184 ? 180 : mtu - 4;
  uint8_t packet[181];
  packet[0] = 2;
  for (size_t offset = 0; offset < length; offset += payload) {
    const size_t n = length - offset < payload ? length - offset : payload;
    memcpy(packet + 1, jpeg + offset, n);
    if (!send(packet, n + 1)) return false;
  }
  return true;
}
}  // namespace blinks
