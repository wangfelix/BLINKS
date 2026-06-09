# esp32-ble-camera (feasibility firmware)

Minimal BLE-peripheral firmware for the XIAO ESP32-S3 Sense: captures a VGA JPEG
every 30 s and notifies it over BLE. No WiFi/NTP/server.

## Setup

1. Copy **`board_config.h`** and **`camera_pins.h`** into this folder — the same
   two files used by `../../xiao_camera_ws_client/` (with
   `#define CAMERA_MODEL_XIAO_ESP32S3` active in `board_config.h`).
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

The on-board LED (GPIO21) is **on while a phone is connected**.

## Tip

`CAPTURE_INTERVAL_MS` is 30000 (the real target). For first bring-up, drop it to
`5000` so frames show up quickly, then set it back to `30000` for the overnight
background-reliability run (and update `EXPECTED_INTERVAL_MS` in the app to
match).
