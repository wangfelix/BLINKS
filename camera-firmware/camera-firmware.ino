#include <Arduino.h>
#include "esp_camera.h"
#include <NimBLEDevice.h>

// BLINKS camera firmware for the XIAO ESP32S3 Sense.
//
// The camera advertises as BLINKS-CAM and sends VGA JPEG frames over BLE to
// blinks-edge-app. The phone timestamps and uploads each frame and writes the
// pause/resume commands exposed by this firmware.
//
// Build requirements:
//   - board_config.h selects the XIAO ESP32S3 Sense camera profile
//   - camera_pins.h maps the camera's data, clock, synchronization, and control
//     signals to the ESP32 GPIO pins
//   - NimBLE-Arduino 2.x
//   - Arduino board XIAO_ESP32S3, OPI PSRAM, Huge APP partition
#include "board_config.h"

// ---- BLE identifiers (must match the app) ---------------------------------
#define DEVICE_NAME       "BLINKS-CAM"
#define SERVICE_UUID      "9a8b7c6d-0001-4a5b-8c9d-0e1f2a3b4c5d"
#define FRAME_CHAR_UUID   "9a8b7c6d-0002-4a5b-8c9d-0e1f2a3b4c5d"
#define CONTROL_CHAR_UUID "9a8b7c6d-0003-4a5b-8c9d-0e1f2a3b4c5d"

// Control opcodes (phone -> camera, single byte written to CONTROL_CHAR_UUID).
#define CONTROL_OP_PAUSE  0x01
#define CONTROL_OP_RESUME 0x02

// ---- Sampling rate --------------------------------------------------------
#define CAPTURE_INTERVAL_MS 15000
#define CAMERA_WARMUP_MS 500

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

// Sensor-specific software-standby registers. The XIAO camera connector does
// not expose a hardware PWDN GPIO, so standby is controlled over SCCB.
#define OV2640_COM2_REG               0x0109
#define OV2640_SOFTWARE_STANDBY_MASK  0x10
#define OV3660_SYSTEM_CONTROL0_REG    0x3008
#define OV3660_SOFTWARE_STANDBY_MASK  0x40

static_assert(CAMERA_WARMUP_MS < CAPTURE_INTERVAL_MS,
              "Camera warm-up must be shorter than the capture interval");
static_assert(BLE_CONN_TIMEOUT_UNITS * 4 >
                  BLE_CONN_INTERVAL_MAX_UNITS * (BLE_CONN_SLAVE_LATENCY + 1),
              "BLE supervision timeout is too short for the idle latency");

// On-board user LED (GPIO21, active-low): fast ~2 Hz blink = searching for a
// phone, solid = connected + paused, slow ~1 Hz blink = connected + recording.
#define LED_PIN 21

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

void setLed(bool on) { digitalWrite(LED_PIN, on ? LOW : HIGH); }

// Status LED, driven each loop():
//   not connected      -> fast ~2 Hz blink (searching for a phone)
//   connected + paused -> solid on
//   connected          -> slow ~1 Hz blink (recording + sending frames)
void updateStatusLed() {
  if (!connected) {
    setLed((millis() / 250) % 2 == 0); // fast ~2 Hz: searching
  } else if (paused) {
    setLed(true);                      // solid: connected, paused
  } else {
    setLed((millis() / 500) % 2 == 0); // slow ~1 Hz: recording
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
  cameraStandbySupported = sensor && sensor->set_reg &&
      (sensor->id.PID == OV2640_PID || sensor->id.PID == OV3660_PID);

  if (!sensor) {
    Serial.println("Camera sensor unavailable; standby disabled");
    return;
  }

  Serial.printf("Camera sensor PID: 0x%04x (%s software standby)\n",
                (unsigned)sensor->id.PID,
                cameraStandbySupported ? "using" : "no");
}

bool setCameraStandby(bool standby) {
  if (!cameraStandbySupported || !cameraSensor) return false;
  if (cameraInStandby == standby) return true;

  int result = -1;
  if (cameraSensor->id.PID == OV2640_PID) {
    result = cameraSensor->set_reg(
        cameraSensor,
        OV2640_COM2_REG,
        OV2640_SOFTWARE_STANDBY_MASK,
        standby ? OV2640_SOFTWARE_STANDBY_MASK : 0);
  } else if (cameraSensor->id.PID == OV3660_PID) {
    result = cameraSensor->set_reg(
        cameraSensor,
        OV3660_SYSTEM_CONTROL0_REG,
        OV3660_SOFTWARE_STANDBY_MASK,
        standby ? OV3660_SOFTWARE_STANDBY_MASK : 0);
  }

  if (result != 0) {
    Serial.printf("Camera %s failed (%d)\n", standby ? "standby" : "wake", result);
    return false;
  }

  cameraInStandby = standby;
  if (standby) {
    cameraWarming = false;
    Serial.println("Camera standby");
  } else {
    Serial.printf("Camera awake; warming for %u ms\n",
                  (unsigned)CAMERA_WARMUP_MS);
  }
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

bool initCamera() {
  resetCameraPowerState();

  camera_config_t config;
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

bool wakeCameraForCapture() {
  if (!cameraStandbySupported || !cameraInStandby) return true;

  if (!setCameraStandby(false)) {
    // If a sensor accepted standby but cannot be woken over SCCB, reset the
    // driver so recording can continue instead of remaining stuck asleep.
    Serial.println("Camera wake failed, reinitializing driver");
    esp_camera_deinit();
    resetCameraPowerState();
    delay(100);
    if (!initCamera()) {
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
  esp_camera_deinit();
  resetCameraPowerState();
  delay(100);
  Serial.println(initCamera() ? "Camera reinitialized" : "Camera reinit FAILED");
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

  pinMode(LED_PIN, OUTPUT);
  setLed(false);

  if (!initCamera()) {
    Serial.println("Halting due to camera init failure");
    while (true) delay(1000);
  }
  Serial.println("Camera ready");

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

    // The JPEG copy is independent of the camera driver. Park one framebuffer
    // and put the sensor back into standby before the slower BLE transmission.
    if (cameraStandbySupported &&
        !enterCameraStandby(CAMERA_BUFFER_READY_TIMEOUT_MS)) {
      Serial.println("Camera stayed awake after capture");
    }

    frameCounter++;
    Serial.printf("Frame %lu: %u bytes, mtu=%u\n",
                  (unsigned long)frameCounter, (unsigned)jpegLen, currentMtu);
    sendFrame(jpegCopy, jpegLen);
    free(jpegCopy);
  }
  delay(10);
}
