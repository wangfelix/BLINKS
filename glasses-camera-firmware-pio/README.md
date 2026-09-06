# Glasses firmware — custom ESP-IDF build (light sleep)

A build of `glasses-camera-firmware/` with automatic light sleep. It shares the
sketch with the Arduino target; sketch changes affect both. Use this PlatformIO
target for the overnight recording test, because the Arduino IDE build does
not compile the required power-management support.

## Recording update, 6 September 2026

The normal `blinks-glasses` target records VGA photos every 30 seconds and
requests **50 ms BLE intervals, latency zero**, the settings that repeatedly
allowed light sleep in the CABA idle experiment. It checks actual parameters
once a second while running, waits five seconds after connection setup, and
re-requests after phone overrides. Rejected requests back off to once a minute;
recording continues even if the phone refuses the preferred parameters.

Photo framing and the phone/server protocol are unchanged. Notifications target
the subscribed connection explicitly, so enqueue failures can be retried rather
than silently dropping JPEG pieces. A failed packet is retried for at most two
seconds; a complete frame has a twenty-second send budget. Pause, unsubscribe,
disconnect or a new connection aborts an in-progress frame. The next header
starts a fresh frame using the existing protocol. Successful enqueueing alone
does not prove receipt by the phone or server.

The normal build also enables the main-crystal fallback when the external
32 kHz clock fails to start. This is an ESP-IDF option, not a manual sleep call.
The earlier A/B test used the external crystal successfully, so the fallback's
current consumption still needs measurement. Camera power locks now cover
initialization and reinitialization as well as wake/capture, with balanced
release when parked.

Power reports retain the last eight checkpointed boots in a dedicated NVS
namespace (`blinks-rec-pwr`, `history-v1`), separate from the completed bench
test. The first save is after a minute; later saves are five minutes apart and
only occur with the camera parked and at least five seconds after a transfer.
They include firmware identity, boot reason, frames attempted/queued/aborted,
retry counts, actual BLE parameters, sleep-call counts and battery-only idle
gauge samples. The final five minutes may be lost on abrupt power removal.
Short boots that never reach a checkpoint are represented only in the existing
RTC reset chain, which is lost on power removal. Flash errors are printed and
do not halt recording. The gauge can round small currents to zero, so its idle
average is not a calibrated full-cycle current measurement.

See [overnight procedure](OVERNIGHT-TEST.md) for installation, validation and
retrieval. Source version: `blinks-recording-20260906-3`; an ELF hash in each
report distinguishes actual binaries built from that source version.

Version 3 restores JPEG quality **12** (DRAM fallback **15**) and uses **+6 dBm**
BLE transmit power, as requested after visible image degradation at quality 16.
The camera clock remains 10 MHz. The cause of the reported vertical banding is
not established; compare new photos before treating it as resolved. The 30 s
capture interval, 50 ms BLE policy and automatic light sleep are unchanged.

## Why this exists

The Arduino IDE links **precompiled** ESP-IDF libraries built with
`CONFIG_PM_ENABLE` unset. Without power management there is no tickless idle, so
between BLE connection events the CPU merely halts with the PLL and all clocks
still running — for roughly 29 of every 30 seconds. That idle baseline, not the
captures, is the suspected reason the glasses only manage a few hours.

`framework = arduino, espidf` rebuilds the IDF from source with
`sdkconfig.defaults`, which is the only way to turn power management on.

**Note on the "just call `esp_light_sleep_start()`" suggestion:** that function
does exist without `CONFIG_PM_ENABLE`, but with a live BLE connection it drops
the link. The controller must wake for every connection event, and the mechanism
that coordinates that with system sleep *is* the PM lock system. Manual sleeps
would simply sleep through the events until the supervision timeout fires.

## The 32.768 kHz crystal

The board carries X1 (32.768 kHz, XL1/XL2 on GPIO15/16), annotated on the
schematic as *"needed to keep timestamps accurate if the device goes to sleep
often; not if it stays on the entire time."* The board was designed for this.

`CONFIG_BT_CTRL_LPCLK_SEL_EXT_32K_XTAL=y` puts that crystal to work as the BT
controller's low-power clock, which is what lets it keep connection timing
across light sleep. The Arduino build never used it — `ble_power_config.h`
selects the main crystal instead.

## Design decisions in the firmware

Both are `#ifdef CONFIG_PM_ENABLE`, so the Arduino build compiles them away.

* **DFS is pinned at 80 MHz** (`min_freq_mhz == max_freq_mhz`). Letting the
  clock drop below 80 would take APB with it and detune the LEDC-generated
  20 MHz camera XCLK. Light sleep is independent of frequency scaling, so
  pinning the frequency keeps the win and removes that risk.
* **An `ESP_PM_NO_LIGHT_SLEEP` lock guards the loads that must not be
  interrupted:** taken when the sensor is powered (its DVP capture runs over DMA
  and would break if APB were gated) and again during each BLE burst. It is
  released when the sensor is parked and when the burst ends, which is the ~29 s
  of each cycle we actually want to sleep through. `esp_pm` locks count, so the
  nested acquire is safe.

## Build

```bash
cd glasses-camera-firmware-pio
pio run              # first build compiles the whole IDF; expect several minutes
pio run -t upload
pio device monitor
```

## Expected serial output

```text
CPU clock: 80 MHz
Light sleep: enabled (0x0)
LP5815 status LED ready on I2C controller 0
Camera sensor PID: 0x0026 (hardware PWDN standby on GPIO9)
Camera ready
Camera standby
BLE modem sleep: enabled (0x0)
Advertising as BLINKS-CAM (ok=1)
```

`Light sleep: UNAVAILABLE` means `esp_pm_configure()` was rejected and the build
is running exactly like the Arduino one.

## Build status

**Recording build compiles and links clean** (Arduino 3.3.8 / ESP-IDF 5.5.4,
727,472-byte application image). The ELF includes the production capture loop,
connection maintenance, persistent report and actual sleep-call wrapper. Host
tests with address/undefined-behavior sanitizers cover connection setup,
overrides, backoff, reconnect and timer rollover; frame tests cover byte-exact
JPEG reassembly at four MTUs, queue retries, aborts and transfer deadlines.

CABA accepted 50 ms / latency 0 during the USB recording check, queued repeated
frames without retries or aborts, and the user confirmed photos arriving on the
phone. The power checkpoint saved successfully and the earlier build's checkpoint
was still readable after restart/reflash. USB keeps the CPU awake during this
check; actual battery recording sleep and overnight runtime remain to be measured.

NimBLE-Arduino 2.5.1 needed no special handling under `arduino, espidf`.

The 6 September connected-idle experiment verified that this board/phone can
stay connected while entering light sleep at 50 ms. It did not capture photos.
The recording update above requires a photo-delivery check and an overnight
runtime test; build success alone does not establish either.

## Six things that had to be fixed, none of them in the firmware

Worth reading before touching the config, because four of the six fail in ways
that do not look like their cause.

1. **The platform pin.** Stock `platform = espressif32` is still Arduino 2.0.x /
   IDF 4.4; this sketch's APIs postdate it. Pinned to pioarduino `55.03.38-1`,
   which is the *same* Arduino 3.3.8 the Arduino IDE uses — so the sdkconfig is
   the only difference between the two targets.
2. **`CONFIG_FREERTOS_HZ=1000`.** Arduino's CMakeLists hard-fails below this.
   It is also load-bearing for the goal: the tick is the granularity tickless
   idle works in, and `FREERTOS_IDLE_TIME_BEFORE_SLEEP` counts ticks.
3. **`CONFIG_AUTOSTART_ARDUINO=y`.** Defaults to `n`, and PlatformIO does not
   set it. Without it Arduino never defines `app_main`: the build succeeds, the
   board boots, and `setup()` and `loop()` are simply never called.
4. **esp32-camera as a managed component** (`src/idf_component.yml`). The
   Arduino IDE gets the driver from Espressif's precompiled libraries. A
   `framework = espidf` build compiles from source, esp32-camera is not part of
   IDF, and the Arduino component does not pull it in, so `esp_camera.h` simply
   does not exist.
5. **`board_build.embed_txtfiles`.** The Arduino component drags in esp_insights
   and esp_rainmaker, which embed certificates at build time. Nothing here uses
   either; the build fails anyway without the paths declared.
6. **`huge_app.csv` copied into the project.** PlatformIO resolves built-in
   partition names for `framework = arduino` but not for `espidf`.

Kconfig **silently ignores an unknown symbol, and equally silently drops one
whose `depends on` is unmet.** Both produce a clean build that boots and does
not sleep. After changing `sdkconfig.defaults`, delete the generated
`sdkconfig.blinks-glasses` (defaults are only applied when it is absent) and
grep the regenerated file to confirm each setting survived.

## Two toolchains, one source file

`pio run -t upload` produces the light-sleep build; the Arduino IDE produces the
old one. The `POWER` report identifies the recording version and binary hash.
The old `Light sleep: enabled (0x0)` line reports configuration success only;
actual sleep-call counts and negotiated BLE parameters are the runtime evidence.

Keep one serial monitor open at a time. The Arduino IDE's holds the port and
makes `pio run -t upload` fail with `Resource busy`.

## Measuring on this build

`CONFIG_USJ_NO_AUTO_LS_ON_CONNECTION=y` makes the chip stop light-sleeping while
USB is connected and resume once the host disappears. Without it the chip sleeps
through USB frame packets, which can garble enumeration and swallow the keypress
that dumps the battery log — the log survives the plug-in, but you cannot read
it. See the measurement procedure in `glasses-camera-firmware/README.md`.
