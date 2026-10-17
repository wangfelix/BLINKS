// Host test for the 0x03 capture interval command and the ...0004 JSON.
//   g++ -std=c++17 -Wall -Wextra -o /tmp/ci tests/capture_interval_test.cpp && /tmp/ci
// The necklace copy is checked too:
//   g++ ... -DCAPTURE_INTERVAL_HEADER='"../../camera-firmware/capture_interval_config.h"'
#ifndef CAPTURE_INTERVAL_HEADER
#define CAPTURE_INTERVAL_HEADER "../../glasses-camera-firmware/capture_interval_config.h"
#endif
#include CAPTURE_INTERVAL_HEADER
#include <cassert>
#include <cstdio>
#include <cstring>
#include <initializer_list>

using namespace blinks;

static SetIntervalResult parse(std::initializer_list<uint8_t> bytes, uint32_t& raw, uint32_t& eff) {
  uint8_t buf[16];
  size_t n = 0;
  for (uint8_t b : bytes) buf[n++] = b;
  return parseSetCaptureInterval(buf, n, raw, eff);
}

int main() {
  uint32_t raw = 7, eff = 7;
  // Spec examples (big-endian): 15 s, 30 s, 60 s.
  assert((parse({0x03, 0x00, 0x00, 0x3A, 0x98}, raw, eff) == SetIntervalResult::Ok && eff == 15000));
  assert((parse({0x03, 0x00, 0x00, 0x75, 0x30}, raw, eff) == SetIntervalResult::Ok && eff == 30000));
  assert((parse({0x03, 0x00, 0x00, 0xEA, 0x60}, raw, eff) == SetIntervalResult::Ok && eff == 60000));
  // Clamping to [5000, 600000] (hardware test values 1000 / 700000).
  assert((parse({0x03, 0x00, 0x00, 0x03, 0xE8}, raw, eff) == SetIntervalResult::Clamped && raw == 1000 && eff == 5000));
  assert((parse({0x03, 0x00, 0x0A, 0xAE, 0x60}, raw, eff) == SetIntervalResult::Clamped && raw == 700000 && eff == 600000));
  assert((parse({0x03, 0x00, 0x00, 0x00, 0x00}, raw, eff) == SetIntervalResult::Clamped && eff == 5000));
  assert((parse({0x03, 0xFF, 0xFF, 0xFF, 0xFF}, raw, eff) == SetIntervalResult::Clamped && eff == 600000));
  // Exact bounds are not clamped.
  assert((parse({0x03, 0x00, 0x00, 0x13, 0x88}, raw, eff) == SetIntervalResult::Ok && eff == 5000));
  assert((parse({0x03, 0x00, 0x09, 0x27, 0xC0}, raw, eff) == SetIntervalResult::Ok && eff == 600000));
  // Wrong length is ignored and leaves the outputs untouched.
  raw = eff = 42;
  assert((parse({0x03, 0x00, 0x3A, 0x98}, raw, eff) == SetIntervalResult::BadLength && raw == 42 && eff == 42));
  assert((parse({0x03, 0x00, 0x00, 0x3A, 0x98, 0x00}, raw, eff) == SetIntervalResult::BadLength && eff == 42));
  assert((parse({0x03}, raw, eff) == SetIntervalResult::BadLength));
  // Other opcodes are not ours.
  assert((parse({0x01}, raw, eff) == SetIntervalResult::NotSetInterval));
  assert((parse({0x02, 0, 0, 0, 0}, raw, eff) == SetIntervalResult::NotSetInterval));
  assert(parseSetCaptureInterval(nullptr, 0, raw, eff) == SetIntervalResult::NotSetInterval);
  // The firmware warm-up must stay below the minimum interval.
  static_assert(500 < kCaptureIntervalMinMs, "warm-up < min interval");

  char json[160];
  const size_t n = formatDeviceInfoJson(json, sizeof json, "1.3.0", "glasses", 30000, 30000);
  const char* expected =
      "{\"v\":1,\"fw\":\"1.3.0\",\"formFactor\":\"glasses\",\"intervalMs\":30000,"
      "\"defaultMs\":30000,\"minMs\":5000,\"maxMs\":600000}";
  assert(n == strlen(expected) && strcmp(json, expected) == 0);
  assert(n < 180);  // fits a single read at the study MTU
  char tiny[20];
  assert(formatDeviceInfoJson(tiny, sizeof tiny, "1.3.0", "glasses", 30000, 30000) == 0);
  puts("Capture interval: parse, clamp, bad length, device info JSON passed");
}
