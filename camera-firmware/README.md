# BLINKS production BLE camera firmware

BLE-peripheral firmware for the XIAO ESP32-S3 Sense. It captures a VGA JPEG
every 15 seconds and sends it to the BLINKS phone app. The camera has no WiFi,
clock synchronization, or direct server connection.

## Setup

1. Keep **`board_config.h`** and **`camera_pins.h`** in this folder, with
   `#define CAMERA_MODEL_XIAO_ESP32S3` active in `board_config.h`.
2. Install the **NimBLE-Arduino** library via the Arduino Library Manager
   (targets the 2.x API; NimBLE is used instead of the built-in Bluedroid BLE
   because it leaves enough RAM next to the camera driver).
3. IDE settings (same as the main sketch): Board **XIAO_ESP32S3**, PSRAM
   **"OPI PSRAM"**, Partition **"Huge APP (3MB No OTA / 1MB SPIFFS)"**, Serial
   **115200**.
4. Flash.

## What you should see (Serial @ 115200)

```
Camera ready
Advertising as BLINKS-CAM
Central connected
MTU negotiated: 247        (or up to 517)
Frame 1: 11873 bytes, mtu=247
Frame 2: ...
```

The on-board LED (GPIO21) blinks quickly while searching for a phone, stays on
while connected and paused, and blinks slowly while recording.

## Tip

`CAPTURE_INTERVAL_MS` is `15000`: one frame every 15 seconds, or 20 frames in a
complete 5-minute VLM window.
