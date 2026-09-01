#ifndef BLINKS_GLASSES_BATTERY_LOG_H
#define BLINKS_GLASSES_BATTERY_LOG_H

#include <Arduino.h>
#include <Wire.h>
#include "esp_system.h"

// Diagnostic only: nothing here changes how the camera behaves.
//
// The problem this solves is that the interesting measurement — how much the
// glasses draw while connected but not capturing — can only be taken on
// battery, and attaching USB for a serial monitor supplies power and starts
// charging, which destroys the very number you wanted. Plugging USB in does not
// reset the ESP32, though. So samples are kept in a RAM ring buffer while the
// device runs on battery, and dumped on demand once a monitor is attached:
//
//   1. run on battery, no USB, for ten minutes or more
//   2. plug in USB and open the serial monitor (the device keeps running)
//   3. press any key -> the pre-USB samples are printed
//
// Reuses statusLedWire from status_led.h: the fuel gauge sits on the same
// system I2C bus as the LP5815, so include this after status_led.h.

// BQ27220-style standard commands. Confirmed against this board by the register
// dump in glasses-camera-diagnostic/: 0x08 reads a plausible cell voltage and
// 0x2C a plausible state of charge, whereas the BQ27441 map does not.
static constexpr uint8_t FUEL_GAUGE_ADDRESS = 0x55;
static constexpr uint8_t FUEL_REG_VOLTAGE   = 0x08;  // mV, unsigned
static constexpr uint8_t FUEL_REG_CURRENT   = 0x0C;  // mA, SIGNED
static constexpr uint8_t FUEL_REG_SOC       = 0x2C;  // percent

#define BATTERY_SAMPLE_INTERVAL_MS 5000UL
#define BATTERY_LOG_SAMPLES        120   // 10 minutes at 5 s
#define BATTERY_LOG_MAGIC          0xB1A77E01UL

enum BatteryPhase { BATT_IDLE = 0, BATT_CAMERA = 1 };
static const char* const BATTERY_PHASE_NAME[] = {"idle", "camera"};

struct BatterySample {
  uint32_t     uptimeS;
  uint16_t     milliVolts;
  int16_t      milliAmps;
  uint8_t      percent;
  uint8_t      boot;        // millis() restarts each boot; this keeps them apart
  BatteryPhase phase;
};

// RTC slow memory survives a reset that does not remove power: a brownout, a
// watchdog, a panic, and the reset some serial monitors trigger when they open
// the port. Keeping the log here means neither plugging in USB nor the reboot
// under investigation destroys the evidence.
struct BatteryLogBuffer {
  BatterySample samples[BATTERY_LOG_SAMPLES];
  uint16_t      count;      // saturates at BATTERY_LOG_SAMPLES
  uint16_t      next;       // ring index
  uint32_t      magic;
};

RTC_NOINIT_ATTR static BatteryLogBuffer batteryLive;
// Written once per non-power-on boot and then left alone, so the samples
// leading up to a brownout stay readable until USB is next attached.
RTC_NOINIT_ATTR static BatteryLogBuffer batteryPreCrash;
RTC_NOINIT_ATTR static uint8_t          batteryBootCounter;

// Why each boot in the current chain happened. The battery ring only ever holds
// the current and previous run, but the question a reboot loop poses is what
// KIND of reset it is repeating, and that answer is one byte per boot. Keeping
// the last 32 means a loop can be left running unattended and read afterwards,
// instead of having to be watched live on the serial monitor.
#define BATTERY_BOOT_REASONS 32
RTC_NOINIT_ATTR static uint8_t bootReasons[BATTERY_BOOT_REASONS];
RTC_NOINIT_ATTR static uint8_t bootReasonCount;   // saturates
RTC_NOINIT_ATTR static uint8_t bootReasonNext;    // ring index

static unsigned long batteryLastSampleMs = 0;

static bool fuelGaugeRead16(uint8_t reg, uint16_t &value) {
  statusLedWire.beginTransmission(FUEL_GAUGE_ADDRESS);
  statusLedWire.write(reg);
  if (statusLedWire.endTransmission(false) != 0) return false;  // repeated START
  if (statusLedWire.requestFrom(FUEL_GAUGE_ADDRESS, (uint8_t)2, true) != 2) {
    return false;
  }
  const uint8_t lo = statusLedWire.read();
  const uint8_t hi = statusLedWire.read();
  value = (uint16_t)lo | ((uint16_t)hi << 8);
  return true;
}

static const char* resetReasonName(esp_reset_reason_t reason) {
  switch (reason) {
    case ESP_RST_POWERON:   return "POWERON";
    case ESP_RST_SW:        return "SW";
    case ESP_RST_PANIC:     return "PANIC";
    case ESP_RST_INT_WDT:   return "INT_WDT";
    case ESP_RST_TASK_WDT:  return "TASK_WDT";
    case ESP_RST_WDT:       return "WDT";
    case ESP_RST_BROWNOUT:  return "BROWNOUT";
    case ESP_RST_DEEPSLEEP: return "DEEPSLEEP";
    case ESP_RST_EXT:       return "EXT";
    default:                return "other";
  }
}

// Prints why the last boot happened, and decides what to do with whatever the
// previous boot left in RTC memory. A battery that sags under a capture or a
// radio burst shows up here as BROWNOUT, which is what separates "the cell is
// flat" from "the firmware crashed".
void printResetReason() {
  const esp_reset_reason_t reason = esp_reset_reason();
  const char* text = "other";
  switch (reason) {
    case ESP_RST_POWERON:  text = "POWERON (clean start)";        break;
    case ESP_RST_SW:       text = "SW (esp_restart)";             break;
    case ESP_RST_PANIC:    text = "PANIC (crash)";                break;
    case ESP_RST_INT_WDT:  text = "INT_WDT (interrupt watchdog)"; break;
    case ESP_RST_TASK_WDT: text = "TASK_WDT (loop blocked)";      break;
    case ESP_RST_WDT:      text = "WDT";                          break;
    case ESP_RST_BROWNOUT: text = "BROWNOUT (supply sagged)";     break;
    case ESP_RST_DEEPSLEEP: text = "DEEPSLEEP";                   break;
    case ESP_RST_EXT:      text = "EXT (reset pin)";              break;
    default: break;
  }
  Serial.printf("Reset reason: %s\n", text);

  const bool poweron = reason == ESP_RST_POWERON;
  if (poweron || bootReasonCount > BATTERY_BOOT_REASONS) {
    bootReasonCount = 0;
    bootReasonNext = 0;
  }
  bootReasons[bootReasonNext] = (uint8_t)reason;
  bootReasonNext = (bootReasonNext + 1) % BATTERY_BOOT_REASONS;
  if (bootReasonCount < BATTERY_BOOT_REASONS) bootReasonCount++;

  const bool survived =
      reason != ESP_RST_POWERON && batteryLive.magic == BATTERY_LOG_MAGIC;
  if (survived) {
    // Preserve the run that just ended, then start a clean ring for this one.
    batteryPreCrash = batteryLive;
    Serial.printf("Kept %u battery samples from before the reset\n",
                  (unsigned)batteryPreCrash.count);
    batteryBootCounter++;
  } else {
    batteryPreCrash.magic = 0;
    batteryBootCounter = 0;
  }
  batteryLive.count = 0;
  batteryLive.next = 0;
  batteryLive.magic = BATTERY_LOG_MAGIC;
}

void batterySampleNow(BatteryPhase phase) {
  const unsigned long now = millis();
  if (batteryLastSampleMs != 0 &&
      now - batteryLastSampleMs < BATTERY_SAMPLE_INTERVAL_MS) {
    return;
  }
  batteryLastSampleMs = now;

  uint16_t mv = 0, rawCurrent = 0, soc = 0;
  if (!fuelGaugeRead16(FUEL_REG_VOLTAGE, mv)) return;
  if (!fuelGaugeRead16(FUEL_REG_CURRENT, rawCurrent)) return;
  if (!fuelGaugeRead16(FUEL_REG_SOC, soc)) return;

  batteryLive.samples[batteryLive.next] = {
      now / 1000UL, mv, (int16_t)rawCurrent, (uint8_t)soc, batteryBootCounter,
      phase};
  batteryLive.next = (batteryLive.next + 1) % BATTERY_LOG_SAMPLES;
  if (batteryLive.count < BATTERY_LOG_SAMPLES) batteryLive.count++;
}

// Reads the gauge right now rather than replaying the ring. On a fresh boot both
// rings are empty and printed nothing at all, which is exactly when a baseline
// reading matters: after a flash, before a run.
//
// Sign convention is the gauge's: negative current is discharge, positive is
// charge. So a positive figure here means USB is attached and the pack is
// charging, and the voltage alongside it is a charging voltage, not a resting
// one. Take a resting baseline on battery with USB detached.
void batteryPrintNow() {
  uint16_t mv = 0, rawCurrent = 0, soc = 0;
  const bool ok = fuelGaugeRead16(FUEL_REG_VOLTAGE, mv) &&
                  fuelGaugeRead16(FUEL_REG_CURRENT, rawCurrent) &&
                  fuelGaugeRead16(FUEL_REG_SOC, soc);
  if (!ok) {
    Serial.println("Battery now: fuel gauge did not answer on the system I2C bus");
    return;
  }
  const int16_t ma = (int16_t)rawCurrent;
  Serial.printf("Battery now: %u mV, %d mA, gauge %u%%  (%s)\n", (unsigned)mv, ma,
                (unsigned)soc,
                ma > 5    ? "charging, so this is not a resting voltage"
                : ma < -5 ? "discharging on battery"
                          : "no appreciable current");
  // The gauge's percentage is uncalibrated on these packs and sits at 100 until
  // nearly empty, and a pack that was replugged after an over-discharge latch has
  // to relearn before it means anything. Read the millivolts.
  if (mv < 3300) {
    Serial.println("  Below 3300 mV: little usable margin left, expect resets under load.");
  }
}

static void batteryPrintBuffer(const BatteryLogBuffer &buf, const char *title) {
  if (buf.magic != BATTERY_LOG_MAGIC || buf.count == 0) return;

  Serial.printf("===== %s: %u samples, newest last =====\n", title,
                (unsigned)buf.count);
  Serial.println("boot  uptime_s  phase   mV    mA   %");

  // Negative current means discharge on this gauge family; a positive figure
  // while USB is attached is charge current, not system draw.
  int32_t sum[2] = {0, 0};
  int32_t lo[2] = {INT32_MAX, INT32_MAX};
  int32_t hi[2] = {INT32_MIN, INT32_MIN};
  uint16_t count[2] = {0, 0};

  const uint16_t start = (buf.count == BATTERY_LOG_SAMPLES) ? buf.next : 0;
  for (uint16_t i = 0; i < buf.count; i++) {
    const BatterySample &s = buf.samples[(start + i) % BATTERY_LOG_SAMPLES];
    Serial.printf("%4u  %8lu  %-6s %5u %5d %3u\n", (unsigned)s.boot,
                  (unsigned long)s.uptimeS, BATTERY_PHASE_NAME[s.phase & 1],
                  s.milliVolts, s.milliAmps, s.percent);
    const uint8_t p = s.phase & 1;
    sum[p] += s.milliAmps;
    if (s.milliAmps < lo[p]) lo[p] = s.milliAmps;
    if (s.milliAmps > hi[p]) hi[p] = s.milliAmps;
    count[p]++;
  }

  Serial.println("----- summary (mA) -----");
  for (uint8_t p = 0; p < 2; p++) {
    if (count[p] == 0) {
      Serial.printf("  %-6s no samples\n", BATTERY_PHASE_NAME[p]);
      continue;
    }
    Serial.printf("  %-6s n=%3u  mean=%5ld  min=%5ld  max=%5ld\n",
                  BATTERY_PHASE_NAME[p], count[p], (long)(sum[p] / count[p]),
                  (long)lo[p], (long)hi[p]);
  }
}

// Dumps the ring buffer oldest-first, then a per-phase summary. Triggered by
// any character on the serial port so it can be requested after the fact.
extern int lightSleepStatus;

void batteryDump() {
  Serial.println();
  batteryPrintNow();
  Serial.printf("Light sleep: %s\n",
                lightSleepStatus == 0      ? "ENABLED (this is the IDF build)"
                : lightSleepStatus < 0     ? "not compiled in (Arduino build)"
                                           : "configure REJECTED");
  if (bootReasonCount > 0 && bootReasonCount <= BATTERY_BOOT_REASONS) {
    Serial.printf("Boot chain: %u boots since the last power-on, oldest first\n",
                  (unsigned)bootReasonCount);
    Serial.print("  ");
    const uint8_t start = (bootReasonCount == BATTERY_BOOT_REASONS)
                              ? bootReasonNext : 0;
    for (uint8_t i = 0; i < bootReasonCount; i++) {
      Serial.printf("%s%s", i ? " -> " : "",
                    resetReasonName((esp_reset_reason_t)
                                    bootReasons[(start + i) % BATTERY_BOOT_REASONS]));
    }
    Serial.println();
    Serial.println(
        "  BROWNOUT = the rail sagged with power still present. POWERON = power "
        "was actually removed, so the pack's protection opened. PANIC/WDT = a "
        "firmware fault, not a supply problem.");
  }
  batteryPrintBuffer(batteryPreCrash, "battery log BEFORE the last reset");
  batteryPrintBuffer(batteryLive, "battery log, this run");
  Serial.println(
      "Note: taken on battery, the 'idle' mean is the number that sets the "
      "runtime ceiling. Samples recorded while USB was attached show charge "
      "current, not system draw.");
  Serial.println("========================================");
}

void batteryDumpIfRequested() {
  if (!Serial.available()) return;
  while (Serial.available()) Serial.read();
  batteryDump();
}


#endif  // BLINKS_GLASSES_BATTERY_LOG_H
