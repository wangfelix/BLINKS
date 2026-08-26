// Single source of truth: this build compiles the same sketch as the Arduino
// target in glasses-camera-firmware/. Only the toolchain and sdkconfig differ,
// so the two cannot drift apart.
//
// The sketch defines every function before it is used, so it needs none of the
// Arduino preprocessor's generated prototypes and is valid C++ as-is.
#include "../../glasses-camera-firmware/glasses-camera-firmware.ino"
