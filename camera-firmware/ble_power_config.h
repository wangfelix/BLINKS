#pragma once

// Arduino-ESP32 compiles its Bluetooth controller configuration into the
// NimBLE initialization code. Pre-include this header for the sketch and its
// libraries so NimBLE initializes the ESP32-S3 controller in modem-sleep mode.
#include "sdkconfig.h"

#if !defined(CONFIG_IDF_TARGET_ESP32S3)
#error "BLINKS BLE power settings require an ESP32-S3 target"
#endif

#undef CONFIG_BT_CTRL_SLEEP_MODE_EFF
#define CONFIG_BT_CTRL_SLEEP_MODE_EFF 1

// The XIAO ESP32-S3 has the main 40 MHz crystal required by controller modem
// sleep. This clock keeps BLE timing while the radio sleeps between events.
#undef CONFIG_BT_CTRL_SLEEP_CLOCK_EFF
#define CONFIG_BT_CTRL_SLEEP_CLOCK_EFF 1
