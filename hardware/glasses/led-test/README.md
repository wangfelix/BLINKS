# Historical LP5815 LED bring-up test

This PlatformIO example was imported unchanged from the original hardware
repository. It cycles the LP5815 indicator through red, green, blue, white and
off, and prints an I²C scan. It does not capture images or communicate with the
BLINKS phone application.

The source still prints its original “Bluff Band” label. It targets an
ESP32-S3-MINI-1-N4R2 with I²C SDA on GPIO12, SCL on GPIO11 and the LP5815 at
address `0x2D`. Confirm compatibility with the actual board before use.

The original `platformio.ini` uses an unpinned `espressif32` platform. This import
has not rebuilt or flashed the example; it does not claim compatibility with the
current production firmware toolchain.

For recording, use the [glasses firmware build](../../../glasses-camera-firmware-pio/README.md).
See [hardware provenance](../../PROVENANCE.md) for the original revision.
