# Overnight recording test

This is the real recorder, not the five-phase diagnostic. Keep the study phone
charged, Bluetooth on, and BLINKS running with its normal background permissions.
Use a test/researcher account, not an unrelated participant's recording session.

## Install and check before leaving it overnight

1. Connect the glasses to the Mac by USB, with the glasses' battery switch ON.
2. Build and upload `blinks-glasses` from this directory. Leave the explicitly
   selected `blinks-power-test*` environments unused for recording.
3. Connect the usual phone in BLINKS and start recording. Check that complete,
   current photos arrive about every 30 seconds for several minutes, including
   while the phone screen is locked. In the firmware log, confirm actual BLE
   parameters are 50 ms / latency 0 and transfers finish well inside 30 seconds.
4. Fully charge the glasses. The gauge percentage has not been calibrated and
   is not proof of a full charge. Use the board's normal charging procedure.
5. Unplug only the glasses' USB cable, leaving their switch ON and the phone
   charging. Note the wall-clock start time. Check that another photo arrives
   after unplugging, then let the recording continue overnight.

Commands (choose the currently detected ESP32 USB port):

```sh
~/.pio-venv/bin/pio run -e blinks-glasses
~/.pio-venv/bin/pio run -e blinks-glasses -t upload --upload-port /dev/cu.usbmodemXXXX
~/.pio-venv/bin/pio device monitor --port /dev/cu.usbmodemXXXX
```

After changing SDK defaults, a cached `sdkconfig.blinks-glasses` can override
them. Preserve then remove only that generated file before rebuilding. The
recording code fails compilation if PM, tickless idle or clock fallback are
missing. Do not change flash partitions or erase NVS to install this build.

## Retrieve the result

Note when the last photo arrived and whether recording was paused, ended, or
the phone lost its connection. Reconnect USB and open the serial monitor; press
a key to dump battery and `POWER` reports. If USB does not appear, the flash
checkpoints survive a restart. They are printed before camera initialization,
so the previous run remains readable even if the camera cannot start.

Save the complete serial output before reflashing. Boot reasons distinguish a
brownout from a firmware crash; `queued` counts require comparison with received
frames to assess delivery. Use active recording time, subtracting app pauses,
and camera frame-counter resets to distinguish reboots from phone-side loss.

Sleep counts include advertising and are not a sleep percentage. Idle gauge
samples exclude USB and the five seconds after transfers, but do not measure
total recording energy. A lower idle reading does not itself establish a
particular battery runtime. The runtime result is the overnight test outcome.

Build artifacts, checks and hardware validation status are recorded in
`analysis/power-investigation-2026-09-06/overnight/` at the repository root.
