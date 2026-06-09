#include <Arduino.h>
#include "esp_camera.h"
#include <NimBLEDevice.h>

// ===========================================================================
// BLINKS feasibility spike — ESP32-S3 BLE camera peripheral.
//
// Captures one VGA JPEG every CAPTURE_INTERVAL_MS and streams it to a connected
// phone over BLE (NimBLE). No WiFi, no NTP, no server. The phone (the companion
// Expo app) reassembles frames and saves them locally. This exists ONLY to test
// whether an Android foreground service can keep the BLE link alive and frames
// flowing while the app is backgrounded overnight.
//
// Requires:
//   - board_config.h + camera_pins.h copied from the CameraWebServer example
//     into THIS folder (with #define CAMERA_MODEL_XIAO_ESP32S3 active), exactly
//     like the existing xiao_camera_ws_client sketch.
//   - Library: "NimBLE-Arduino" (Library Manager). Targets NimBLE 2.x API.
//     (NimBLE is used instead of the built-in Bluedroid BLE because it has a
//     much smaller RAM footprint, which matters next to the camera driver.)
//
// IDE settings: Board XIAO_ESP32S3, PSRAM "OPI PSRAM", Partition "Huge APP".
// ===========================================================================
#include "board_config.h"

// ---- BLE identifiers (must match the app) ---------------------------------
#define DEVICE_NAME       "BLINKS-CAM"
#define SERVICE_UUID      "9a8b7c6d-0001-4a5b-8c9d-0e1f2a3b4c5d"
#define FRAME_CHAR_UUID   "9a8b7c6d-0002-4a5b-8c9d-0e1f2a3b4c5d"
#define CONTROL_CHAR_UUID "9a8b7c6d-0003-4a5b-8c9d-0e1f2a3b4c5d"

// Control opcodes (phone -> camera, single byte written to CONTROL_CHAR_UUID).
#define CONTROL_OP_PAUSE  0x01
#define CONTROL_OP_RESUME 0x02

// One frame every 30 s is the real target. For first bring-up you may want to
// lower this (e.g. 5000) to see frames quickly, then set it back to 30000 for
// the overnight background-reliability run.
#define CAPTURE_INTERVAL_MS 5000
// 30000

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

bool initCamera() {
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
  config.grab_mode = CAMERA_GRAB_LATEST;
  config.fb_location = CAMERA_FB_IN_PSRAM;
  config.jpeg_quality = 12;
  config.fb_count = 2;

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
  return true;
}

class ServerCallbacks : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer* s, NimBLEConnInfo& connInfo) override {
    connected = true;
    Serial.println("Central connected");
  }
  void onDisconnect(NimBLEServer* s, NimBLEConnInfo& connInfo, int reason) override {
    connected = false;
    currentMtu = 23;
    // The phone is the authority for pause state and re-asserts it on every
    // (re)connect, mirroring the server->device semantics of the WiFi pipeline.
    paused = false;
    Serial.printf("Central disconnected (reason %d), re-advertising\n", reason);
    NimBLEDevice::startAdvertising();
  }
  void onMTUChange(uint16_t mtu, NimBLEConnInfo& connInfo) override {
    currentMtu = mtu;
    Serial.printf("MTU negotiated: %u\n", mtu);
  }
};

// Phone -> camera control: a single opcode byte written to CONTROL_CHAR_UUID.
// The phone also drops any frame it receives while paused, covering the race
// between (re)connect and its first control write.
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

// Every notification is tagged so the receiver can always resync:
//   header: [0x01][len BE 4 bytes]      data: [0x02][payload...]
// A dropped/short notification only loses one frame; the next 0x01 header
// resynchronises cleanly (the old untagged framing desynced permanently).
void sendFrame(const uint8_t* buf, size_t len) {
  uint8_t header[5];
  header[0] = 0x01;
  header[1] = (uint8_t)((len >> 24) & 0xFF);
  header[2] = (uint8_t)((len >> 16) & 0xFF);
  header[3] = (uint8_t)((len >> 8) & 0xFF);
  header[4] = (uint8_t)(len & 0xFF);
  frameChar->setValue(header, 5);
  frameChar->notify();
  delay(8);

  // Use a conservative fixed payload well under the negotiated MTU. Large
  // notifications (~MTU-3) were arriving at the phone with an EMPTY value, so we
  // cap chunks small; the low frame rate makes the extra notifications free.
  // (1 byte is the [0x02] tag, so the notification is maxPayload + 1.)
  const size_t maxPayload = 180;
  static uint8_t out[200];
  for (size_t off = 0; off < len; off += maxPayload) {
    size_t n = (off + maxPayload <= len) ? maxPayload : (len - off);
    out[0] = 0x02;
    memcpy(out + 1, buf + off, n);
    frameChar->setValue(out, n + 1);
    frameChar->notify();
    delay(8); // pace notifications so the stack's queue does not overflow
    if (!connected) return; // bail if the phone dropped mid-frame
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

  NimBLEDevice::init(DEVICE_NAME);
  NimBLEDevice::setMTU(517); // ask for a large MTU; phone also requests it
  NimBLEDevice::setPower(ESP_PWR_LVL_P9);

  server = NimBLEDevice::createServer();
  server->setCallbacks(new ServerCallbacks());

  NimBLEService* svc = server->createService(SERVICE_UUID);
  frameChar = svc->createCharacteristic(FRAME_CHAR_UUID, NIMBLE_PROPERTY::NOTIFY);
  controlChar = svc->createCharacteristic(
      CONTROL_CHAR_UUID, NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR);
  controlChar->setCallbacks(new ControlCallbacks());
  // NimBLE 2.x starts services automatically with the server (svc->start() is a
  // deprecated no-op), so we don't call it.

  NimBLEAdvertising* adv = NimBLEDevice::getAdvertising();
  // A 128-bit service UUID (16 B) + the name overflow the 31-byte advertising
  // packet, which suppressed the name and left the device undiscoverable.
  // Advertise the NAME ONLY (the app matches by name); the service UUID is still
  // in the GATT table and is discovered after connecting.
  adv->setName(DEVICE_NAME);
  bool advOk = NimBLEDevice::startAdvertising();
  Serial.printf("Advertising as %s (ok=%d)\n", DEVICE_NAME, advOk);
}

void loop() {
  updateStatusLed();

  if (connected && !paused && millis() - lastCapture >= CAPTURE_INTERVAL_MS) {
    lastCapture = millis();

    // With slow polling, esp_camera_fb_get() returns a frame the continuously
    // running driver captured up to one interval ago, so the timestamp would
    // say "now" for an image that is CAPTURE_INTERVAL_MS old (misaligned with
    // biosignals). Discard fb_count buffered frames so the next get is fresh.
    for (int i = 0; i < 2; i++) {
      camera_fb_t* stale = esp_camera_fb_get();
      if (stale) esp_camera_fb_return(stale);
    }

    camera_fb_t* fb = esp_camera_fb_get();
    if (!fb) {
      Serial.println("Capture failed");
      return;
    }

    // Copy the JPEG out and return the framebuffer BEFORE the BLE send: large
    // frames (40-54 KB) take seconds over BLE, and holding one of the driver's
    // two buffers that long overflows the pool (cam_hal: FB-OVF).
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

    frameCounter++;
    Serial.printf("Frame %lu: %u bytes, mtu=%u\n",
                  (unsigned long)frameCounter, (unsigned)jpegLen, currentMtu);
    sendFrame(jpegCopy, jpegLen);
    free(jpegCopy);
  }
  delay(10);
}
