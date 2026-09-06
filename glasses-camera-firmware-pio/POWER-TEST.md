# Ten-minute connected-idle power test

**Version status:** CABA now has **blinks-recording-20260906-2** installed for
the overnight recording test; see `OVERNIGHT-TEST.md`. Before that, its **v2
fallback diagnostic** run finished all five phases and was recovered from flash after restarting the
glasses. Results are in `analysis/power-investigation-2026-09-06/bench/RESULTS-v2.md`.
At 7.5 ms the repeated phases recorded no successful light-sleep calls and
averaged 28.17 mA on the gauge; at 50 ms they recorded 5,466 successful calls and
averaged 1.46 mA. The low-current value may be biased by the expected gauge's
near-zero deadband; the report distinguishes gauge readings from calibrated
current measurements. This test measured connected idle with no photos.
The user explicitly accepted possible loss of the interrupted v1 run and
restarted the glasses. Its unread measurements were not recovered. The v2 upload
was verified, and the initial 368-byte checkpoint was independently read from
flash with valid page/entry/blob CRCs and the expected capture firmware hash.

This is a bench-only firmware target. It initializes the normal camera and
Bluetooth stack, then keeps the camera powered down. It captures and sends no
photos. It tests the cause of the idle-current difference, not full recording
runtime or image-transfer throughput. The normal `blinks-glasses` target remains
the default.

## What was observed before flashing

On 6 September 2026 the connected board's USB identity ended CAB8 and its actual
Bluetooth address was **AC276ECBCABA**. Its existing firmware was
`d09fda8-dirty`, compiled 26 August at 23:12:58, ESP-IDF 5.5.4. Its boot log
explicitly reported failure to detect the 32 kHz crystal, followed by disabling
light sleep while Bluetooth is enabled. This confirms the fallback mechanism
on this board/boot. It does not identify the historical state of D616.

After flashing the diagnostic, the external clock was detected. To separate
this from a firmware change, the full original flash image was restored and
verified. **The exact original firmware then also detected the external clock**,
as recorded in `bench/original-restored-boot.log`. Thus two boots of the same
board with the same original firmware took different clock paths. This does not
yet distinguish startup delay, retained oscillator state or another hardware
condition, and it is not a measured current difference.

The serial-monitor open reset this unit (`USB_UART_CHIP_RESET`); its previous
battery ring survived. This is why the test stores compact results in RTC RAM
and marks a reset during measurement as an aborted test.

During the first attempt the phone died and was later restarted. The user then
continued for another ten minutes. Version 1 does not automatically restart an
aborted sequence on reconnection. Its report has not yet been recovered, so the
number of completed phases and abort reason remain unknown. macOS did not see
the glasses over USB after cable/port reconnections, although a Mac Bluetooth
connection succeeded. A bounded recovery attempt sent 1,574 standard pause
commands, but USB still did not appear. No result-clear command, power cycle or
reflash was performed during these retrieval attempts.

## Version 2 result retention

- Each completed phase is checkpointed to the dedicated NVS namespace
  `blinks-pwr`, key `record-v2`. No NVS partition is erased. Writes occur before
  the next phase's twenty-second settling interval, or after measurement ends.
- Successful checkpoints survive a power cycle. A power loss can discard the
  unfinished phase; after restart the interrupted test is reported as aborted,
  with previous completed phases retained. RTC memory can also retain partial
  progress over a software reset.
- After completion or abort, a separate no-light-sleep lock keeps the CPU awake
  for USB retrieval. Current in that terminal state is not a test measurement.
- `flash_status=ESP_OK` reports the latest successful storage operation.
  A checkpoint failure aborts rather than continuing an unprotected test.
  An unreadable stored result is not automatically replaced; `r` is required.
- The capture firmware hash, clock source and fallback setting travel with the
  saved result, so reading it under a later build does not misattribute it.
- `r` while USB is attached explicitly replaces the saved result and arms a new
  test. A completed or aborted test never restarts just because the phone returns.

The initial checkpoint is verified on-device in
`bench/v2-checkpoint-verification.json`. The complete five-phase result also
survived a restart and was recovered with valid CRCs. USB still failed to appear
on the first post-test connection, so its return remains unreliable even with
the intended awake retrieval state. Read flash checkpoints after a restart if
necessary; never send `r` or reflash before preserving them. These changes do not
retroactively protect or recover v1.

Saved evidence is in `analysis/power-investigation-2026-09-06/bench/`.
`CABA-before-test-full-flash.bin` is the complete 4 MB original image. A ROM read
and an independent on-device MD5 agreed; `backup-verification.json` contains
its checksums. `diagnostic-builds.json` identifies the preserved test binaries.

## Firmware targets

- `blinks-power-test` uses the original SDK sleep settings.
- `blinks-power-test-fallback` changes only the SDK option
  `CONFIG_BT_CTRL_MAIN_XTAL_PU_DURING_LIGHT_SLEEP=y` relative to that test target.
  ESP-IDF documents this option for a missing external crystal: Bluetooth keeps
  the accurate main crystal running while the CPU can light-sleep. The RTC timer
  can use the internal oscillator; the Bluetooth clock is still the main crystal.
- Both test targets compile the same diagnostic program with NimBLE 2.5.1 and
  the same production initialization. Neither enables manual light sleep or
  changes the controller's admission thresholds.

Build/flash the fallback test with the connected device's current port:

```sh
cd /Users/felixwang/Developer/esp32s3-vlm-inference/glasses-camera-firmware-pio
~/.pio-venv/bin/pio run -e blinks-power-test-fallback -t upload --upload-port /dev/cu.usbmodem2101
```

The generated environment-specific sdkconfig is cached. When changing the
fallback defaults again, regenerate only the corresponding test configuration;
do not delete or modify the normal build's sdkconfig.

## Run

1. Keep the battery switch ON. Use the usual study phone with a test account.
   Start its recorder to establish the normal BLE connection. The app will show
   a connected camera but receive no photos during this diagnostic test.
   If the account is eligible for Study Settings' isolated test recording,
   that also establishes the needed connection without starting a study day.
2. Leave the phone close to the glasses and keep the app in the same state
   throughout. Unplug the USB cable, leaving the glasses on battery power.
3. Wait **11 minutes**. The test starts after five seconds with a connected phone,
   USB absent and the normal connection-confirmation LED sequence finished.
4. Reconnect USB **without switching the glasses off**. Retrieve the report with
   a serial monitor at 115200 baud, pressing `d` and Enter if needed.
   A monitor-triggered reset preserves the RTC summaries. Confirmed v2 flash
   checkpoints survive power loss, but keeping the battery on also preserves
   any partial phase held only in RTC memory.

If the report says `ABORTED`, its reason distinguishes USB attachment before
completion, a link loss, a reset, and the camera leaving standby. Fix that
condition, send `r` while USB is attached to clear and arm, then repeat.
If it says `WAITING`, it never obtained the battery-only connected condition.

## Sequence and controls

Each phase lasts two minutes; its first twenty seconds allow settling and are
excluded from measurements:

| Phase | Requested interval | Requested peripheral latency |
| --- | --- | --- |
| Baseline | Whatever the phone negotiated normally | Unchanged |
| A | 7.5 ms | 0 |
| B | 50 ms | 0 |
| A repeated | 7.5 ms | 0 |
| B repeated | 50 ms | 0 |

A and B differ only in interval. The measured min/max interval and latency come
from the connection information, not from the request. The phone can refuse or
override a request; compare a requested phase only if every recorded sample
matches (`target_match_n == n`, `n > 0`) and status is complete. Gauge sampling
is about once every 1.1 seconds and is a steady-idle sample mean, not a complete
capture-cycle energy measurement. Positive current would invalidate a presumed
battery-discharge comparison and should be investigated rather than averaged
into a claimed discharge current.

`sleep_ok` counts real IDF sleep calls returning success. `sleep_failed` counts
attempted calls returning an error. A controller that forbids attempting sleep
can show zero for both. `sleep_call_ms` includes entry and exit overhead and
must not be interpreted as exact physical time asleep or converted into a
physical sleep percentage. The linker wrapper observes the existing IDF call;
it does not force sleeps.

The test reads `btLS` lock state before reconnecting USB. A current lock dump
after reconnecting USB would include a USB lock introduced by measurement.
`btLS_held = -1` means its snapshot failed, not that a blocking lock was absent.

## Interpretation

- A near 31 mA with little/no successful sleep, B materially lower with many
  successful sleeps, and a repeated A/B reversal: causal evidence that the BLE
  interval changes idle consumption through sleep admission.
- On the original SDK test, held `btLS`, main-crystal fallback and no sleep at
  either interval: the clock fallback blocks sleep independently of interval.
- On the fallback-enabled test, `btLS` no longer held and successful sleep at B:
  the fallback configuration restores the ability to sleep despite the missing
  external crystal. A matched run of the original test is the current-draw control.
- Successful sleep at B but consistently high current: investigate the gauge
  scale, camera/board rails and other peripherals next.
- Requested parameters not accepted: interval comparison is inconclusive.

After an idle improvement, restore a recording-capable firmware with the tested
change and separately verify photo delivery, complete-cycle energy and runtime.
This bench target alone is not ready for participant recording.

Restore the normal current source build with:

```sh
~/.pio-venv/bin/pio run -e blinks-glasses -t upload --upload-port /dev/cu.usbmodem2101
```

That restores the current source's normal firmware, not necessarily the exact
older `d09fda8-dirty` binary. Use the verified pre-test flash backup if exact
restoration of this board's original image is wanted.

The exact backup was successfully restored during the clock check with:

```sh
cd /Users/felixwang/Developer/esp32s3-vlm-inference
~/.platformio/penv/.espidf-5.5.4/bin/python -m esptool --chip esp32s3 --port /dev/cu.usbmodem2101 --baud 460800 write-flash 0 analysis/power-investigation-2026-09-06/bench/CABA-before-test-full-flash.bin
```
