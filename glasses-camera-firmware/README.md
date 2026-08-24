# BLINKS smart-glasses BLE camera firmware

Firmware for the custom Blinks glasses PCB with an ESP32-S3-MINI-1U-N4R2,
TY-OV2640-40MM camera, and LP5815 RGB status LED. The existing
`camera-firmware/` directory remains the independent XIAO ESP32-S3 Sense
bodycam/necklace target.

The glasses use the same phone-facing contract as the existing camera:
`BLINKS-CAM`, the same BLE service and characteristics, VGA JPEG capture,
pause/resume commands, camera recovery, and sensor standby between samples.

Three settings diverge deliberately, all for battery life on the glasses' much
smaller pack: a **30 s capture interval** (bodycam: 15 s), an **80 MHz CPU
clock** (bodycam: 240 MHz default), and **hardware PWDN standby** instead of the
SCCB software standby the XIAO is forced to use. Everything else is the same
sketch with a different pin header and LED driver.

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
system bus. See "Status LED" below for how it is driven.

## Battery: capture interval and CPU clock

The glasses reach about **four hours** on the usable half of their 2x200 mAh
pack, against a bodycam that runs all day on 1000 mAh. Two settings were
loosened to close the gap:

* **`CAPTURE_INTERVAL_MS` is 30 s**, not 15 s. The server chunks frames into
  clock-aligned 5-minute windows regardless of rate, so nothing server-side
  changes — this simply yields ~10 frames per VLM chunk instead of ~20, and
  `VLM_CHUNK_MAX_FRAMES` (20) is a cap rather than a requirement. **This is a
  known, accepted asymmetry:** the VLM labels for glasses participants rest on
  roughly half the visual evidence of bodycam participants', which belongs in
  the methods write-up.
* **`CPU_CLOCK_MHZ` is 80**, applied before anything else initializes. Nothing
  here is CPU-bound — the sensor compresses the JPEG, capture runs over DMA, and
  the BLE burst is paced by its own `delay()` — while the idle baseline runs for
  ~29 s of every 30 s cycle and is what actually drains the pack. 80 MHz is the
  floor: on the ESP32-S3, CPU 240/160/80 all keep APB at 80 MHz, and below that
  APB follows the CPU and would detune the LEDC-generated 20 MHz camera XCLK.

Neither has been measured yet. The number that decides whether this is enough is
the **idle current** — the draw while connected but not capturing — because it
sets a ceiling no capture interval can beat. At 40 mA the glasses cannot exceed
~5 h even taking no pictures at all; at 25 mA the ceiling is ~8 h.

## Camera standby: hardware PWDN, not SCCB

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

## Status LED: confirm the connection, then stay dark

The indicator exists for one moment — the participant puts the glasses on and
wants to know the phone has picked them up — so it says exactly that and then
stops:

| Phase | Behaviour |
| --- | --- |
| Searching | 50 ms **red** flash every 500 ms |
| Connected | **three white flashes** (150 ms on, 300 ms apart) |
| After that | dark for the rest of the run |

The confirmation plays **once**. A later disconnect does not replay it: by then
the glasses are on someone's face, and an LED that returned on every dropout
would blink at them all day for no purpose. There is no longer any recording or
paused indication, and no timeout — the phase machine simply ends in `LED_DONE`
and `updateStatusLed()` returns immediately from then on.

`STATUS_LED_DOT_CURRENT` is `0x18`, about 9% of the LP5815's 25.5 mA ceiling, so
roughly 2.4 mA per lit channel. All three sinks are enabled because the
confirmation is white, but an enabled sink at PWM 0 draws nothing, so the dark
phase costs the same as if only one were configured. To dim further, use the dot
current rather than the PWM value: dot current lowers the instantaneous draw,
PWM only shortens the on-time and leaves the peak where it was.

`STATUS_LED_CHANNEL` picks the red sink for the searching flash and defaults to
0, because TI's reference wiring is OUT0=red, OUT1=green, OUT2=blue. **This has
not been verified against the board.** If the searching flash comes up green or
blue, set it to 1 or 2; the white confirmation drives all three either way and
will look correct regardless.

Note that the glasses now carry no outward sign of recording beyond the first
few seconds, which is a deliberate trade against bystander-facing visibility.

## Avoiding load peaks

The glasses draw from one 200 mAh cell at a time through the power MUX, and its
protection circuit latches off on a large enough current step — the cell then
reads ~1.7 V and the MUX quietly fails over to the other one. The firmware
therefore never switches two big loads on together:

* **The sensor is powered down before every BLE burst, unconditionally.**
  `parkCameraNow()` waits briefly for the driver to buffer a frame, then asserts
  PWDN whether or not that wait succeeded. The previous code skipped standby on
  a timeout and transmitted with the camera still running, which is the one
  overlap these cells cannot absorb. A driver wedge is recoverable through
  `recoverCameraIfWedged()`; a current spike is not.
* **Boot brings the LED driver, the camera and the radio up one at a time,**
  separated by `LOAD_STAGGER_MS`, and parks the sensor before BLE starts.
* **Driver restarts hold PWDN across the gap.** `restartCameraDriver()` is used
  by both recovery paths so the reinitialization inrush never stacks on top of
  an active radio link.

Not yet done: BLE transmit power is still `ESP_PWR_LVL_P9` (+9 dBm) on both
boards. That is the largest remaining lever on peak current, but it trades
against link margin, so it wants measuring rather than assuming.

## Bring-up prerequisites (verified 2026-08-11)

The camera was confirmed working on the prototype board: OV2640 ACKs at 0x30
with `PIDH=0x26 VER=0x42`, and `esp_camera_init()` returns `ESP_OK` and captures
a valid 640x480 JPEG. Three board-level conditions must all hold, and none of
them is visible from the firmware:

1. **Power switch toward the camera connector, battery connected.** 3V3 also
   comes from USB `VBUS`, so the ESP32 boots and flashes over USB alone while
   the 2V8 and 1V8 regulators behind `VBAT_SW` stay off. The camera, the PPG and
   the magnetometer all go dark in that state.
2. **Camera FPC in the correct orientation** — the opposite of the intuitive
   one. Photograph it before disassembling anything.
3. **External antenna seated on the U.FL connector.** The module is an
   ESP32-S3-MINI-**1U**, which has no PCB antenna, so an unseated or loose
   coaxial connector leaves the radio transmitting into an unterminated port.
   The device still works at arm's length, which is what makes this hard to
   spot: it presents as intermittent "Camera Connecting...", frames arriving at
   30 s or 45 s instead of 15 s, and a large frame deficit over a full day —
   all of which look like firmware faults. Check this connector on every unit
   before it goes out, and re-check it after any reassembly.

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
Camera sensor PID: 0x0026 (hardware PWDN standby on GPIO9)
Camera ready
BLE modem sleep: enabled (0x0)
Advertising as BLINKS-CAM (ok=1)
Camera standby
```

The status LED flashes twice a second while looking for the phone, stays solid
while connected and paused, and flashes once a second while recording — then
goes dark five minutes after power-on. A missing or failed LP5815 does not stop
camera capture; the firmware reports the failure and continues without the LED.
