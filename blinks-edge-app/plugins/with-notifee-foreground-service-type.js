const { withAndroidManifest } = require("@expo/config-plugins");

// Override notifee's ForegroundService to declare the `connectedDevice`
// foreground-service type.
//
// notifee's library manifest declares the service with type 0x800
// (shortService). That (a) does NOT match the connectedDevice type the app
// requests at startForeground -> Android 14 throws "foregroundServiceType
// 0x10 is not a subset of 0x800" and the app crashes, and (b) shortService is
// time-capped (~3 min). connectedDevice matches the BLE use case and has no
// daily time cap, so it suits the overnight relay.
//
// `tools:replace` forces our value to win over the library's during the
// Android manifest merge.
//
// Ported verbatim from the validated feasibility spike
// (feasibility/blinks-ble-app/plugins/withNotifeeForegroundServiceType.js).
module.exports = function withNotifeeForegroundServiceType(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;
    manifest.$["xmlns:tools"] =
      manifest.$["xmlns:tools"] || "http://schemas.android.com/tools";

    const application = manifest.application[0];
    application.service = application.service || [];
    application.service.push({
      $: {
        "android:name": "app.notifee.core.ForegroundService",
        "android:foregroundServiceType": "connectedDevice",
        "tools:replace": "android:foregroundServiceType",
      },
    });
    return cfg;
  });
};
