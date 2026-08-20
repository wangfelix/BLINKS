# BLINKS smart-glasses BLE camera firmware

Firmware for the custom Blinks glasses PCB with an ESP32-S3-MINI-1-N4R2,
TY-OV2640-40MM camera, and LP5815 RGB status LED. The existing
`camera-firmware/` directory remains the independent XIAO ESP32-S3 Sense
bodycam/necklace target.

The glasses use the same phone-facing contract as the existing camera:
`BLINKS-CAM`, the same BLE service and characteristics, VGA JPEG capture every
15 seconds, pause/resume commands, camera recovery, and software standby
between samples.

## Camera GPIO map

| Camera signal | ESP32-S3 GPIO |
| --- | ---: |
| D0 / Y2 | 33 |
| D1 / Y3 | 21 |
| D2 / Y4 | 18 |
| D3 / Y5 | 47 |
| D4 / Y6 | 34 |
| D5 / Y7 | 42 |
| D6 / Y8 | 41 |
| D7 / Y9 | 39 |
| XCLK / XMCLK | 40 |
| PCLK | 48 |
| VSYNC | 37 |
| HREF | 38 |
| SCCB SDA | 35 |
| SCCB SCL | 36 |
| RESET | 8 |
| PWDN | 9 |

These values follow the module symbol's pin names, which the schematic's
**Recomended GPIO Table** repeats verbatim. The blue net labels carry a stale
`IOxx/` prefix left over from the XIAO ESP32-S3 prototype: the wire labelled
`IO35/CAM_RESET` lands on module pin `IO8`, and the wire labelled
`IO40/CAM_SDA` lands on module pin `IO35`. A net label is only a name, so
`camera_pins.h` follows the module pin the wire actually connects to.
`glasses-camera-diagnostic/README.md` tabulates all three numbering systems.

**GPIO33..GPIO37 (Y2, Y6, SDA, SCL, VSYNC) are only free on the -N4R2 variant**,
which has 2 MB quad PSRAM. Octal-PSRAM parts use those pins for the PSRAM bus,
so selecting **OPI PSRAM** instead of **QSPI PSRAM** in the Arduino IDE breaks
five camera signals.

The LP5815 status LED is at address `0x2D` on the separate system I2C bus:
SDA GPIO12 and SCL GPIO11. ESP32 Arduino 3.3.8 builds the camera SCCB driver on
I2C controller 1, while `status_led.h` deliberately uses controller 0 for the
system bus. All three LED channels are driven equally, so the existing on/off
blink behavior
does not depend on the board's RGB channel order.

## Camera standby: hardware PWDN, not SCCB

This is the **only deliberate behavioural divergence** from `camera-firmware/`.
Everything else in the sketch is the same file with a different pin header and
LED driver.

The XIAO camera connector exposes no PWDN line, so the bodycam firmware parks
the sensor by writing the OV2640 standby bit over SCCB. On this board that write
returns `-1`, and because it can half-apply it left the sensor asleep while the
firmware still believed it was awake — every later `esp_camera_fb_get()` then
stalled, which showed up as a status LED cycling between blinking and solid and
zero frames reaching the phone. The register encoding was not the problem:
esp32-camera's `set_reg` takes the OV2640 bank in bit 8, so `0x0109` correctly
addresses bank 1 / COM2.

The glasses wire CAM_PWDN to GPIO9 with a 10k pull-up to 2V8, annotated on the
schematic as *"PWDN; pulled high to shut down by default (unless GPIO pulls to
LOW)"*. Driving that pin is both the board's intended mechanism and a deeper
sleep than software standby, which matters because the glasses enclosure carries
a **400 mAh** cell against the bodycam's 1000 mAh.

The surrounding state machine is unchanged. On wake the firmware releases PWDN,
waits `CAMERA_PWDN_WAKE_SETTLE_MS`, and reads the OV2640 product ID back over
SCCB; a sensor that does not answer routes into the existing driver
reinitialization instead of capturing from a dead sensor. `set_framesize` is
re-applied after each wake as insurance in case a module revision does not
retain its registers across power-down.

## Bring-up prerequisites (verified 2026-08-11)

The camera was confirmed working on the prototype board: OV2640 ACKs at 0x30
with `PIDH=0x26 VER=0x42`, and `esp_camera_init()` returns `ESP_OK` and captures
a valid 640x480 JPEG. Two board-level conditions must both hold, and neither is
visible from the firmware:

1. **Power switch toward the camera connector, battery connected.** 3V3 also
   comes from USB `VBUS`, so the ESP32 boots and flashes over USB alone while
   the 2V8 and 1V8 regulators behind `VBAT_SW` stay off. The camera, the PPG and
   the magnetometer all go dark in that state.
2. **Camera FPC in the correct orientation** — the opposite of the intuitive
   one. Photograph it before disassembling anything.

`glasses-camera-diagnostic/` reproduces the check and documents the diagnostic
signatures for each failure mode.

## Arduino IDE setup

1. Install ESP32 Arduino **3.3.8**.
2. Install **NimBLE-Arduino 2.x** (validated locally with 2.5.0).
3. Open `glasses-camera-firmware.ino` and select:
   - Board: **ESP32S3 Dev Module**
   - PSRAM: **QSPI PSRAM**
   - Flash Size: **4MB (32Mb)**
   - Flash Mode: **QIO 80MHz**
   - Partition Scheme: **Huge APP (3MB No OTA/1MB SPIFFS)**
   - USB Mode: **Hardware CDC and JTAG**
   - USB CDC On Boot: **Enabled**
   - Serial monitor: **115200**
4. Keep `build_opt.h` and `ble_power_config.h` beside the sketch. They enable
   BLE controller modem sleep without disconnecting the phone.
5. Compile, flash, and test on the glasses PCB.

Equivalent local compile command:

```bash
'/Applications/Arduino IDE.app/Contents/Resources/app/lib/backend/resources/arduino-cli' compile \
  --fqbn 'esp32:esp32:esp32s3:PSRAM=enabled,FlashMode=qio,FlashSize=4M,USBMode=hwcdc,CDCOnBoot=cdc,PartitionScheme=huge_app' \
  glasses-camera-firmware
```

## Expected serial output

```text
LP5815 status LED ready on I2C controller 0
Camera sensor PID: 0x0026 (using software standby)
Camera ready
BLE modem sleep: enabled (0x0)
Advertising as BLINKS-CAM
Camera standby
```

The status LED blinks quickly while looking for the phone, stays on while
connected and paused, and blinks slowly while recording. A missing or failed
LP5815 does not stop camera capture; the firmware reports the failure and
continues without the LED.
