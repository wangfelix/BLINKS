# BLE protocol: camera ↔ app

The camera is a BLE peripheral, the participant's phone (`blinks-edge-app`) is
the central and relays frames to the server. This document describes the wire
protocol shared by

- the necklace firmware `camera-firmware/camera-firmware.ino`,
- the glasses firmware `glasses-camera-firmware/glasses-camera-firmware.ino`
  (the PlatformIO build in `glasses-camera-firmware-pio/` includes the same `.ino`),
- the app (`blinks-edge-app/src/capture/ble/`: `ble-constants.ts`,
  `camera-link.ts`, `frame-assembler.ts`, `camera-device-info.ts`).

UUIDs, opcodes, byte layouts and limits must stay identical on all three sides.
The shared interval/device-info logic lives in `capture_interval_config.h`
(identical copies in both firmware folders, host-tested in
`glasses-camera-firmware-pio/tests/`).

## 1. Advertising and GATT layout

| Item | Value |
|---|---|
| Advertised name | `BLINKS-CAM` (name only: name + 128-bit UUID do not fit in the 31-byte advertising packet) |
| Service | `9a8b7c6d-0001-4a5b-8c9d-0e1f2a3b4c5d` |
| Frames | `9a8b7c6d-0002-4a5b-8c9d-0e1f2a3b4c5d`, **notify** |
| Control | `9a8b7c6d-0003-4a5b-8c9d-0e1f2a3b4c5d`, **write** / write-without-response |
| Device info | `9a8b7c6d-0004-4a5b-8c9d-0e1f2a3b4c5d`, **read** (no notify) |

The app scans without a UUID filter and matches the advertised name. After the
first connection it reconnects directly to the known address (Android
`autoConnect`) instead of scanning again. Both firmwares set the local MTU to
517; the app requests MTU 517 after connecting.

## 2. Frames (`…0002`, notify)

Each JPEG is sent as one header notification followed by data notifications:

| Packet | Layout |
|---|---|
| Header | `[0x01][JPEG length, uint32 BE][frame counter, uint32 BE]` (9 bytes) |
| Data | `[0x02][up to 180 JPEG bytes]` |

- **Frame counter:** starts at 0 after boot, incremented once per captured
  frame before it is sent (the first frame carries 1). It is not reset on
  reconnect. Gaps in the counter (`device_frame` on the server) identify
  frames that were captured but not delivered.
- **Payload size:** necklace: fixed 180 bytes. Glasses: 180 bytes at a
  negotiated MTU ≥ 184, otherwise `MTU − 4`.
- **Pacing:** 8 ms delay after every notification on both firmwares.
  - Necklace: fire-and-forget; the send stops when the link drops.
  - Glasses: each notification is queued with a retry (10 ms back-off) for up
    to 2 s per packet and 20 s per frame; the frame is aborted on disconnect,
    pause or a lost subscription.
- **Receiver (`FrameAssembler`):** the tags make the stream self-syncing. A
  header starts a new frame (a partial frame is dropped); data before a header
  is ignored; a frame is complete when the received bytes reach the header
  length. Headers with length 0 or > 200000 bytes are discarded; a frame whose
  data stops for more than 10 s is abandoned. The capture time is stamped when
  the header arrives (the camera has no clock). Receivers that read only bytes
  1–4 of the header stay compatible.

## 3. Control (`…0003`, write)

| Opcode | Length | Meaning |
|---|---|---|
| `0x01` | 1 byte | pause (stop capturing) |
| `0x02` | 1 byte | resume |
| `0x03` | exactly 5 bytes: `[0x03][intervalMs, uint32 BE]` | SET_CAPTURE_INTERVAL |

Unknown opcodes are logged and ignored. Empty writes are ignored.

`0x03` examples: 15 s `03 00 00 3A 98`, 30 s `03 00 00 75 30`, 60 s `03 00 00 EA 60`.

`0x03` handling in the firmware:

- **Length ≠ 5** → ignored, log `Control: bad 0x03 length <n>`, interval unchanged.
- **Clamping** to `[5000, 600000]` ms (`kCaptureIntervalMinMs`,
  `kCaptureIntervalMaxMs`; same bounds as `capture.intervalMsByFormFactor` in
  `server/src/study-config/schema.ts`). The log shows raw and effective value.
  `CAMERA_WARMUP_MS` is statically asserted to be shorter than the default
  interval.
- **Takes effect immediately:** the next capture is due at
  `last capture + new interval`; if that is already past, the camera captures
  right after the warm-up.
- The device info (`…0004`) is updated after every `0x03`.

Pause and interval are independent.

## 4. Device info (`…0004`, read)

Compact UTF-8 JSON without whitespace, about 110 bytes (Android reads it with
Read Blob if the MTU is smaller):

```json
{"v":1,"fw":"1.1.0","formFactor":"glasses","intervalMs":30000,"defaultMs":30000,"minMs":5000,"maxMs":600000}
```

| Field | Type | Meaning |
|---|---|---|
| `v` | int | Format of this characteristic (`1`). Increases only for incompatible changes |
| `fw` | string | Firmware version (`FIRMWARE_VERSION`, semver) |
| `formFactor` | string | `"necklace"` or `"glasses"` (`FORM_FACTOR`), same keys as `devices.formFactors[].key` |
| `intervalMs` | int | **effective** interval after clamping |
| `defaultMs` | int | compiled-in default (`CAPTURE_INTERVAL_MS`) |
| `minMs`, `maxMs` | int | clamping bounds |

The firmware refreshes the value at start-up, on connect, after `0x03` and on
disconnect. Extensions add fields only; the app ignores unknown fields. Invalid
JSON is treated like "not supported" and logged.

## 5. Defaults and disconnect

| | Necklace | Glasses |
|---|---|---|
| Default interval (`CAPTURE_INTERVAL_MS`) | 15000 ms | 30000 ms |
| `formFactor` | `necklace` | `glasses` |
| Captures while | connected and not paused | connected, frames subscribed (CCCD) and not paused |

The **phone is the authority**. On disconnect the firmware resets `paused` to
`false` and the interval to the default, then advertises again. The app
re-asserts both on every (re)connect.

LED (necklace): fast ~2 Hz blink = searching, solid = connected and paused,
slow ~1 Hz blink = recording. The glasses drive an LP5815 status LED
(`glasses-camera-firmware/status_led.h`).

## 6. Connect sequence (app)

After every (re)connect `CameraLink.finishConnection` runs:

1. `requestMTU(517)` (errors ignored), `discoverAllServicesAndCharacteristics`.
2. If the session is paused: write `0x01` **before** anything else, because the
   firmware records from the moment a central connects (`paused=false` after a
   disconnect).
3. **Support detection:** if `…0004` is present, read it. Missing or unreadable
   → the firmware has no `0x03` support (older firmware logs
   `unknown opcode 0x03` although the GATT write succeeds); the app sends **no**
   `0x03` and the camera keeps its default.
4. Interval = `capture.intervalMsByFormFactor[<form factor from Study Settings>]`
   from the cached `GET /api/app-config` → write `0x03`. Without a cached config
   or form factor: no `0x03`.
5. Read `…0004` again. Warn (shown in Study Settings) if `intervalMs` differs
   from the requested value (clamped) or `formFactor` differs from the Study
   Settings form factor; the Study Settings value stays authoritative.
   The result is reported to the server for the main session (see
   `docs/study-config-documentation.md`, section 4.8).
6. Subscribe to frame notifications on `…0002`.

Steps 3–5 are bounded to 5 s in total. On timeout or disconnect they are
aborted (running BLE transactions are cancelled with `cancelTransaction`), and
nothing more is written on that connection. Errors in steps 3–5 never stop the
recording. A form-factor or config change during a connection writes `0x03`
again and re-reads `…0004`; these writes run in a per-connection queue, so
there is never more than one `0x03` in flight.

Reconnect timing in the app: scan restarts every 30 s; scan failures back off
from 2 s up to 30 s; a failed connection is retried after 3 s.

## 7. Testing on hardware

1. Flash both firmwares, open serial at 115200 baud.
2. Set 15 s / 30 s / 60 s from the app; check the frame spacing (serial log and `capture_epoch_ms`).
3. Bounds: 1000 ms → 5000 ms, 700000 ms → 600000 ms (serial log and `…0004`); a wrong length is ignored.
4. Disconnect/reconnect: the firmware falls back to its default, the app sets the interval again.
5. Compatibility: old app + new firmware (default interval) and new app + old firmware (no `…0004`, no `0x03`, no disruption).
6. Pause, then disconnect/reconnect: no frames arrive after the reconnect.
7. A second phone writes `0x03` during a running session; the serial log shows the change (see section 8).

Host tests for `capture_interval_config.h`: see `glasses-camera-firmware-pio/README.md`.

## 8. Known limitation: no BLE authentication

The control characteristic is writable without pairing/bonding and without
encryption. Any device in radio range can pause/resume the camera or change the
interval (5 s drains the battery faster, 600 s means fewer photos).

Mitigations in place:

- The firmware clamps to 5000–600000 ms and returns to its defaults on every
  disconnect; the app re-asserts pause and interval on every connect.
- The app reads `…0004` after writing and reports the effective interval to
  the server. A foreign change during an existing connection is not visible
  there (the firmware only logs it on serial).

Possible hardening: bonding with an encrypted characteristic
(`WRITE_ENC`/`WRITE_AUTHEN` in NimBLE), or a notify on `…0004` when the
interval changes.
