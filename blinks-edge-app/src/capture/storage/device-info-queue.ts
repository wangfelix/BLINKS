import * as SecureStore from "expo-secure-store";

import { sessionHolder } from "@/authentication/storage/session-holder";
import { submitDeviceInfoReport } from "@/capture/api/capture-api";
import { createDeviceInfoQueue } from "@/capture/storage/device-info-queue-core";

export const deviceInfoQueue = createDeviceInfoQueue({
  storage: {
    get: (key) => SecureStore.getItemAsync(key),
    set: (key, value) => SecureStore.setItemAsync(key, value),
    delete: (key) => SecureStore.deleteItemAsync(key),
  },
  submit: submitDeviceInfoReport,
  getUsername: sessionHolder.getUsername,
});
