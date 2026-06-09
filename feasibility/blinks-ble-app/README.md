# blinks-ble-app (feasibility app)

Minimal Expo / Android app that connects to the `BLINKS-CAM` BLE peripheral,
reassembles each JPEG, and **saves it to the phone** with a receipt timestamp. A
notifee **foreground service** keeps it alive in the background. Frames go to
`<app documents>/frames/`. No VPN, no server.

> BLE (`react-native-ble-plx`) and the foreground service (`@notifee/react-native`)
> are native modules — **Expo Go will not work**. You need a custom **dev build**.

## Build the dev build

```bash
cd feasibility/blinks-ble-app
npm install
npx expo install        # aligns versions to your installed Expo SDK
```

Then either:

**A) EAS Build (cloud, no local Android SDK needed)**
```bash
npm i -g eas-cli
eas login               # free Expo account
eas build -p android --profile development
```
Install the resulting `.apk` on your phone, then:
```bash
npx expo start --dev-client
```

**B) Local build (needs Android Studio + SDK, phone via USB, USB debugging on)**
```bash
npx expo run:android
```

## Run the test

1. Power the flashed camera (advertising `BLINKS-CAM`).
2. Open the app → **Start** → grant Bluetooth + Notifications permissions.
   You should see `status: connected` and **frames received** climbing
   (every 30 s; lower the firmware interval first if you want quick feedback).
3. **Disable battery optimization** for this app:
   Settings → Apps → BLINKS BLE Spike → Battery → **Unrestricted**.
   On vivo/Funtouch (and Xiaomi/MIUI, Huawei): also enable **Autostart** and
   lock the app in recents. *This is the variable we're testing.*
4. Lock the phone, leave the app in the background **overnight**.
5. Morning after: open the app → **Analyze saved frames**. Read:
   - **delivery %** (received vs expected at 30 s spacing)
   - **largest gap** (the longest stretch with no frames)
   Tap **Share log** to export a CSV of every frame's timestamp.

## How to read the result

- **~100% delivery, small largest gap** → the foreground service survived; the
  phone-relay architecture is viable. On to spike #2 (VPN + server).
- **Big gaps / low delivery** → Android (likely the OEM battery manager) killed
  the service. Note the phone model + whether battery optimization was disabled;
  that tells us how hard reliable background capture will be.

## Known rough edges (first scaffold)

- Versions in `package.json` are best-effort; `npx expo install` will correct
  them for your SDK.
- The Android-14 foreground-service type is set numerically
  (`16` = `CONNECTED_DEVICE`) in `App.tsx`; if notifee on your version wants its
  enum instead, that's a one-line change.
- Frame reassembly resyncs on a 10 s timeout if a BLE notification is dropped, so
  an occasional short/again-counted frame in the log is expected — the
  delivery-% and gap numbers are what matter.
