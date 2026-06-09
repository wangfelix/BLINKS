# BLINKS feasibility spike: phone-relay over BLE

This validates the **one make-or-break risk** of the phone-relay architecture
(camera → BLE → phone → KIT VPN → server): **can an Android foreground service
keep the BLE link alive and frames flowing while the app is backgrounded and the
screen is off, overnight, despite OEM battery-killing?**

It deliberately does **not** include the VPN or the server. The phone just
receives frames over BLE and saves them locally with timestamps. If frames keep
landing overnight, the architecture is viable and we build spike #2 (add the VPN
+ server relay). If they don't, we learn that before investing in the rewrite.

## Two parts

- `esp32-ble-camera/` — **promoted to [`../camera-firmware/`](../camera-firmware/)**
  after the spike validated the architecture; it is now the production firmware
  (with the stale-frame/FB-OVF fixes and a pause/resume control characteristic).
  Minimal ESP32-S3 firmware: a BLE peripheral that sends one VGA JPEG every N s.
  No WiFi.
- [`blinks-ble-app/`](blinks-ble-app/) — minimal Expo (Android) app: BLE central
  + foreground service that saves each frame to the phone, with a built-in
  "Analyze saved frames" readout (delivery % and largest gap). Superseded by the
  production app in [`../blinks-edge-app/`](../blinks-edge-app/), which ports its
  BLE + foreground-service solution.

They share a tiny BLE protocol (4-byte big-endian length, then raw JPEG chunks).

## How to run the test

1. Flash the firmware (see its README), power the camera — it advertises
   `BLINKS-CAM`.
2. Build + install the app dev build (see its README), open it, tap **Start**.
   Confirm it connects and the frame count rises.
3. **Disable battery optimization for the app** (and on vivo/Xiaomi, enable
   autostart) — this is the variable under test.
4. Lock the phone, leave the app backgrounded **overnight**.
5. In the morning, open the app and tap **Analyze saved frames** → read the
   delivery % and largest gap. That's the result.

> This is a first scaffold. BLE + foreground service need a real dev build (not
> Expo Go) and may need an on-device tweak or two — flag anything that breaks and
> we'll iterate.
