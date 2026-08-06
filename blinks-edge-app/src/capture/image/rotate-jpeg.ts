import { File, Paths } from "expo-file-system";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import type {
  ImageManipulatorContext,
  ImageRef,
} from "expo-image-manipulator";

import type { ImageRotation } from "@/study-settings/types/image-rotation";

let nextTemporaryFrameId = 0;

const deleteIfPresent = (file: File | null): void => {
  if (!file?.exists) return;
  try {
    file.delete();
  } catch {
    // Cache cleanup must never turn a successfully rotated frame into a loss.
  }
};

// expo-image-manipulator works from file URIs. The BLE JPEG is therefore
// written to the app cache, rotated clockwise as real pixels, read back into
// memory for the WebSocket uploader, and immediately removed from the cache.
export const rotateJpeg = async (
  bytes: Uint8Array,
  rotation: ImageRotation,
): Promise<Uint8Array> => {
  if (rotation === 0) return bytes;

  const temporaryId = `${Date.now()}-${nextTemporaryFrameId}`;
  nextTemporaryFrameId += 1;
  const sourceFile = new File(
    Paths.cache,
    `blinks-frame-${temporaryId}-source.jpg`,
  );
  let outputFile: File | null = null;
  let context: ImageManipulatorContext | null = null;
  let imageRef: ImageRef | null = null;

  try {
    sourceFile.create({ overwrite: true });
    sourceFile.write(bytes);

    context = ImageManipulator.manipulate(sourceFile.uri);
    context.rotate(rotation);
    imageRef = await context.renderAsync();
    const result = await imageRef.saveAsync({
      compress: 1,
      format: SaveFormat.JPEG,
    });
    outputFile = new File(result.uri);
    return await outputFile.bytes();
  } finally {
    imageRef?.release();
    context?.release();
    deleteIfPresent(outputFile);
    deleteIfPresent(sourceFile);
  }
};

