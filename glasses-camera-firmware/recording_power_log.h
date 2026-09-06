#pragma once

// Production power evidence, independent of the completed bench-test namespace.
// One compact summary per boot, last eight checkpointed boots retained. Saves
// happen only with the camera parked, at most once every five minutes. Sudden
// power loss can lose the final five minutes, but never the whole overnight run.
#if defined(BLINKS_RECORDING_POWER) && !defined(BLINKS_POWER_TEST)
#include "driver/usb_serial_jtag.h"
#include "esp_app_desc.h"
#include "esp_sleep.h"
#include "nvs.h"
#include "soc/rtc.h"
#if !CONFIG_PM_ENABLE || !CONFIG_FREERTOS_USE_TICKLESS_IDLE || !CONFIG_BT_CTRL_MAIN_XTAL_PU_DURING_LIGHT_SLEEP
#error "Recording power build requires PM, tickless idle, and BLE clock fallback; regenerate its cached sdkconfig"
#endif

static portMUX_TYPE recordingSleepMux = portMUX_INITIALIZER_UNLOCKED;
static uint32_t recordingSleepOk = 0, recordingSleepFailed = 0;
extern "C" esp_err_t __real_esp_light_sleep_start(void);
extern "C" esp_err_t IRAM_ATTR __wrap_esp_light_sleep_start(void) {
  const esp_err_t result = __real_esp_light_sleep_start();
  portENTER_CRITICAL_SAFE(&recordingSleepMux);
  if (result == ESP_OK) ++recordingSleepOk;
  else ++recordingSleepFailed;
  portEXIT_CRITICAL_SAFE(&recordingSleepMux);
  return result;
}

struct RecordingPowerRun {
  uint32_t id, uptimeS, frames, queued, aborted, retries, transferMs;
  uint32_t sleepOk, sleepFailed, idleSamples, gaugeErrors;
  int64_t idleSumMa;
  uint32_t linkSamples, targetSamples;
  uint16_t firstMv, lastMv, minMv;
  int16_t idleMinMa, idleMaxMa;
  uint16_t interval, latency;
  int8_t rtcClock, btClock;
  uint8_t resetReason, reserved;
  char elf[17];
};
struct RecordingPowerStore {
  uint32_t magic;
  uint8_t next, count;
  uint8_t reserved[2];
  RecordingPowerRun runs[8];
};
static constexpr uint32_t RECORDING_POWER_MAGIC = 0x52505701;
static RecordingPowerStore recordingHistory = {};
static RecordingPowerRun recordingRun = {};
static uint32_t recordingLastSampleMs = 0, recordingLastSaveMs = 0;
static bool recordingStorageReady = false, recordingHasSaved = false;
static uint8_t recordingSlot = 0;
static esp_err_t recordingStorageStatus = ESP_ERR_INVALID_STATE;
static_assert(sizeof(RecordingPowerStore) < 1536, "Keep checkpoints small");

static void printRecordingRun(const RecordingPowerRun& r, const char* label) {
  Serial.printf("POWER %s boot=%lu reset=%s elf=%.16s uptime_s=%lu frames=%lu "
                "queued=%lu aborted=%lu retries=%lu transfer_ms=%lu "
                "sleep_ok=%lu sleep_failed=%lu rtc_clock=%d bt_clock=%d\n",
                label, (unsigned long)r.id,
                resetReasonName((esp_reset_reason_t)r.resetReason), r.elf,
                (unsigned long)r.uptimeS, (unsigned long)r.frames,
                (unsigned long)r.queued, (unsigned long)r.aborted,
                (unsigned long)r.retries, (unsigned long)r.transferMs,
                (unsigned long)r.sleepOk, (unsigned long)r.sleepFailed,
                r.rtcClock, r.btClock);
  Serial.printf("POWER link interval_ms=%.2f latency=%u target_samples=%lu/%lu "
                "battery_idle_n=%lu mean_mA=%.2f min_mA=%d max_mA=%d "
                "battery_mV_first=%u last=%u min=%u gauge_errors=%lu\n",
                r.interval * 1.25f, r.latency, (unsigned long)r.targetSamples,
                (unsigned long)r.linkSamples, (unsigned long)r.idleSamples,
                r.idleSamples ? double(r.idleSumMa) / r.idleSamples : 0.0,
                r.idleMinMa, r.idleMaxMa, r.firstMv, r.lastMv, r.minMv,
                (unsigned long)r.gaugeErrors);
}

static void recordingPowerDump() {
  Serial.printf("POWER firmware=blinks-recording-20260906-3 storage=%s\n",
                esp_err_to_name(recordingStorageStatus));
  const unsigned start = recordingHistory.count == 8 ? recordingHistory.next : 0;
  for (unsigned i = 0; i < recordingHistory.count; ++i)
    printRecordingRun(recordingHistory.runs[(start + i) % 8], "checkpoint");
  printRecordingRun(recordingRun, "live");
  Serial.println("POWER current is signed gauge data, not calibrated system draw. "
                 "Idle samples exclude USB, capture/transfer and the first 5 s after a burst. "
                 "Sleep counts include advertising. Queued is not a phone/server acknowledgement. "
                 "Flash checkpoints can lag by five minutes.");
}

static void recordingPowerBegin() {
  nvs_handle_t handle;
  recordingStorageStatus = nvs_open("blinks-rec-pwr", NVS_READWRITE, &handle);
  if (recordingStorageStatus == ESP_OK) {
    size_t size = sizeof(recordingHistory);
    recordingStorageStatus = nvs_get_blob(handle, "history-v1", &recordingHistory, &size);
    recordingStorageReady = recordingStorageStatus == ESP_ERR_NVS_NOT_FOUND ||
        (recordingStorageStatus == ESP_OK && size == sizeof(recordingHistory) &&
         recordingHistory.magic == RECORDING_POWER_MAGIC &&
         recordingHistory.next < 8 && recordingHistory.count <= 8);
    if (recordingStorageStatus == ESP_ERR_NVS_NOT_FOUND) recordingHistory = {};
    if (!recordingStorageReady) {
      recordingHistory = {};
      // Leave unreadable storage untouched; recording itself can still run.
      recordingStorageStatus = ESP_ERR_INVALID_STATE;
    }
    nvs_close(handle);
  }
  for (unsigned i = 0; i < recordingHistory.count; ++i)
    if (recordingHistory.runs[i].id > recordingRun.id)
      recordingRun.id = recordingHistory.runs[i].id;
  ++recordingRun.id;
  recordingSlot = recordingHistory.next;
  recordingRun.resetReason = esp_reset_reason();
  recordingRun.rtcClock = rtc_clk_slow_src_get();
  recordingRun.btClock = -1;
  const esp_app_desc_t* app = esp_app_get_description();
  for (unsigned i = 0; i < 8; ++i)
    snprintf(recordingRun.elf + i * 2, 3, "%02x", app->app_elf_sha256[i]);
  recordingPowerDump();
}

static void recordingPowerFrame(bool queued, uint32_t retries, uint32_t durationMs) {
  if (queued) ++recordingRun.queued;
  else ++recordingRun.aborted;
  recordingRun.retries += retries;
  recordingRun.transferMs += durationMs;
}

static void recordingPowerTick(bool idle, bool linked, uint16_t interval,
                               uint16_t latency, uint32_t frames) {
  const uint32_t now = millis();
  recordingRun.uptimeS = now / 1000;
  recordingRun.frames = frames;
  recordingRun.btClock = esp_bt_get_lpclk_src();
  portENTER_CRITICAL(&recordingSleepMux);
  recordingRun.sleepOk = recordingSleepOk;
  recordingRun.sleepFailed = recordingSleepFailed;
  portEXIT_CRITICAL(&recordingSleepMux);
  if (uint32_t(now - recordingLastSampleMs) >= 5000) {
    recordingLastSampleMs = now;
    if (linked) {
      recordingRun.interval = interval;
      recordingRun.latency = latency;
      ++recordingRun.linkSamples;
      if (interval == 40 && latency == 0) ++recordingRun.targetSamples;
    }
    if (idle && linked && !usb_serial_jtag_is_connected()) {
      uint16_t mv, raw;
      if (fuelGaugeRead16(FUEL_REG_VOLTAGE, mv) && fuelGaugeRead16(FUEL_REG_CURRENT, raw)) {
        const int16_t ma = static_cast<int16_t>(raw);
        // Also exclude externally powered readings if USB detection is late.
        if (ma <= 0) {
          if (!recordingRun.idleSamples) {
            recordingRun.firstMv = recordingRun.minMv = mv;
            recordingRun.idleMinMa = recordingRun.idleMaxMa = ma;
          }
          recordingRun.lastMv = mv;
          if (mv < recordingRun.minMv) recordingRun.minMv = mv;
          if (ma < recordingRun.idleMinMa) recordingRun.idleMinMa = ma;
          if (ma > recordingRun.idleMaxMa) recordingRun.idleMaxMa = ma;
          recordingRun.idleSumMa += ma;
          ++recordingRun.idleSamples;
        }
      } else ++recordingRun.gaugeErrors;
    }
  }
  const uint32_t saveInterval = recordingHasSaved ? 300000 : 60000;
  if (!idle || !recordingStorageReady || uint32_t(now - recordingLastSaveMs) < saveInterval) return;
  recordingLastSaveMs = now;  // Also bound retries on a failed flash write.
  recordingHasSaved = true;
  recordingHistory.magic = RECORDING_POWER_MAGIC;
  recordingHistory.runs[recordingSlot] = recordingRun;
  if (recordingHistory.next == recordingSlot) {
    recordingHistory.next = (recordingSlot + 1) % 8;
    if (recordingHistory.count < 8) ++recordingHistory.count;
  }
  nvs_handle_t handle;
  recordingStorageStatus = nvs_open("blinks-rec-pwr", NVS_READWRITE, &handle);
  if (recordingStorageStatus == ESP_OK) {
    recordingStorageStatus = nvs_set_blob(handle, "history-v1", &recordingHistory, sizeof(recordingHistory));
    if (recordingStorageStatus == ESP_OK) recordingStorageStatus = nvs_commit(handle);
    nvs_close(handle);
  }
  printRecordingRun(recordingRun, "saving");
  Serial.printf("POWER checkpoint=%s\n", esp_err_to_name(recordingStorageStatus));
}
#else
static void recordingPowerBegin() {}
static void recordingPowerDump() {}
static void recordingPowerFrame(bool, uint32_t, uint32_t) {}
static void recordingPowerTick(bool, bool, uint16_t, uint16_t, uint32_t) {}
#endif
