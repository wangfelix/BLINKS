// Explicit bench target only. The production initialization is shared, but the
// capture loop is never called: the camera stays parked throughout this test.
#ifdef BLINKS_POWER_TEST
#define setup productionSetup
#define loop productionLoop
#include "../../glasses-camera-firmware/glasses-camera-firmware.ino"
#undef setup
#undef loop

#include "driver/usb_serial_jtag.h"
#include "esp_app_desc.h"
#include "esp_sleep.h"
#include "esp_timer.h"
#include "nvs.h"
#include "soc/rtc.h"
#include <stdio.h>
#include <string.h>

#if !CONFIG_PM_ENABLE || !CONFIG_FREERTOS_USE_TICKLESS_IDLE
#error "The power test requires the same PM-enabled SDK as blinks-glasses"
#endif

// Observe the return value of the real IDF sleep call; do not initiate manual
// sleeps or change controller admission thresholds. Elapsed time includes entry
// and exit overhead, so report sleep_call_ms, never 'actual percent asleep'.
struct SleepTotals { uint64_t elapsedUs; uint32_t ok, failed; };
static SleepTotals sleepTotals = {};
static portMUX_TYPE sleepStatsMux = portMUX_INITIALIZER_UNLOCKED;
extern "C" esp_err_t __real_esp_light_sleep_start(void);
extern "C" esp_err_t IRAM_ATTR __wrap_esp_light_sleep_start(void) {
  const int64_t start = esp_timer_get_time();
  const esp_err_t result = __real_esp_light_sleep_start();
  const uint64_t elapsed = esp_timer_get_time() - start;
  portENTER_CRITICAL_SAFE(&sleepStatsMux);
  if (result == ESP_OK) {
    ++sleepTotals.ok;
    sleepTotals.elapsedUs += elapsed;
  } else {
    ++sleepTotals.failed;
  }
  portEXIT_CRITICAL_SAFE(&sleepStatsMux);
  return result;
}

static SleepTotals readSleepTotals() {
  portENTER_CRITICAL(&sleepStatsMux);
  const SleepTotals result = sleepTotals;
  portEXIT_CRITICAL(&sleepStatsMux);
  return result;
}

static constexpr uint32_t TEST_MAGIC = 0x504F5703;
static constexpr unsigned PHASES = 5;
static constexpr uint32_t PHASE_MS = 120000;
static constexpr uint32_t SETTLE_MS = 20000;
static constexpr uint16_t TARGET_INTERVALS[PHASES] = {0, 6, 40, 6, 40};
static const char* PHASE_NAMES[PHASES] = {"baseline", "A_7.5", "B_50", "A_7.5", "B_50"};

struct PhaseResult {
  uint64_t sleepUs;
  uint32_t sleepOk, sleepFailed, measuredMs, samples, gaugeErrors, matching;
  int32_t sumMa;
  int16_t minMa, maxMa;
  uint16_t firstMv, lastMv, intervalMin, intervalMax, latencyMin, latencyMax;
  int16_t btLsHeld; // -1 means the lock snapshot could not be read
  uint8_t status;  // 0 unstarted, 1 settling, 2 measuring, 3 complete, 4 aborted
};

struct TestRecord {
  uint32_t magic;
  uint8_t state; // 0 waiting, 1 running, 2 complete, 3 aborted
  uint8_t phase, completed, abortReason; // 1 USB, 2 link, 3 reset, 4 camera, 5 storage
  int rtcClock, btClock;
  char captureElfSha256[65];
  uint8_t captureFallbackAllowed;
  PhaseResult results[PHASES];
};
static_assert(sizeof(TestRecord) < 2048, "Keep the flash checkpoint small");
// RTC preserves the in-progress phase over software resets. Completed phases
// are additionally checkpointed to NVS, outside all measurement windows.
RTC_NOINIT_ATTR static TestRecord record;
static uint32_t readySince = 0, phaseStarted = 0, measureStarted = 0, lastSample = 0;
static SleepTotals measureBase = {};
static bool wasUsb = false;
static esp_pm_lock_handle_t retrievalLock = nullptr;
static bool retrievalAwake = false;
static bool restoredFromFlash = false;
static esp_err_t storageStatus = ESP_ERR_NVS_NOT_FOUND;
static esp_err_t retrievalStatus = ESP_OK;

static bool validRecord(const TestRecord& saved) {
  if (saved.magic != TEST_MAGIC || saved.state > 3 || saved.phase > PHASES ||
      saved.completed > PHASES || saved.abortReason > 5 ||
      saved.captureElfSha256[64] != '\0' || saved.captureFallbackAllowed > 1) return false;
  if (saved.state == 2 && (saved.completed != PHASES || saved.phase != PHASES)) return false;
  if (saved.state == 1 && saved.phase >= PHASES) return false;
  if (saved.state == 0 && (saved.phase != 0 || saved.completed != 0)) return false;
  for (unsigned i = 0; i < PHASES; ++i) {
    if (saved.results[i].status > 4) return false;
    if (i < saved.completed && saved.results[i].status != 3) return false;
  }
  return true;
}

static bool saveRecord() {
  nvs_handle_t handle;
  storageStatus = nvs_open("blinks-pwr", NVS_READWRITE, &handle);
  if (storageStatus != ESP_OK) return false;
  storageStatus = nvs_set_blob(handle, "record-v2", &record, sizeof(record));
  if (storageStatus == ESP_OK) storageStatus = nvs_commit(handle);
  nvs_close(handle);
  return storageStatus == ESP_OK;
}

static bool loadRecord() {
  nvs_handle_t handle;
  storageStatus = nvs_open("blinks-pwr", NVS_READONLY, &handle);
  if (storageStatus != ESP_OK) return false;
  TestRecord saved = {};
  size_t bytes = sizeof(saved);
  storageStatus = nvs_get_blob(handle, "record-v2", &saved, &bytes);
  nvs_close(handle);
  if (storageStatus != ESP_OK) return false;
  if (bytes != sizeof(saved) || !validRecord(saved)) {
    storageStatus = ESP_ERR_INVALID_STATE;
    return false;
  }
  record = saved;
  restoredFromFlash = true;
  return true;
}

static void setRetrievalAwake(bool awake) {
  if (awake == retrievalAwake) return;
  if (!retrievalLock) {
    retrievalStatus = esp_pm_lock_create(ESP_PM_NO_LIGHT_SLEEP, 0,
                                        "test-retrieve", &retrievalLock);
    if (retrievalStatus != ESP_OK) return;
  }
  retrievalStatus = awake ? esp_pm_lock_acquire(retrievalLock)
                          : esp_pm_lock_release(retrievalLock);
  if (retrievalStatus == ESP_OK) retrievalAwake = awake;
}

static void abortTest(uint8_t reason) {
  record.abortReason = reason;
  record.state = 3;
  if (record.phase < PHASES) record.results[record.phase].status = 4;
  setRetrievalAwake(true);
  saveRecord();
}

static void stampCaptureBuild() {
  record.rtcClock = (int)rtc_clk_slow_src_get();
  record.btClock = (int)esp_bt_get_lpclk_src();
  const esp_app_desc_t* app = esp_app_get_description();
  for (unsigned i = 0; i < 32; ++i)
    snprintf(record.captureElfSha256 + i * 2, 3, "%02x", app->app_elf_sha256[i]);
#if CONFIG_BT_CTRL_MAIN_XTAL_PU_DURING_LIGHT_SLEEP
  record.captureFallbackAllowed = 1;
#else
  record.captureFallbackAllowed = 0;
#endif
}

static void initializeRecord() {
  memset(&record, 0, sizeof(record));
  record.magic = TEST_MAGIC;
  stampCaptureBuild();
  readySince = 0;
  restoredFromFlash = false;
}

static void resetTest() {
  initializeRecord();
  // Do not run a fresh test if its starting state could not be checkpointed.
  if (!saveRecord()) { abortTest(5); return; }
  setRetrievalAwake(false);
  if (retrievalAwake) abortTest(5);
}

static void snapshotSleep(PhaseResult& row, uint32_t now) {
  const SleepTotals total = readSleepTotals();
  row.sleepOk = total.ok - measureBase.ok;
  row.sleepFailed = total.failed - measureBase.failed;
  row.sleepUs = total.elapsedUs - measureBase.elapsedUs;
  row.measuredMs = now - measureStarted;
}

// Read the lock while still on battery. Looking only after attaching USB would
// introduce a new USB no-light-sleep lock into the experiment.
static int16_t readBtLsLock() {
  char buffer[2048] = {};
  FILE* stream = fmemopen(buffer, sizeof(buffer) - 1, "w");
  if (!stream) return -1;
  const esp_err_t err = esp_pm_dump_locks(stream);
  fflush(stream);
  const bool truncated = ftell(stream) >= (long)sizeof(buffer) - 2 || ferror(stream);
  fclose(stream);
  if (err != ESP_OK || truncated) return -1;
  for (char* line = strtok(buffer, "\n"); line; line = strtok(nullptr, "\n")) {
    char name[32], type[32];
    int argument, active;
    if (sscanf(line, "%31s %31s %d %d", name, type, &argument, &active) == 4 &&
        strcmp(name, "btLS") == 0) return active;
  }
  return 0;
}

static void beginPhase() {
  PhaseResult& row = record.results[record.phase];
  row = {};
  row.status = 1;
  row.minMa = INT16_MAX;
  row.maxMa = INT16_MIN;
  row.intervalMin = row.latencyMin = UINT16_MAX;
  row.btLsHeld = -1;
  // Saves the preceding completed rows too. Flash writes happen before the
  // settling interval, never inside the current/sleep measurement window.
  if (!saveRecord()) { abortTest(5); return; }
  const uint16_t units = TARGET_INTERVALS[record.phase];
  if (units) {
    const NimBLEConnInfo info = server->getPeerInfo((uint8_t)0);
    // Hold latency at zero in both A and B to isolate the interval variable.
    server->updateConnParams(info.getConnHandle(), units, units, 0, 600);
  }
  phaseStarted = millis();
}

static void printReport() {
  const esp_app_desc_t* app = esp_app_get_description();
  Serial.println("\n===== BLINKS POWER TEST v2: camera parked, no photos =====");
  Serial.printf("BLE address: %s | IDF: %s | built: %s %s\n",
                NimBLEDevice::getAddress().toString().c_str(), app->idf_ver, app->date, app->time);
  Serial.print("ELF SHA256: ");
  for (uint8_t byte : app->app_elf_sha256) Serial.printf("%02x", byte);
  Serial.println();
  Serial.printf("Capture ELF SHA256: %s | capture fallback allowed=%u\n",
                record.captureElfSha256, record.captureFallbackAllowed);
  Serial.printf("PM configure result=%d | RTC slow source=%d (external32k=%d) | BT sleep clock=%d (external32k=%d)\n",
                lightSleepStatus, record.rtcClock, (int)SOC_RTC_SLOW_CLK_SRC_XTAL32K,
                record.btClock, (int)ESP_BT_SLEEP_CLOCK_EXT_32K_XTAL);
#if CONFIG_BT_CTRL_MAIN_XTAL_PU_DURING_LIGHT_SLEEP
  Serial.println("Main-crystal light-sleep fallback: ALLOWED (fallback test)");
#else
  Serial.println("Main-crystal light-sleep fallback: DISALLOWED (control test)");
#endif
  Serial.printf("state=%s completed=%u/5 abort_reason=%u (1 USB, 2 link, 3 reset, 4 camera, 5 storage/arm)\n",
                record.state == 0 ? "WAITING" : record.state == 1 ? "RUNNING" :
                record.state == 2 ? "COMPLETE" : "ABORTED", record.completed, record.abortReason);
  Serial.printf("flash_status=%s restored_from_flash=%u retrieval_awake=%u retrieval_status=%s\n",
                esp_err_to_name(storageStatus), restoredFromFlash, retrievalAwake,
                esp_err_to_name(retrievalStatus));
  Serial.println("phase,status,n,mean_mA,min_mA,max_mA,start_mV,end_mV,interval_min_ms,interval_max_ms,lat_min,lat_max,target_match_n,sleep_ok,sleep_failed,sleep_call_ms,measured_ms,btLS_held,gauge_errors");
  for (unsigned i = 0; i < PHASES; ++i) {
    const PhaseResult& r = record.results[i];
    if (!r.status) continue;
    Serial.printf("%s,%u,%lu,%.2f,%d,%d,%u,%u,%.2f,%.2f,%u,%u,%lu,%lu,%lu,%llu,%lu,%d,%lu\n",
                  PHASE_NAMES[i], r.status, (unsigned long)r.samples,
                  r.samples ? (double)r.sumMa / r.samples : 0.0,
                  r.samples ? r.minMa : 0, r.samples ? r.maxMa : 0,
                  r.firstMv, r.lastMv, r.samples ? r.intervalMin * 1.25 : 0.0,
                  r.intervalMax * 1.25, r.samples ? r.latencyMin : 0, r.latencyMax,
                  (unsigned long)r.matching, (unsigned long)r.sleepOk,
                  (unsigned long)r.sleepFailed, (unsigned long long)(r.sleepUs / 1000),
                  (unsigned long)r.measuredMs, r.btLsHeld, (unsigned long)r.gaugeErrors);
  }
  Serial.println("status: 1 settling, 2 measuring, 3 complete, 4 aborted. Compare only complete phases with n>0 and target_match_n=n.");
  Serial.println("sleep_ok counts successful IDF sleep calls. sleep_call_ms INCLUDES entry/exit overhead; it is NOT physical time asleep.");
  Serial.println("Commands: d = report; r = replace the saved result and arm another test (USB only).");
  Serial.println("Completed phases are saved to flash outside measurement windows. Power loss can discard the unfinished phase; an interrupted test never resumes automatically.");
  Serial.println("After completion/abort the CPU stays awake for USB retrieval. Current after the test is NOT a measurement phase.");
  Serial.println("Starts after USB is unplugged and the phone is connected. Five 2-minute phases; first 20 s of each excluded. Reconnect USB after 11 minutes.");
  Serial.println("===== END POWER TEST =====");
}

void setup() {
  const bool restoreRtc = esp_reset_reason() != ESP_RST_POWERON && validRecord(record);
  productionSetup();
  const bool restored = restoreRtc || loadRecord();
  if (!restored && storageStatus == ESP_ERR_NVS_NOT_FOUND) resetTest();
  else if (!restored) {
    // An unreadable saved result requires an explicit 'r'; never overwrite it
    // merely because startup could not read or validate it.
    initializeRecord();
    record.state = 3;
    record.abortReason = 5;
    setRetrievalAwake(true);
  }
  else if (record.state == 1) abortTest(3);
  else {
    saveRecord();
    if (record.state == 2 || record.state == 3) setRetrievalAwake(true);
  }
  wasUsb = usb_serial_jtag_is_connected();
  printReport();
}

void loop() {
  updateStatusLed();
  const uint32_t now = millis();
  const bool usb = usb_serial_jtag_is_connected();
  const bool linked = connected && server->getConnectedCount() == 1;
  if (record.state == 1 && (usb || !linked || !cameraInStandby ||
                           digitalRead(PWDN_GPIO_NUM) != CAMERA_PWDN_ASSERTED)) {
    abortTest(usb ? 1 : !linked ? 2 : 4);
  }
  if (usb && !wasUsb && Serial) printReport();
  wasUsb = usb;
  while (Serial.available()) {
    const int command = Serial.read();
    if (command == 'r' && usb) { resetTest(); printReport(); }
    else if (command == 'd' || command == '\n') printReport();
  }
  if (record.state == 0) {
    if (!usb && linked && statusLedPhase == LED_DONE) {
      if (!readySince) readySince = now;
      if (now - readySince >= 5000) {
        stampCaptureBuild();
        record.state = 1;
        beginPhase();
      }
    } else readySince = 0;
  } else if (record.state == 1) {
    PhaseResult& row = record.results[record.phase];
    if (row.status == 1 && now - phaseStarted >= SETTLE_MS) {
      measureBase = readSleepTotals();
      measureStarted = now;
      lastSample = now;
      row.status = 2;
    }
    if (row.status == 2) {
      snapshotSleep(row, now);
      if (now - lastSample >= 1073) {
        lastSample = now;
        uint16_t mv, rawMa;
        if (fuelGaugeRead16(FUEL_REG_VOLTAGE, mv) && fuelGaugeRead16(FUEL_REG_CURRENT, rawMa)) {
          const int16_t ma = (int16_t)rawMa;
          const NimBLEConnInfo info = server->getPeerInfo((uint8_t)0);
          const uint16_t interval = info.getConnInterval(), latency = info.getConnLatency();
          if (!row.samples) row.firstMv = mv;
          row.lastMv = mv;
          row.sumMa += ma;
          row.minMa = min(row.minMa, ma); row.maxMa = max(row.maxMa, ma);
          row.intervalMin = min(row.intervalMin, interval); row.intervalMax = max(row.intervalMax, interval);
          row.latencyMin = min(row.latencyMin, latency); row.latencyMax = max(row.latencyMax, latency);
          ++row.samples;
          if (!TARGET_INTERVALS[record.phase] ||
              (interval == TARGET_INTERVALS[record.phase] && latency == 0)) ++row.matching;
        } else ++row.gaugeErrors;
      }
      if (now - phaseStarted >= PHASE_MS) {
        row.btLsHeld = readBtLsLock();
        row.status = 3;
        ++record.completed;
        if (++record.phase == PHASES) {
          record.state = 2;
          setRetrievalAwake(true);
          if (!saveRecord()) abortTest(5);
        } else beginPhase();
      }
    }
  }
  delay(loopIdleDelayMs());
}
#endif // BLINKS_POWER_TEST
