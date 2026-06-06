#include <Arduino.h>
#include "esp_camera.h"
#include <WiFi.h>
#include <WebSocketsClient.h>
#include <time.h>
#include <sys/time.h>

// ===========================================================================
// Select camera model in board_config.h
// Copy board_config.h AND camera_pins.h from the CameraWebServer example
// into this sketch folder. board_config.h must have:
//   #define CAMERA_MODEL_XIAO_ESP32S3
// (Reusing your working files guarantees the correct pin mapping.)
// ===========================================================================
#include "board_config.h"

// ===========================================================================
// WiFi credentials (local development: phone hotspot, 2.4 GHz)
// ===========================================================================
const char *ssid = "vivo X200 Pro mini";
const char *password = "zebrastreifen";

// ===========================================================================
// Server (your laptop in the same hotspot).
// IP found via:  ipconfig getifaddr en0
// ===========================================================================
const char *serverHost = "10.80.121.43";
const uint16_t serverPort = 3000;

// ===========================================================================
// Status LED (XIAO ESP32S3 on-board user LED on GPIO21, active-LOW: LOW = lit).
// GPIO21 is unused by the XIAO_ESP32S3 camera pin map (verified in
// camera_pins.h). Three states:
//   fast 2 Hz blink = searching for the server (powered, not connected)
//   solid on        = connected to the server, idle/paused
//   slow 1 Hz blink = recording
// ===========================================================================
#define LED_PIN 21

// ===========================================================================
// No participant here. The firmware is identical on every unit. The device
// identifies itself by MAC; the participant is assigned on the server.
// ===========================================================================
String deviceId;

const unsigned long captureIntervalMs = 1000; // one frame per second

WebSocketsClient webSocket;
bool wsConnected = false;
// Server-controlled pause flag. Set/cleared by "pause"/"resume" text messages
// from the server. Reset on disconnect so the server's reconnect handshake is
// the only authority on whether to record.
bool paused = false;
unsigned long lastCapture = 0;
unsigned long frameCounter = 0;

// Current epoch time in milliseconds (valid only after NTP sync).
uint64_t captureEpochMs() {
  struct timeval tv;
  gettimeofday(&tv, nullptr);
  return (uint64_t)tv.tv_sec * 1000ULL + (uint64_t)(tv.tv_usec / 1000);
}

// User LED (GPIO21) is active-low on the XIAO ESP32S3: LOW lights it, HIGH off.
void setLed(bool on) { digitalWrite(LED_PIN, on ? LOW : HIGH); }

// Status LED state machine (called from loop() and the blocking setup loops):
//   not connected           -> fast 2 Hz blink (searching for the server)
//   connected + paused/idle -> solid on
//   connected + recording   -> slow 1 Hz blink
void updateStatusLed() {
  if (!wsConnected) {
    setLed((millis() / 250) % 2 == 0); // 2 Hz: looking for server connection
  } else if (paused) {
    setLed(true);                      // solid: connected, idle/paused
  } else {
    setLed((millis() / 500) % 2 == 0); // 1 Hz: recording
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

void onWsEvent(WStype_t type, uint8_t *payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      wsConnected = true;
      Serial.println("WebSocket connected");
      break;
    case WStype_DISCONNECTED:
      wsConnected = false;
      paused = false;
      Serial.println("WebSocket disconnected");
      break;
    case WStype_TEXT:
      if (length == 5 && memcmp(payload, "pause", 5) == 0) {
        paused = true;
        Serial.println("Paused by server");
      } else if (length == 6 && memcmp(payload, "resume", 6) == 0) {
        paused = false;
        Serial.println("Resumed by server");
      } else {
        Serial.printf("Server text: %.*s\n", (int)length, payload);
      }
      break;
    default:
      break;
  }
}

void syncTime() {
  // UTC, no offset. We only read absolute epoch time via gettimeofday().
  configTime(0, 0, "pool.ntp.org", "time.nist.gov");
  Serial.print("Syncing time via NTP");
  int tries = 0;
  while (time(nullptr) < 1700000000 && tries < 40) { // ~8s max
    updateStatusLed(); // fast blink: still searching (WS not up yet)
    delay(200);
    Serial.print(".");
    tries++;
  }
  if (time(nullptr) < 1700000000) {
    Serial.println("\nWARNING: NTP sync failed, timestamps will be inaccurate");
  } else {
    Serial.println("\nTime synced");
  }
}

void setup() {
  Serial.begin(115200);
  Serial.setDebugOutput(true);
  Serial.println();

  // Drive the status LED from boot. It starts fast-blinking ("searching")
  // and stays that way until the WebSocket connects.
  pinMode(LED_PIN, OUTPUT);
  updateStatusLed();

  if (!initCamera()) {
    Serial.println("Halting due to camera init failure");
    while (true) {
      delay(1000);
    }
  }

  WiFi.begin(ssid, password);
  WiFi.setSleep(false);

  Serial.print("WiFi connecting");
  while (WiFi.status() != WL_CONNECTED) {
    updateStatusLed(); // fast blink: not connected yet
    delay(250);
    Serial.print(".");
  }
  Serial.println();
  Serial.println("WiFi connected, IP: " + WiFi.localIP().toString());

  syncTime();

  // Device identity from MAC, colons removed, e.g. B8F862FC5070
  deviceId = WiFi.macAddress();
  deviceId.replace(":", "");
  Serial.println("Device ID: " + deviceId);

  String wsPath = "/camera/" + deviceId;
  Serial.println("Connecting to ws://" + String(serverHost) + ":" +
                 String(serverPort) + wsPath);

  webSocket.begin(serverHost, serverPort, wsPath);
  webSocket.onEvent(onWsEvent);
  webSocket.setReconnectInterval(2000);
  // Protocol-level ping/pong keeps the link alive and detects drops.
  webSocket.enableHeartbeat(15000, 3000, 2);
}

void loop() {
  webSocket.loop();

  updateStatusLed();

  if (wsConnected && !paused && millis() - lastCapture >= captureIntervalMs) {
    lastCapture = millis();

    camera_fb_t *fb = esp_camera_fb_get();
    if (!fb) {
      Serial.println("Capture failed");
      return;
    }

    frameCounter++;

    // Send capture metadata first, then the binary frame. Message order is
    // guaranteed within a single WebSocket connection, so the server can pair
    // the timestamp with the frame that follows it.
    char meta[64];
    snprintf(meta, sizeof(meta), "{\"t\":%llu,\"n\":%lu}",
             (unsigned long long)captureEpochMs(),
             (unsigned long)frameCounter);
    webSocket.sendTXT(meta);

    bool sent = webSocket.sendBIN(fb->buf, fb->len);
    if (!sent) {
      Serial.println("Send failed (send buffer full?)");
    }

    esp_camera_fb_return(fb);
  }
}
