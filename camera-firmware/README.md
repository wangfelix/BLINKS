# BLINKS production BLE camera firmware

BLE-peripheral firmware for the XIAO ESP32-S3 Sense. It captures a VGA JPEG
every 15 seconds and sends it to the BLINKS phone app. The camera has no WiFi,
clock synchronization, or direct server connection. Between captures, the
OV2640 or OV3660 sensor uses software standby and wakes 500 ms before the next
photo so automatic exposure and white balance can adjust. The BLE connection
stays established while the controller uses modem sleep and slave latency
between connection events.

## Setup

1. Keep **`board_config.h`** and **`camera_pins.h`** in this folder, with
   `#define CAMERA_MODEL_XIAO_ESP32S3` active in `board_config.h`.
2. Install the **NimBLE-Arduino** library via the Arduino Library Manager
   (targets the 2.x API; NimBLE is used instead of the built-in Bluedroid BLE
   because it leaves enough RAM next to the camera driver).
3. IDE settings (same as the main sketch): Board **XIAO_ESP32S3**, PSRAM
   **"OPI PSRAM"**, Partition **"Huge APP (3MB No OTA / 1MB SPIFFS)"**, Serial
   **115200**.
4. Keep `build_opt.h` and `ble_power_config.h` in this sketch directory.
   ESP32 Arduino 3.3.8 reads `build_opt.h` automatically and initializes the
   Bluetooth controller with modem sleep using the main crystal.
5. Flash.

## What you should see (Serial @ 115200)

```
Camera sensor PID: 0x0026 (using software standby)
Camera ready
BLE modem sleep: enabled (0x0)
Advertising as BLINKS-CAM
Camera standby
Central connected: interval=... ms, latency=..., timeout=... ms
MTU negotiated: 247        (or up to 517)
BLE low-power parameters: interval=... ms, latency=9, timeout=6000 ms
Camera awake; warming for 500 ms
Camera standby
Frame 1: 11873 bytes, mtu=247
Frame 2: ...
```

The on-board LED (GPIO21) blinks quickly while searching for a phone, stays on
while connected and paused, and blinks slowly while recording.

## Tip

`CAPTURE_INTERVAL_MS` is `15000`: one frame every 15 seconds, or 20 frames in a
complete 5-minute VLM window. `CAMERA_WARMUP_MS` is `500`: the sensor retains
its settings in standby, wakes half a second before capture, and returns to
standby before the copied JPEG is sent over BLE. Standby is also used while the
camera is disconnected or recording is paused. BLE remains connected: the
firmware requests a 30-50 ms base interval with latency 9, allowing up to 500 ms
between idle connection events while still waking promptly for a frame or
pause/resume command. The phone controls the final negotiated parameters.
