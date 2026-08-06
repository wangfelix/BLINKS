import * as SecureStore from "expo-secure-store";

import { isImageRotation } from "@/study-settings/types/image-rotation";
import type { ImageRotation } from "@/study-settings/types/image-rotation";

const IMAGE_ROTATION_KEY = "blinks.image-rotation-degrees";
const DEFAULT_IMAGE_ROTATION: ImageRotation = 0;

let cachedImageRotation: ImageRotation | null = null;

export const getCurrentImageRotation = (): ImageRotation =>
  cachedImageRotation ?? DEFAULT_IMAGE_ROTATION;

// The rotation belongs to the physical camera/phone setup, so it intentionally
// survives sign-out and is shared by every participant account on this device.
export const loadImageRotation = async (): Promise<ImageRotation> => {
  if (cachedImageRotation !== null) return cachedImageRotation;

  try {
    const storedValue = await SecureStore.getItemAsync(IMAGE_ROTATION_KEY);
    const parsedValue = Number(storedValue);
    cachedImageRotation = isImageRotation(parsedValue)
      ? parsedValue
      : DEFAULT_IMAGE_ROTATION;
  } catch {
    cachedImageRotation = DEFAULT_IMAGE_ROTATION;
  }

  return cachedImageRotation;
};

export const storeImageRotation = async (
  rotation: ImageRotation,
): Promise<void> => {
  // Update the in-memory value first so an active recorder uses the selection
  // for the very next frame instead of waiting for SecureStore I/O.
  const previousRotation = cachedImageRotation;
  cachedImageRotation = rotation;
  try {
    await SecureStore.setItemAsync(IMAGE_ROTATION_KEY, String(rotation));
  } catch (error) {
    cachedImageRotation = previousRotation;
    throw error;
  }
};
