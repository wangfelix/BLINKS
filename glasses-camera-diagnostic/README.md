# BLINKS glasses camera diagnostic

Temporary bring-up sketch for the custom glasses board. It checks the camera
control interface without starting BLE, the status LED, or the production
firmware's capture loop, and it ends by asking `esp_camera_init()` for its own
verdict.

## RESOLVED 2026-08-11: camera working

```
Probe 0x30: ACK (0)
Sensor ID: PIDH=0x26 VER=0x42
OV2640 identity confirmed
esp_camera_init: 0x0 (ESP_OK)
Captured 640x480 JPEG, 14174 bytes
Valid JPEG: the full camera path works
```

Two independent faults were stacked on top of each other, which is why this took
so long to isolate:

1. **The power switch was off.** 3V3 comes from `VBUS` as well, so the ESP32
   booted and flashed happily over USB while `VBAT_SW` — and with it the 2V8 and
   1V8 regulators that feed the camera, the PPG and the magnetometer — stayed
   dead. Every "no camera" symptom followed from that.
2. **The camera FPC was inserted the wrong way round.** With the correct
   orientation the sensor ACKs at 0x30 immediately.

### Working configuration

| | |
| --- | --- |
| Power switch | **toward the camera connector** |
| Battery | connected (either cell; gauge read 4.0 V / 89 %) |
| Camera FPC | opposite orientation to the "obvious" one; note which side the gold contacts face and photograph it before disassembly |
| Board | ESP32S3 Dev Module, QSPI PSRAM, 4MB flash, QIO 80MHz, Huge APP, USB CDC On Boot enabled, Hardware CDC and JTAG |
| Pin map | as in `glasses-camera-firmware/camera_pins.h`, unchanged |

### Diagnostic signatures worth remembering

| Symptom | Meaning |
| --- | --- |
| `i2c.master: probe device timeout ... check pull-ups` | SCCB bus has no pull-ups at all: the 2V8 rail is down |
| `Probe 0x30: address NACK (2)` | Bus is electrically healthy, nothing is answering: no camera, or wrong FPC orientation |
| Magnetometer 0x14 missing | 1V8 domain down, or a wrongly-inserted FPC loading it |
| Magnetometer 0x14 present + `ACK (0)` | everything up |

The PPG at 0x57 stays missing and is expected to: it lives on its own
`PPG Module FPC Connectors` header with no module attached.

The device at **0x34** is still unidentified and returns 0x00 for every register
in 0x00..0x1F. It is not one of the common X-Powers PMICs. Harmless, but worth
asking the board designer about.


First full v6 run on the prototype board. Board configuration is correct
(ESP32-S3 rev 2, 4 MB flash, 2 MB quad PSRAM) and 3V3 is up, but **every net
referenced to the 2V8 camera rail reads low**, so `esp_camera_init()` returns
`0x106 ESP_ERR_NOT_SUPPORTED` behind a wall of `i2c.master: probe device
timeout`.

The camera module (`FPC-05FB-24PH20`) has no onboard regulators: the board feeds
it 1V8 on FPC pin 10, 2V8 on pin 11, and AVCC_2V8 on pin 4 through the L1/C33
filter. Four pull-up resistors reference 2V8 on the ESP32 side of the connector
(R17 CAM_SDA, R16 CAM_SCL, R13 CAM_RESET, R3 CAM_PWDN), so they read high
whenever the rail is up **even with no camera plugged in**. All four read low.

This is a hardware fault, not a firmware or pin-map one. The pin map in
`glasses-camera-firmware/camera_pins.h` is confirmed correct against the
schematic, and Step 3 confirmed the alternative net-label numbering is dead too.
Nothing further can be learned about the camera module, the FPC orientation, or
the `TY-OV2640-40MM` revision question until 2V8 and 1V8 are present.

## The schematic's three numbering systems

Each camera signal appears with three different numbers. Only one is an Arduino
GPIO.

1. **Module land** — the red pin number (1..65) beside the ESP32-S3-MINI symbol.
   Useful for probing the PCB, meaningless to Arduino.
2. **Module pin name** — `IO0`, `IO35`, and so on. This **is** the ESP32-S3 GPIO
   number, and the schematic's *Recomended GPIO Table* repeats it exactly.
3. **Blue net label** — a stale `IOxx/` prefix carried over from the XIAO
   ESP32-S3 prototype. The wire labelled `IO40/CAM_SDA` lands on module pin
   `IO35`. A net label is only a name; the wire is what is electrically true, so
   camera SDA is **GPIO35** and the `IO40` in that label means nothing on this
   board.

The mismatch that looks alarming when reading the schematic is #3, not #1.

| Camera signal | Module land | Arduino GPIO | Stale net-label prefix |
| --- | ---: | ---: | ---: |
| PWDN | 13 | 9 | 36 |
| RESET | 12 | 8 | 35 |
| XCLK / XMCLK | 36 | 40 | 8 |
| SCCB SDA | 31 | 35 | 40 |
| SCCB SCL | 32 | 36 | 39 |
| D7 / Y9 | 35 | 39 | 48 |
| D6 / Y8 | 37 | 41 | 9 |
| D5 / Y7 | 38 | 42 | 10 |
| D4 / Y6 | 29 | 34 | 12 |
| D3 / Y5 | 27 | 47 | 14 |
| D2 / Y4 | 22 | 18 | 18 |
| D1 / Y3 | 25 | 21 | 17 |
| D0 / Y2 | 28 | 33 | 13 |
| VSYNC | 33 | 37 | 38 |
| HREF | 34 | 38 | 47 |
| PCLK | 30 | 48 | 11 |

## GPIO33..GPIO37 depend on the PSRAM menu setting

Five camera signals (Y2=33, Y6=34, SDA=35, SCL=36, VSYNC=37) sit on pins that
octal-PSRAM ESP32-S3 parts reserve for the PSRAM bus. They are free here only
because the module is **-N4R2**, which has 2 MB **quad** PSRAM. Selecting
**OPI PSRAM** in the Arduino IDE hands those five pins to the PSRAM controller
and the camera can never answer. Use **QSPI PSRAM**.

## Arduino IDE settings

Same as the production glasses firmware:

- Board: **ESP32S3 Dev Module**
- PSRAM: **QSPI PSRAM**
- Flash Size: **4MB (32Mb)**, Flash Mode: **QIO 80MHz**
- Partition Scheme: **Huge APP (3MB No OTA/1MB SPIFFS)**
- USB Mode: **Hardware CDC and JTAG**, USB CDC On Boot: **Enabled**
- Serial monitor: **115200**

```bash
'/Applications/Arduino IDE.app/Contents/Resources/app/lib/backend/resources/arduino-cli' compile --fqbn 'esp32:esp32:esp32s3:PSRAM=enabled,FlashMode=qio,FlashSize=4M,USBMode=hwcdc,CDCOnBoot=cdc,PartitionScheme=huge_app' glasses-camera-diagnostic
```

## What v7 does

**Step 2 — system I2C inventory.** Scans the system bus (SDA GPIO12, SCL
GPIO11) and checks it against the five chips listed on the MCU page:
magnetometer 0x14, LP5815 0x2D, fuel gauge 0x55, PPG 0x57, IMU 0x68. If all
five answer, the board is assembled and working and only the camera supply is
missing, which points at a switch rather than a fault. If none answer, the
problem is bigger than the camera.

**Step 3 — safe enable hunt.** Walks every GPIO that could plausibly gate a
power rail (SD_ENABLE, GPOUT, MUX_STATUS, BTN, #ERROR, SD_STATE, and the SD SPI
pins), nudges each one high, and re-checks the four 2V8 witnesses. It uses only
the ESP32's internal ~45k pull-up: far too weak to fight or damage another
driver on the same net, but strong enough to enable a regulator whose EN input
floats or is weakly pulled down. If one pin brings the rail up, the firmware fix
is one line. Candidates deliberately excluded: the camera pins themselves, the
strapping pins GPIO0/3/45/46, the crystal on GPIO15/16, USB on GPIO19/20, UART0
on GPIO43/44, and GPIO26 which the PSRAM uses.

Steps 4 and 5 (SCCB probe and `esp_camera_init()`) only run if 2V8 actually
comes up, so a dead-rail log stays short and readable. The alternative
net-label pin map probe from v6 was removed: it was tried and ruled out.

## What v6 did

**Step 0 — board configuration.** Prints chip, flash, and PSRAM. If PSRAM is
missing or is not about 2 MB, the IDE PSRAM setting is wrong and the camera pins
are compromised before anything else is tested.

**Step 1 — external pull-up census.** An external pull-up beats the ESP32's ~45k
internal pull-down, so a pin that still reads HIGH with the internal pull-down
engaged is on a powered net with an external pull-up. GPIO11/GPIO12 (system I2C,
4.7k to 3V3) act as a positive control that the method works on this board.

Four nets are referenced to the **2V8** camera rail, all through resistors on the
ESP32 side of the FPC, so all four read HIGH whenever the rail is up regardless
of whether a camera is attached:

| Net | GPIO | Pull-up |
| --- | ---: | --- |
| CAM_SDA | 35 | R17, 4.7k to 2V8 |
| CAM_SCL | 36 | R16, 4.7k to 2V8 |
| CAM_RESET | 8 | R13, 10k to 2V8 |
| CAM_PWDN | 9 | R3, 10k to 2V8 |

That gives the census two answers at once, with no multimeter: whether the 2V8
rail is up, and which of the schematic's numbering systems the PCB follows.

**Step 2 — SCCB probe on the recommended map.** XCLK at 20 MHz on GPIO40, then
the datasheet power-up sequence, then a probe at 0x30 (OV2640) and 0x3C
(OV3660) on I2C controller 1, which is the controller esp32-camera itself uses
in ESP32 Arduino 3.3.8. Both PWDN polarities are tried in case the board
inverts that line, and the second pass adds a full 0x08..0x77 scan.

**Step 3 — fallback probe on the net-label map.** Expected to fail. It runs only
so the log rules the second numbering system in or out empirically instead of by
argument.

**Step 5 — `esp_camera_init()`.** The driver's own verdict, followed by one
capture attempt. `0x105 ESP_ERR_NOT_FOUND` means no sensor was identified over
SCCB. `0x101 ESP_ERR_NO_MEM` points at PSRAM/frame-buffer settings. An init that
succeeds but a capture that returns nothing isolates the fault to the parallel
DVP lines (PCLK, VSYNC, HREF, D0..D7) rather than SCCB.

## Reading the result

- **No PSRAM in Step 0** — fix the IDE setting before believing anything else.
- **Control pins not pulled up in Step 1** — the board is unpowered, is a
  different revision, or does not populate R8/R9. The rest of the census is
  unreliable.
- **None of GPIO35/36/8/9 pulled up in Step 1** — the 2V8 camera rail is down.
  Four separate resistors on the ESP32 side of the FPC would have to be
  unpopulated for any other explanation to hold. This is a hardware finding and
  no firmware pin change can fix it. Measure 2.8 V at the far pad of
  R3/R13/R16/R17 and at FPC pin 11, then trace back to the regulator.
- **Pull-ups present but no ACK in Step 2** — SCCB wiring is powered but the
  sensor is silent. Check FPC orientation and latch, camera power rails, and
  XCLK reaching the module.
- **ACK with PIDH 0x26** — the camera control interface works; move on to the
  DVP signals and the production driver.

## Open question after power is fixed

The FPC pinout is the designer's own open item, noted on the camera page: the
connector follows the XIAO ESP32-S3 Sense wiring, and FPC pin 24 is fed from 2V8
through D2 where the ESP32-S3-EYE leaves it NC. Once 2V8 and 1V8 are up and the
sensor still does not ACK, get the supplier pinout for the exact
`TY-OV2640-40MM-V1.1` revision before changing the PCB. The available V1.0
drawing is not enough to prove the V1.1 pinout, and its differences from the
custom connector wiring at pins 10, 23, and 24 still need to be resolved.

After testing, flash `glasses-camera-firmware/` again for normal operation.
