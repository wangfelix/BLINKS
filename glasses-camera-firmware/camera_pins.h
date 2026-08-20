#ifndef BLINKS_GLASSES_CAMERA_PINS_H
#define BLINKS_GLASSES_CAMERA_PINS_H

#if !defined(CAMERA_MODEL_BLINKS_GLASSES)
#error "Select CAMERA_MODEL_BLINKS_GLASSES before including camera_pins.h"
#endif

// ESP32-S3 GPIO numbers, taken from the module symbol's pin NAMES, which the
// schematic's "Recomended GPIO Table" repeats verbatim.
//
// The schematic also shows two other numbers per signal that are NOT GPIOs: the
// red module land number beside the symbol, and a stale "IOxx/" net-label prefix
// left over from the XIAO ESP32-S3 prototype (the wire labelled "IO40/CAM_SDA"
// lands on module pin IO35). Both are tabulated in
// glasses-camera-diagnostic/README.md. Only the numbers below address hardware.
//
// GPIO33..GPIO37 (Y2, Y6, SDA, SCL, VSYNC) are free only because this is the
// -N4R2 variant with 2 MB QUAD PSRAM. Octal-PSRAM parts use GPIO33..37 for the
// PSRAM bus, so selecting "OPI PSRAM" in the Arduino IDE breaks five camera
// signals.
#define PWDN_GPIO_NUM   9
#define RESET_GPIO_NUM  8
#define XCLK_GPIO_NUM  40
#define SIOD_GPIO_NUM  35
#define SIOC_GPIO_NUM  36

#define Y9_GPIO_NUM    39  // D7
#define Y8_GPIO_NUM    41  // D6
#define Y7_GPIO_NUM    42  // D5
#define Y6_GPIO_NUM    34  // D4
#define Y5_GPIO_NUM    47  // D3
#define Y4_GPIO_NUM    18  // D2
#define Y3_GPIO_NUM    21  // D1
#define Y2_GPIO_NUM    33  // D0
#define VSYNC_GPIO_NUM 37
#define HREF_GPIO_NUM  38
#define PCLK_GPIO_NUM  48

#endif  // BLINKS_GLASSES_CAMERA_PINS_H
