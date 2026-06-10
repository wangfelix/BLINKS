// BLE identifiers and framing — MUST match camera-firmware/camera-firmware.ino.
export const BLE_DEVICE_NAME = "BLINKS-CAM";
export const BLE_SERVICE_UUID = "9a8b7c6d-0001-4a5b-8c9d-0e1f2a3b4c5d";
export const BLE_FRAME_CHARACTERISTIC_UUID =
  "9a8b7c6d-0002-4a5b-8c9d-0e1f2a3b4c5d";
export const BLE_CONTROL_CHARACTERISTIC_UUID =
  "9a8b7c6d-0003-4a5b-8c9d-0e1f2a3b4c5d";

// Control opcodes (phone -> camera, single byte).
export const CONTROL_OPCODE_PAUSE = 0x01;
export const CONTROL_OPCODE_RESUME = 0x02;

// Tagged notification framing:
//   header [0x01][jpeg length BE 4B][camera frame counter BE 4B]
//   data   [0x02][payload...]
export const FRAME_TAG_HEADER = 0x01;
export const FRAME_TAG_DATA = 0x02;

// A VGA JPEG is 15-55 KB; anything past this is a corrupt header.
export const MAX_FRAME_BYTES = 200_000;

// A frame whose chunks stop arriving for this long is abandoned; the next
// header resynchronises the stream.
export const FRAME_TIMEOUT_MS = 10_000;
