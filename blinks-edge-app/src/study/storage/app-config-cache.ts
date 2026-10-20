import { File, Paths } from "expo-file-system";
import * as SecureStore from "expo-secure-store";

import type { CachedAppConfig } from "@/study/types/app-config";

// Last successful GET /api/app-config, cached per participant account for
// offline use. The PIN lives in SecureStore, the rest in a file. The
// participant's camera form factor (from GET /api/profile) is cached next to
// it and selects the BLE capture interval offline.
export interface AppConfigCacheEntry {
  config: CachedAppConfig | null;
  cameraFormFactor: string | null;
  studySettingsPin: string | null;
}

// SecureStore keys and file names allow only [A-Za-z0-9._-].
const encodeUsername = (username: string): string =>
  Array.from(username)
    .map((character) =>
      /[A-Za-z0-9.-]/.test(character)
        ? character
        : `_${character.codePointAt(0)?.toString(16) ?? "0"}`,
    )
    .join("");

const pinKey = (username: string) =>
  `blinks.app-config-pin.${encodeUsername(username)}`;

const cacheFile = (username: string) =>
  new File(
    Paths.document,
    `blinks-app-config-${encodeUsername(username)}.json`,
  );

interface CacheFileContent {
  config: CachedAppConfig | null;
  cameraFormFactor: string | null;
}

export const loadAppConfigCache = async (
  username: string,
): Promise<AppConfigCacheEntry> => {
  let content: CacheFileContent = { config: null, cameraFormFactor: null };
  try {
    const file = cacheFile(username);
    if (file.exists) {
      const parsed = JSON.parse(await file.text()) as Partial<CacheFileContent>;
      content = {
        config: parsed.config ?? null,
        cameraFormFactor:
          typeof parsed.cameraFormFactor === "string"
            ? parsed.cameraFormFactor
            : null,
      };
    }
  } catch (error) {
    console.warn("App config cache could not be read:", error);
  }

  let studySettingsPin: string | null = null;
  try {
    studySettingsPin = await SecureStore.getItemAsync(pinKey(username));
  } catch (error) {
    console.warn("Study Settings PIN could not be read:", error);
  }
  return { ...content, studySettingsPin };
};

export const storeAppConfigCache = async (
  username: string,
  entry: AppConfigCacheEntry,
): Promise<void> => {
  const file = cacheFile(username);
  const content: CacheFileContent = {
    config: entry.config,
    cameraFormFactor: entry.cameraFormFactor,
  };
  file.write(JSON.stringify(content));
  if (entry.studySettingsPin) {
    await SecureStore.setItemAsync(pinKey(username), entry.studySettingsPin);
  } else {
    await SecureStore.deleteItemAsync(pinKey(username));
  }
};

export const clearAppConfigCache = async (username: string): Promise<void> => {
  try {
    const file = cacheFile(username);
    if (file.exists) file.delete();
  } catch (error) {
    console.warn("App config cache could not be deleted:", error);
  }
  await SecureStore.deleteItemAsync(pinKey(username)).catch(() => {});
};
