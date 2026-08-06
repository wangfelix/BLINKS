export const IMAGE_ROTATIONS = [0, 90, 180, 270] as const;

export type ImageRotation = (typeof IMAGE_ROTATIONS)[number];

export const isImageRotation = (value: number): value is ImageRotation =>
  IMAGE_ROTATIONS.some((rotation) => rotation === value);

