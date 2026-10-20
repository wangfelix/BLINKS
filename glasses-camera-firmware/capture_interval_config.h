#pragma once
// Runtime capture interval (control opcode 0x03) + device info JSON
// (characteristic ...0004). Spec: docs/ble-protocol.md and
// docs/study-config-documentation.md.
//
// Header-only and free of Arduino APIs so it is host-testable
// (glasses-camera-firmware-pio/tests/capture_interval_test.cpp).
// Keep the copies in camera-firmware/ and glasses-camera-firmware/ identical;
// the host test compiles against both.
#include <stdint.h>
#include <stddef.h>
#include <stdio.h>

namespace blinks {

// Same bounds as capture.intervalMsByFormFactor in
// server/src/study-config/schema.ts.
constexpr uint32_t kCaptureIntervalMinMs = 5000;
constexpr uint32_t kCaptureIntervalMaxMs = 600000;
constexpr uint8_t kControlOpSetCaptureInterval = 0x03;
constexpr size_t kSetCaptureIntervalLength = 5;  // [0x03][uint32 BE intervalMs]
constexpr int kDeviceInfoFormatVersion = 1;

inline uint32_t clampCaptureIntervalMs(uint32_t requestedMs) {
  if (requestedMs < kCaptureIntervalMinMs) return kCaptureIntervalMinMs;
  if (requestedMs > kCaptureIntervalMaxMs) return kCaptureIntervalMaxMs;
  return requestedMs;
}

enum class SetIntervalResult : uint8_t { Ok, Clamped, BadLength, NotSetInterval };

// Parses a control write. On Ok/Clamped, rawMs is the requested value and
// effectiveMs the clamped one. A wrong length leaves both untouched.
inline SetIntervalResult parseSetCaptureInterval(const uint8_t* data, size_t length,
                                                 uint32_t& rawMs, uint32_t& effectiveMs) {
  if (length < 1 || data[0] != kControlOpSetCaptureInterval) {
    return SetIntervalResult::NotSetInterval;
  }
  if (length != kSetCaptureIntervalLength) return SetIntervalResult::BadLength;
  rawMs = (uint32_t(data[1]) << 24) | (uint32_t(data[2]) << 16) |
          (uint32_t(data[3]) << 8) | uint32_t(data[4]);
  effectiveMs = clampCaptureIntervalMs(rawMs);
  return effectiveMs == rawMs ? SetIntervalResult::Ok : SetIntervalResult::Clamped;
}

// Compact JSON for ...0004, e.g.
// {"v":1,"fw":"1.3.0","formFactor":"glasses","intervalMs":30000,"defaultMs":30000,"minMs":5000,"maxMs":600000}
// Returns the length written (excluding NUL) or 0 if the buffer is too small.
inline size_t formatDeviceInfoJson(char* out, size_t capacity, const char* firmwareVersion,
                                   const char* formFactor, uint32_t intervalMs,
                                   uint32_t defaultMs) {
  const int written = snprintf(
      out, capacity,
      "{\"v\":%d,\"fw\":\"%s\",\"formFactor\":\"%s\",\"intervalMs\":%lu,"
      "\"defaultMs\":%lu,\"minMs\":%lu,\"maxMs\":%lu}",
      kDeviceInfoFormatVersion, firmwareVersion, formFactor, (unsigned long)intervalMs,
      (unsigned long)defaultMs, (unsigned long)kCaptureIntervalMinMs,
      (unsigned long)kCaptureIntervalMaxMs);
  if (written < 0 || size_t(written) >= capacity) return 0;
  return size_t(written);
}

}  // namespace blinks
