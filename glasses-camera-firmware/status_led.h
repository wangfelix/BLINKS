#ifndef BLINKS_GLASSES_STATUS_LED_H
#define BLINKS_GLASSES_STATUS_LED_H

#include <Arduino.h>
#include <Wire.h>

// ESP32 Arduino 3.3.8 builds esp32-camera with SCCB on I2C controller 1. The
// glasses' separate system I2C bus therefore uses controller 0 on GPIO12/GPIO11.
static TwoWire statusLedWire(0);

static constexpr int STATUS_I2C_SDA = 12;
static constexpr int STATUS_I2C_SCL = 11;
static constexpr uint8_t LP5815_ADDRESS = 0x2D;

static constexpr uint8_t LP5815_REG_CHIP_ENABLE = 0x00;
static constexpr uint8_t LP5815_REG_DEVICE_CONFIG_0 = 0x01;
static constexpr uint8_t LP5815_REG_DEVICE_CONFIG_1 = 0x02;
static constexpr uint8_t LP5815_REG_DEVICE_CONFIG_2 = 0x03;
static constexpr uint8_t LP5815_REG_DEVICE_CONFIG_3 = 0x04;
static constexpr uint8_t LP5815_REG_DEVICE_CONFIG_4 = 0x05;
static constexpr uint8_t LP5815_REG_RESET_COMMAND = 0x0E;
static constexpr uint8_t LP5815_REG_UPDATE_COMMAND = 0x0F;
static constexpr uint8_t LP5815_REG_FLAG_CLEAR = 0x13;
static constexpr uint8_t LP5815_REG_OUT0_DOT_CURRENT = 0x14;
static constexpr uint8_t LP5815_REG_OUT0_PWM = 0x18;

// Which LP5815 output drives the red LED. All three sinks are enabled because
// the connection confirmation flashes white, but an enabled sink at PWM 0 draws
// nothing, so idle cost is unchanged. TI's reference wiring is OUT0=red,
// OUT1=green, OUT2=blue, but the board has not been verified: if the searching
// flash comes up green or blue, change this to 1 or 2.
static constexpr uint8_t STATUS_LED_CHANNEL = 0;

// Analog current per lit channel, as a fraction of the LP5815's 25.5 mA
// ceiling. 0x18 is about 9%, so roughly 2.4 mA. Halving the current does not
// halve apparent brightness — the eye's response is roughly logarithmic, so
// this still reads as a clear flash. Prefer this knob over the PWM value for
// dimming: it lowers the instantaneous current, whereas PWM only shortens the
// on-time within each flash and leaves the peak where it was.
static constexpr uint8_t STATUS_LED_DOT_CURRENT = 0x18;

static bool statusLedReady = false;
// Last PWM value written to each sink, so only changed channels are re-sent.
static uint8_t statusLedPwm[3] = {0, 0, 0};

static bool lp5815Write(uint8_t reg, uint8_t value) {
  statusLedWire.beginTransmission(LP5815_ADDRESS);
  statusLedWire.write(reg);
  statusLedWire.write(value);
  return statusLedWire.endTransmission() == 0;
}

// Drive the three sinks, skipping any channel already at the requested value.
static bool lp5815WritePwm(uint8_t out0, uint8_t out1, uint8_t out2) {
  const uint8_t want[3] = {out0, out1, out2};
  bool ok = true;
  for (uint8_t channel = 0; channel < 3; channel++) {
    if (statusLedPwm[channel] == want[channel]) continue;
    if (!lp5815Write(LP5815_REG_OUT0_PWM + channel, want[channel])) {
      ok = false;
      continue;
    }
    statusLedPwm[channel] = want[channel];
  }
  return ok;
}

void initStatusLed() {
  statusLedWire.begin(STATUS_I2C_SDA, STATUS_I2C_SCL, 400000);
  delay(5);

  // Reset may be ignored while the LP5815 is in instant-blink mode. Enabling
  // the chip with instant blink disabled is the first required acknowledged
  // command.
  lp5815Write(LP5815_REG_RESET_COMMAND, 0xCC);
  delay(2);
  if (!lp5815Write(LP5815_REG_CHIP_ENABLE, 0x03)) {
    Serial.println("LP5815 status LED unavailable; continuing without it");
    return;
  }

  bool ok = true;
  ok = lp5815Write(LP5815_REG_DEVICE_CONFIG_0, 0x00) && ok;
  // DEVICE_CONFIG_1 bits 2..0 enable OUT2..OUT0. All three are needed for the
  // white connection confirmation; a sink at PWM 0 costs nothing.
  ok = lp5815Write(LP5815_REG_DEVICE_CONFIG_1, 0x07) && ok;
  ok = lp5815Write(LP5815_REG_DEVICE_CONFIG_2, 0x00) && ok;
  ok = lp5815Write(LP5815_REG_DEVICE_CONFIG_3, 0x00) && ok;
  ok = lp5815Write(LP5815_REG_DEVICE_CONFIG_4, 0x00) && ok;
  ok = lp5815Write(LP5815_REG_UPDATE_COMMAND, 0x55) && ok;
  delay(2);

  for (uint8_t channel = 0; channel < 3; channel++) {
    ok = lp5815Write(LP5815_REG_OUT0_DOT_CURRENT + channel,
                     STATUS_LED_DOT_CURRENT) && ok;
  }
  ok = lp5815WritePwm(0x00, 0x00, 0x00) && ok;
  ok = lp5815Write(LP5815_REG_FLAG_CLEAR, 0x03) && ok;

  if (!ok) {
    Serial.println(
        "LP5815 status LED initialization failed; continuing without it");
    return;
  }

  statusLedReady = true;
  Serial.println("LP5815 status LED ready on I2C controller 0");
}

// The searching indicator: red channel only.
void setLed(bool on) {
  if (!statusLedReady) return;
  const uint8_t level = on ? 0xFF : 0x00;
  uint8_t pwm[3] = {0, 0, 0};
  pwm[STATUS_LED_CHANNEL] = level;
  if (!lp5815WritePwm(pwm[0], pwm[1], pwm[2])) {
    statusLedReady = false;
    Serial.println("LP5815 status LED write failed; LED disabled");
  }
}

// The connection confirmation: all three channels, so it reads as white and is
// unmistakably different from the red searching flash.
void setLedWhite(bool on) {
  if (!statusLedReady) return;
  const uint8_t level = on ? 0xFF : 0x00;
  if (!lp5815WritePwm(level, level, level)) {
    statusLedReady = false;
    Serial.println("LP5815 status LED write failed; LED disabled");
  }
}

#endif  // BLINKS_GLASSES_STATUS_LED_H
