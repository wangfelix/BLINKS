#include <Arduino.h>
#include "esp_camera.h"
#include <NimBLEDevice.h>

// BLINKS camera firmware for the custom ESP32-S3 smart-glasses board.
//
// The camera advertises as BLINKS-CAM and sends VGA JPEG frames over BLE to
// blinks-edge-app. The phone timestamps and uploads each frame and writes the
// pause/resume commands exposed by this firmware.
//
// Build requirements:
//   - board_config.h selects the custom glasses camera profile
//   - camera_pins.h maps the camera's data, clock, synchronization, and control
//     signals to the ESP32 GPIO pins
//   - status_led.h drives the LP5815 RGB status LED on the system I2C bus
//   - NimBLE-Arduino 2.x
//   - Arduino board ESP32S3 Dev Module, QSPI PSRAM, 4 MB flash, Huge APP
#include "board_config.h"
#include "status_led.h"

// ---- BLE identifiers (must match the app) ---------------------------------
#define DEVICE_NAME       "BLINKS-CAM"
#define SERVICE_UUID      "9a8b7c6d-0001-4a5b-8c9d-0e1f2a3b4c5d"
#define FRAME_CHAR_UUID   "9a8b7c6d-0002-4a5b-8c9d-0e1f2a3b4c5d"
#define CONTROL_CHAR_UUID "9a8b7c6d-0003-4a5b-8c9d-0e1f2a3b4c5d"

// Control opcodes (phone -> camera, single byte written to CONTROL_CHAR_UUID).
#define CONTROL_OP_PAUSE  0x01
#define CONTROL_OP_RESUME 0x02

// ---- Sampling rate --------------------------------------------------------
// 30 s rather than the bodycam's 15 s: the glasses only reach about four hours
// on the usable half of their 2x200 mAh pack. The server chunks frames into
// clock-aligned 5-minute windows regardless of rate, so this yields ~10 frames
// per VLM chunk instead of ~20 (VLM_CHUNK_MAX_FRAMES is a cap, not a
// requirement). That is a known, accepted difference in the visual evidence
// behind glasses participants' VLM labels versus bodycam participants'.
#define CAPTURE_INTERVAL_MS 30000
#define CAMERA_WARMUP_MS 500

// ---- CPU clock -------------------------------------------------------------
// The bodycam runs at the 240 MHz default. Nothing in this firmware is
// CPU-bound — the sensor compresses the JPEG, capture is DMA, and the BLE burst
// is paced by its own delay() — so the glasses trade clock speed for the idle
// baseline that dominates their battery: the sensor is parked and the radio
// merely holding a connection for ~29 s of every 30 s cycle.
//
// 80 MHz is the floor. On the ESP32-S3, CPU 240/160/80 all keep APB at 80 MHz;
// below that APB follows the CPU and would detune the LEDC-generated 20 MHz
// camera XCLK.
#define CPU_CLOCK_MHZ 80

// ---- BLE connected-idle power --------------------------------------------
// Units follow the BLE specification: interval = 1.25 ms, timeout = 10 ms.
// A 30-50 ms base interval preserves burst throughput. Slave latency lets the
// camera skip up to nine empty events (at most 500 ms idle) without dropping
// the logical connection; queued notifications use the next available event.
#define BLE_CONN_INTERVAL_MIN_UNITS 24
#define BLE_CONN_INTERVAL_MAX_UNITS 40
#define BLE_CONN_SLAVE_LATENCY 9
#define BLE_CONN_TIMEOUT_UNITS 600

// After returning a captured frame, the driver fills its single buffer again.
// Wait for that parked frame before putting the sensor in standby so the
// camera driver is idle while the sensor's internal imaging is suspended.
#define CAMERA_BUFFER_READY_TIMEOUT_MS 500

// ---- Camera standby: hardware PWDN ---------------------------------------
// One of three deliberate divergences from camera-firmware/, alongside the
// 30 s capture interval and the 80 MHz CPU clock above. Everything else in this
// sketch is the same file with a different pin header and LED driver.
//
// The XIAO camera connector exposes no PWDN line, so the bodycam firmware puts
// the sensor to sleep over SCCB. This board wires CAM_PWDN to GPIO9 with a 10k
// pull-up to 2V8 ("PWDN; pulled high to shut down by default unless GPIO pulls
// to LOW" on the schematic), so the sensor is meant to be parked with the pin.
//
// Two reasons to use it here rather than the SCCB path:
//   * The SCCB standby write returns -1 on this board. The register encoding is
//     correct (esp32-camera's set_reg takes the OV2640 bank in bit 8, so 0x0109
//     is bank 1 / COM2), so the failure is in the SCCB transaction itself. A
//     half-applied write left the sensor asleep while the firmware believed it
//     was awake, which stalled every later esp_camera_fb_get().
//   * Hardware power-down gates far more of the sensor than software standby.
//     The glasses enclosure carries a 400 mAh cell against the bodycam's
//     1000 mAh, so the deeper sleep is worth having.
#define CAMERA_PWDN_ASSERTED   HIGH  // OV2640 PWDN is active high
#define CAMERA_PWDN_RELEASED   LOW

// The OV2640 needs a moment after PWDN is released before it answers SCCB.
// The AEC/AWB settling that follows is covered by CAMERA_WARMUP_MS.
#define CAMERA_PWDN_WAKE_SETTLE_MS 10

// The glasses run from a 200 mAh cell at a time and its protection circuit
// latches off on a large enough current step. Switching the LED driver, the
// camera and the radio on back to back stacks three inrush events; this gap
// between them lets the bulk capacitance recover before the next load starts.
#define LOAD_STAGGER_MS 50

// Bank 1 register 0x0A is PIDH and reads 0x26 on a healthy OV2640. Reading it
// after a wake proves the sensor came back before a capture is attempted.
#define OV2640_PIDH_REG   0x010A
#define OV2640_PIDH_VALUE 0x26

static_assert(CAMERA_WARMUP_MS < CAPTURE_INTERVAL_MS,
              "Camera warm-up must be shorter than the capture interval");
static_assert(BLE_CONN_TIMEOUT_UNITS * 4 >
                  BLE_CONN_INTERVAL_MAX_UNITS * (BLE_CONN_SLAVE_LATENCY + 1),
              "BLE supervision timeout is too short for the idle latency");

// The board-specific status LED driver exposes setLed(bool). Fast ~2 Hz blink
// means searching, solid means connected + paused, and slow ~1 Hz means recording.
//
// The indicator is only useful while the participant is putting the glasses on
// and confirming they are recording. After this long it is switched off for the
// rest of the run: on the glasses' 400 mAh cell a permanently blinking LED
// costs a noticeable share of the day's capacity, and nobody is looking at it
// once the device is on someone's face.
#define STATUS_LED_ACTIVE_MS (5UL * 60UL * 1000UL)

// The indicator only has to be *seen*, not lit continuously. Flashing briefly
// at the same cadence as the old 50%-on blink reads the same to a wearer while
// averaging about a tenth of the current. loop() polls every ~10 ms, so the
// flash window must stay comfortably above that to never be skipped.
#define STATUS_LED_FLASH_MS          50UL
#define STATUS_LED_SEARCH_PERIOD_MS  500UL   // searching for a phone
#define STATUS_LED_RECORD_PERIOD_MS  1000UL  // connected and recording

NimBLEServer*         server      = nullptr;
NimBLECharacteristic* frameChar   = nullptr;
NimBLECharacteristic* controlChar = nullptr;
volatile bool         connected   = false;
volatile bool         paused      = false;
volatile uint16_t     currentMtu  = 23;   // updated on negotiation
unsigned long         lastCapture = 0;
uint32_t              frameCounter = 0;
sensor_t*             cameraSensor = nullptr;
bool                  cameraStandbySupported = false;
bool                  cameraInStandby = false;
bool                  cameraWarming = false;
unsigned long         cameraWakeStarted = 0;

// Status LED, driven each loop():
//   not connected      -> short flash twice a second (searching for a phone)
//   connected + paused -> solid on
//   connected          -> short flash once a second (recording + sending)
void updateStatusLed() {
  // Past the indicator window the LED stays dark whatever the recording state
  // is. setLed() is a no-op once the LED is already off, so this costs one I2C
  // write, not one per loop.
  if (millis() >= STATUS_LED_ACTIVE_MS) {
    setLed(false);
    return;
  }
  if (!connected) {
    setLed(millis() % STATUS_LED_SEARCH_PERIOD_MS < STATUS_LED_FLASH_MS);
  } else if (paused) {
    setLed(true);  // solid, so pause stays unmistakable against the flashes
  } else {
    setLed(millis() % STATUS_LED_RECORD_PERIOD_MS < STATUS_LED_FLASH_MS);
  }
}

void resetCameraPowerState() {
  cameraSensor = nullptr;
  cameraStandbySupported = false;
  cameraInStandby = false;
  cameraWarming = false;
  cameraWakeStarted = 0;
}

void configureCameraPowerControl(sensor_t* sensor) {
  cameraSensor = sensor;
  cameraInStandby = false;
  cameraWarming = false;
  cameraWakeStarted = 0;
  // esp_camera_init() already drives PWDN low to power the sensor up; claim the
  // pin so the firmware can park the sensor between captures.
  cameraStandbySupported = sensor && sensor->get_reg &&
      sensor->id.PID == OV2640_PID && PWDN_GPIO_NUM >= 0;
  if (cameraStandbySupported) {
    pinMode(PWDN_GPIO_NUM, OUTPUT);
    digitalWrite(PWDN_GPIO_NUM, CAMERA_PWDN_RELEASED);
  }

  if (!sensor) {
    Serial.println("Camera sensor unavailable; standby disabled");
    return;
  }

  Serial.printf("Camera sensor PID: 0x%04x (%s)\n", (unsigned)sensor->id.PID,
                cameraStandbySupported ? "hardware PWDN standby on GPIO9"
                                       : "no standby");
}

// True when the sensor answers SCCB with the expected OV2640 product ID. Used
// after a wake so a sensor that did not come back is caught before a capture is
// attempted, which routes into the existing reinitialization path.
bool cameraAnswersOverSccb() {
  if (!cameraSensor || !cameraSensor->get_reg) return false;
  return cameraSensor->get_reg(cameraSensor, OV2640_PIDH_REG, 0xFF) ==
         OV2640_PIDH_VALUE;
}

bool setCameraStandby(bool standby) {
  if (!cameraStandbySupported || !cameraSensor) return false;
  if (cameraInStandby == standby) return true;

  if (standby) {
    digitalWrite(PWDN_GPIO_NUM, CAMERA_PWDN_ASSERTED);
    cameraInStandby = true;
    cameraWarming = false;
    Serial.println("Camera standby");
    return true;
  }

  digitalWrite(PWDN_GPIO_NUM, CAMERA_PWDN_RELEASED);
  delay(CAMERA_PWDN_WAKE_SETTLE_MS);
  if (!cameraAnswersOverSccb()) {
    // Leave cameraInStandby set so the caller reinitializes rather than
    // capturing from a sensor that never came back.
    Serial.println("Camera wake failed: no SCCB answer after PWDN release");
    return false;
  }

  cameraInStandby = false;
  // Cheap insurance: re-apply the resolution the capture loop expects. It is a
  // no-op when the sensor retained its registers across power-down, and repairs
  // the one setting that matters if a module revision does not.
  if (cameraSensor->set_framesize) {
    cameraSensor->set_framesize(cameraSensor, FRAMESIZE_VGA);
  }
  Serial.printf("Camera awake; warming for %u ms\n",
                (unsigned)CAMERA_WARMUP_MS);
  return true;
}

bool waitForBufferedFrame(unsigned long timeoutMs) {
  unsigned long started = millis();
  do {
    if (esp_camera_available_frames()) return true;
    if (timeoutMs == 0) return false;
    delay(5);
  } while (millis() - started < timeoutMs);
  return esp_camera_available_frames();
}

bool enterCameraStandby(unsigned long bufferTimeoutMs) {
  if (!cameraStandbySupported) return false;
  if (cameraInStandby) return true;
  if (!waitForBufferedFrame(bufferTimeoutMs)) return false;

  if (!setCameraStandby(true)) {
    // A failed standby write leaves the sensor awake. Keep capture working and
    // disable further standby attempts until the camera is reinitialized.
    cameraStandbySupported = false;
    Serial.println("Camera standby disabled until reinitialization");
    return false;
  }
  return true;
}

// Park the sensor before another load switches on, waiting briefly for the
// driver to buffer a frame but powering the sensor down regardless if it does
// not. A driver wedge is recoverable through recoverCameraIfWedged(); a
// simultaneous camera-plus-radio draw is a current spike we cannot take back.
void parkCameraNow(unsigned long bufferTimeoutMs) {
  if (!cameraStandbySupported || cameraInStandby) return;
  if (enterCameraStandby(bufferTimeoutMs)) return;
  Serial.println("Buffer wait timed out; powering the sensor down anyway");
  setCameraStandby(true);
}

bool initCamera() {
  resetCameraPowerState();

  // Zero new/optional esp32-camera fields as well as the pins configured below.
  camera_config_t config = {};
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer = LEDC_TIMER_0;
  config.pin_d0 = Y2_GPIO_NUM;
  config.pin_d1 = Y3_GPIO_NUM;
  config.pin_d2 = Y4_GPIO_NUM;
  config.pin_d3 = Y5_GPIO_NUM;
  config.pin_d4 = Y6_GPIO_NUM;
  config.pin_d5 = Y7_GPIO_NUM;
  config.pin_d6 = Y8_GPIO_NUM;
  config.pin_d7 = Y9_GPIO_NUM;
  config.pin_xclk = XCLK_GPIO_NUM;
  config.pin_pclk = PCLK_GPIO_NUM;
  config.pin_vsync = VSYNC_GPIO_NUM;
  config.pin_href = HREF_GPIO_NUM;
  config.pin_sccb_sda = SIOD_GPIO_NUM;
  config.pin_sccb_scl = SIOC_GPIO_NUM;
  config.pin_pwdn = PWDN_GPIO_NUM;
  config.pin_reset = RESET_GPIO_NUM;
  config.xclk_freq_hz = 20000000;
  config.frame_size = FRAMESIZE_VGA; // 640x480
  config.pixel_format = PIXFORMAT_JPEG;
  // Keep one frame buffered between scheduled captures. GRAB_WHEN_EMPTY avoids
  // continuously replacing full buffers while the firmware waits for the next
  // capture interval.
  config.grab_mode = CAMERA_GRAB_WHEN_EMPTY;
  config.fb_location = CAMERA_FB_IN_PSRAM;
  config.jpeg_quality = 12;
  config.fb_count = 1;

  if (!psramFound()) {
    config.fb_location = CAMERA_FB_IN_DRAM;
    config.fb_count = 1;
    config.jpeg_quality = 15;
  }

  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("Camera init failed with error 0x%x\n", err);
    return false;
  }
  sensor_t *s = esp_camera_sensor_get();
  s->set_framesize(s, FRAMESIZE_VGA);
  configureCameraPowerControl(s);
  return true;
}

// Bring the camera driver back up after a failure, holding the sensor in
// power-down across the gap so the reinitialization inrush never lands on top
// of whatever the radio is doing. esp_camera_init() releases PWDN itself.
bool restartCameraDriver() {
  esp_camera_deinit();
  if (PWDN_GPIO_NUM >= 0) {
    pinMode(PWDN_GPIO_NUM, OUTPUT);
    digitalWrite(PWDN_GPIO_NUM, CAMERA_PWDN_ASSERTED);
  }
  resetCameraPowerState();
  delay(100);
  return initCamera();
}

bool wakeCameraForCapture() {
  if (!cameraStandbySupported || !cameraInStandby) return true;

  if (!setCameraStandby(false)) {
    // If a sensor accepted standby but cannot be woken over SCCB, reset the
    // driver so recording can continue instead of remaining stuck asleep.
    Serial.println("Camera wake failed, reinitializing driver");
    if (!restartCameraDriver()) {
      Serial.println("Camera reinit after wake failure FAILED");
      return false;
    }
  }

  cameraWarming = true;
  cameraWakeStarted = millis();
  return true;
}

// Reinitialize the camera after three consecutive capture failures so an
// unattended recording can continue without a power cycle.
uint8_t captureFailures = 0;
void recoverCameraIfWedged() {
  if (++captureFailures < 3) return;
  Serial.println("Camera unresponsive, reinitializing driver");
  Serial.println(restartCameraDriver() ? "Camera reinitialized"
                                       : "Camera reinit FAILED");
  captureFailures = 0;
}

class ServerCallbacks : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer* s, NimBLEConnInfo& connInfo) override {
    connected = true;
    Serial.printf("Central connected: interval=%.2f ms, latency=%u, timeout=%u ms\n",
                  connInfo.getConnInterval() * 1.25f,
                  connInfo.getConnLatency(),
                  connInfo.getConnTimeout() * 10);
    s->updateConnParams(connInfo.getConnHandle(),
                        BLE_CONN_INTERVAL_MIN_UNITS,
                        BLE_CONN_INTERVAL_MAX_UNITS,
                        BLE_CONN_SLAVE_LATENCY,
                        BLE_CONN_TIMEOUT_UNITS);
  }
  void onDisconnect(NimBLEServer* s, NimBLEConnInfo& connInfo, int reason) override {
    connected = false;
    currentMtu = 23;
    // A disconnected camera defaults to recording. If the app is paused, it
    // sends the pause command again after reconnecting.
    paused = false;
    Serial.printf("Central disconnected (reason %d), re-advertising\n", reason);
    NimBLEDevice::startAdvertising();
  }
  void onMTUChange(uint16_t mtu, NimBLEConnInfo& connInfo) override {
    currentMtu = mtu;
    Serial.printf("MTU negotiated: %u\n", mtu);
  }
  void onConnParamsUpdate(NimBLEConnInfo& connInfo) override {
    Serial.printf("BLE low-power parameters: interval=%.2f ms, latency=%u, timeout=%u ms\n",
                  connInfo.getConnInterval() * 1.25f,
                  connInfo.getConnLatency(),
                  connInfo.getConnTimeout() * 10);
  }
};

// The app writes a single pause or resume opcode to CONTROL_CHAR_UUID.
class ControlCallbacks : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* c, NimBLEConnInfo& connInfo) override {
    NimBLEAttValue value = c->getValue();
    if (value.size() < 1) return;
    switch (value[0]) {
      case CONTROL_OP_PAUSE:
        paused = true;
        Serial.println("Control: pause");
        break;
      case CONTROL_OP_RESUME:
        paused = false;
        Serial.println("Control: resume");
        break;
      default:
        Serial.printf("Control: unknown opcode 0x%02x\n", value[0]);
    }
  }
};

// BLE frame protocol:
//   header  [0x01][JPEG length, 4-byte big-endian][frame counter, 4-byte BE]
//   payload [0x02][up to 180 JPEG bytes]
// The tags let the app find the next frame boundary after a dropped
// notification. Gaps in the frame counter identify complete frames that did
// not reach the app.
void sendFrame(const uint8_t* buf, size_t len) {
  uint8_t header[9];
  header[0] = 0x01;
  header[1] = (uint8_t)((len >> 24) & 0xFF);
  header[2] = (uint8_t)((len >> 16) & 0xFF);
  header[3] = (uint8_t)((len >> 8) & 0xFF);
  header[4] = (uint8_t)(len & 0xFF);
  header[5] = (uint8_t)((frameCounter >> 24) & 0xFF);
  header[6] = (uint8_t)((frameCounter >> 16) & 0xFF);
  header[7] = (uint8_t)((frameCounter >> 8) & 0xFF);
  header[8] = (uint8_t)(frameCounter & 0xFF);
  frameChar->setValue(header, 9);
  frameChar->notify();
  delay(8);

  // A fixed 180-byte payload is reliable on the study phones. The notification
  // is 181 bytes including its 0x02 tag.
  const size_t maxPayload = 180;
  static uint8_t out[200];
  for (size_t off = 0; off < len; off += maxPayload) {
    size_t n = (off + maxPayload <= len) ? maxPayload : (len - off);
    out[0] = 0x02;
    memcpy(out + 1, buf + off, n);
    frameChar->setValue(out, n + 1);
    frameChar->notify();
    delay(8); // Pace notifications to reduce BLE queue pressure.
    if (!connected) return;
  }
}

void setup() {
  Serial.begin(115200);
  Serial.println();

  // Set the clock before anything else initializes, so every peripheral and the
  // BLE controller come up at the frequency they will actually run at.
  setCpuFrequencyMhz(CPU_CLOCK_MHZ);
  Serial.printf("CPU clock: %u MHz\n", (unsigned)getCpuFrequencyMhz());

  // Bring the three big loads up one at a time rather than back to back, and
  // park the sensor before the radio starts, so no two inrush events overlap.
  initStatusLed();
  delay(LOAD_STAGGER_MS);

  if (!initCamera()) {
    Serial.println("Halting due to camera init failure");
    while (true) delay(1000);
  }
  Serial.println("Camera ready");

  parkCameraNow(CAMERA_BUFFER_READY_TIMEOUT_MS);
  delay(LOAD_STAGGER_MS);

  if (!NimBLEDevice::init(DEVICE_NAME)) {
    Serial.println("Halting due to BLE initialization failure");
    while (true) delay(1000);
  }
  esp_err_t bleSleepResult = esp_bt_sleep_enable();
  Serial.printf("BLE modem sleep: %s (0x%x)\n",
                bleSleepResult == ESP_OK ? "enabled" : "UNAVAILABLE",
                (unsigned)bleSleepResult);
  NimBLEDevice::setMTU(517); // The app also requests this MTU after connecting.
  NimBLEDevice::setPower(ESP_PWR_LVL_P9);

  server = NimBLEDevice::createServer();
  server->setCallbacks(new ServerCallbacks());

  NimBLEService* svc = server->createService(SERVICE_UUID);
  frameChar = svc->createCharacteristic(FRAME_CHAR_UUID, NIMBLE_PROPERTY::NOTIFY);
  controlChar = svc->createCharacteristic(
      CONTROL_CHAR_UUID, NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR);
  controlChar->setCallbacks(new ControlCallbacks());

  NimBLEAdvertising* adv = NimBLEDevice::getAdvertising();
  // The device name and 128-bit service UUID do not both fit in the 31-byte
  // advertising packet. The app scans by name and discovers the service after
  // connecting, so only the name is advertised.
  adv->setName(DEVICE_NAME);
  bool advOk = NimBLEDevice::startAdvertising();
  Serial.printf("Advertising as %s (ok=%d)\n", DEVICE_NAME, advOk);
}

void loop() {
  updateStatusLed();

  unsigned long now = millis();
  bool recording = connected && !paused;
  unsigned long sinceLastCapture = now - lastCapture;
  const unsigned long warmupThreshold = CAPTURE_INTERVAL_MS - CAMERA_WARMUP_MS;

  if (!recording) {
    cameraWarming = false;
    enterCameraStandby(0);
    delay(10);
    return;
  }

  // Keep the sensor asleep until the warm-up window begins. This also puts a
  // freshly reinitialized camera back to sleep when the next capture is far
  // enough away.
  if (!cameraInStandby && !cameraWarming &&
      sinceLastCapture < warmupThreshold) {
    enterCameraStandby(0);
  }

  if (cameraInStandby && sinceLastCapture >= warmupThreshold) {
    if (!wakeCameraForCapture()) {
      delay(10);
      return;
    }
  }

  now = millis();
  sinceLastCapture = now - lastCapture;
  bool warmupComplete = !cameraWarming ||
      now - cameraWakeStarted >= CAMERA_WARMUP_MS;

  if (!cameraInStandby && warmupComplete &&
      sinceLastCapture >= CAPTURE_INTERVAL_MS) {
    lastCapture = millis();
    cameraWarming = false;

    // The buffered frame may be one interval old. Returning it lets the
    // WHEN_EMPTY driver capture a current frame for the next get().
    camera_fb_t* stale = esp_camera_fb_get();
    if (stale) esp_camera_fb_return(stale);

    camera_fb_t* fb = esp_camera_fb_get();
    if (!fb) {
      Serial.println("Capture failed");
      recoverCameraIfWedged();
      return;
    }
    captureFailures = 0;

    // Send from a separate buffer so the camera framebuffer can be returned
    // before BLE transmission begins.
    size_t jpegLen = fb->len;
    uint8_t* jpegCopy = (uint8_t*)ps_malloc(jpegLen);
    if (!jpegCopy) jpegCopy = (uint8_t*)malloc(jpegLen);
    if (!jpegCopy) {
      esp_camera_fb_return(fb);
      Serial.printf("Frame copy alloc failed (%u bytes)\n", (unsigned)jpegLen);
      return;
    }
    memcpy(jpegCopy, fb->buf, jpegLen);
    esp_camera_fb_return(fb);

    // The JPEG copy is independent of the camera driver, so the sensor can go
    // down before the slow BLE transmission. This must not be conditional: a
    // camera left powered through the radio burst is exactly the simultaneous
    // draw the cells cannot absorb.
    parkCameraNow(CAMERA_BUFFER_READY_TIMEOUT_MS);

    frameCounter++;
    Serial.printf("Frame %lu: %u bytes, mtu=%u\n",
                  (unsigned long)frameCounter, (unsigned)jpegLen, currentMtu);
    sendFrame(jpegCopy, jpegLen);
    free(jpegCopy);
  }
  delay(10);
}
