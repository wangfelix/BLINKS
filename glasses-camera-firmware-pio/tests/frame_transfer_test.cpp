#include "../../glasses-camera-firmware/ble_recording_policy.h"
#include <cassert>
#include <cstdio>
#include <vector>

int main() {
  std::vector<uint8_t> jpeg(65003);
  for (size_t i = 0; i < jpeg.size(); ++i) jpeg[i] = uint8_t(i);
  for (uint16_t mtu : {23, 64, 184, 517}) {
    std::vector<std::vector<uint8_t>> packets;
    assert(blinks::sendTaggedFrame(jpeg.data(), jpeg.size(), 0x12345678, mtu,
        [&](const uint8_t* p, size_t n) { packets.emplace_back(p, p + n); return true; }));
    const std::vector<uint8_t> expectedHeader = {1, 0, 0, 0xFD, 0xEB, 0x12, 0x34, 0x56, 0x78};
    assert(packets.front() == expectedHeader);
    std::vector<uint8_t> received;
    for (size_t i = 1; i < packets.size(); ++i) {
      assert(packets[i][0] == 2 && packets[i].size() <= size_t(mtu - 3));
      received.insert(received.end(), packets[i].begin() + 1, packets[i].end());
    }
    assert(received == jpeg); // Identical JPEG under the unchanged phone protocol.
  }
  for (unsigned failAt : {1, 3}) {
    unsigned calls = 0;
    assert(!blinks::sendTaggedFrame(jpeg.data(), jpeg.size(), 1, 517,
        [&](const uint8_t*, size_t) { return ++calls != failAt; }));
    assert(calls == failAt); // Never send the rest of a broken frame.
  }

  uint32_t now = 0, retries = 0, attempts = 0;
  assert(blinks::queueWithRetry(0, retries, [] { return true; }, [&] { return now; },
      [&] { return ++attempts == 4; }, [&] { now += 10; }));
  assert(retries == 3 && attempts == 4 && now == 30);

  now = retries = attempts = 0;
  assert(!blinks::queueWithRetry(0, retries, [] { return true; }, [&] { return now; },
      [&] { ++attempts; return false; }, [&] { now += 10; }));
  assert(now == 2000 && retries == 200 && attempts == 200); // Queue permanently full.

  now = 19990; retries = attempts = 0;
  assert(!blinks::queueWithRetry(0, retries, [] { return true; }, [&] { return now; },
      [&] { ++attempts; return false; }, [&] { now += 10; }));
  assert(now == 20000 && attempts == 1); // Whole-frame deadline takes precedence.

  now = retries = attempts = 0;
  uint32_t generation = 3;
  assert(!blinks::queueWithRetry(0, retries, [&] { return generation == 3; }, [&] { return now; },
      [&] { ++attempts; return false; }, [&] { now += 10; generation = 5; }));
  assert(attempts == 1); // Reconnect must not receive the tail of an old frame.

  bool paused = true;
  attempts = 0;
  assert(!blinks::queueWithRetry(0, retries, [&] { return !paused; }, [&] { return now; },
      [&] { ++attempts; return true; }, [] {}));
  assert(attempts == 0);
  puts("Frame transfer: byte-exact JPEGs at four MTUs, aborts, queue recovery, timeouts, reconnect and pause passed");
}
