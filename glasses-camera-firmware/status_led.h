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

// 0x30 is about 19% of the 25.5 mA/channel ceiling. All three channels are
// driven equally, so the LED is white and does not depend on RGB channel order.
static constexpr uint8_t STATUS_LED_DOT_CURRENT = 0x30;

static bool statusLedReady = false;
static bool statusLedOn = false;

static bool lp5815Write(uint8_t reg, uint8_t value) {
  statusLedWire.beginTransmission(LP5815_ADDRESS);
  statusLedWire.write(reg);
  statusLedWire.write(value);
  return statusLedWire.endTransmission() == 0;
}

static bool lp5815WriteWhite(uint8_t pwm) {
  bool ok = true;
  for (uint8_t channel = 0; channel < 3; channel++) {
    ok = lp5815Write(LP5815_REG_OUT0_PWM + channel, pwm) && ok;
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
  ok = lp5815Write(LP5815_REG_DEVICE_CONFIG_1, 0x07) && ok;
  ok = lp5815Write(LP5815_REG_DEVICE_CONFIG_2, 0x00) && ok;
  ok = lp5815Write(LP5815_REG_DEVICE_CONFIG_3, 0x00) && ok;
  ok = lp5815Write(LP5815_REG_DEVICE_CONFIG_4, 0x00) && ok;
  ok = lp5815Write(LP5815_REG_UPDATE_COMMAND, 0x55) && ok;
  delay(2);

  for (uint8_t channel = 0; channel < 3; channel++) {
    ok = lp5815Write(
        LP5815_REG_OUT0_DOT_CURRENT + channel,
        STATUS_LED_DOT_CURRENT) && ok;
  }
  ok = lp5815WriteWhite(0x00) && ok;
  ok = lp5815Write(LP5815_REG_FLAG_CLEAR, 0x03) && ok;

  if (!ok) {
    Serial.println(
        "LP5815 status LED initialization failed; continuing without it");
    return;
  }

  statusLedReady = true;
  statusLedOn = false;
  Serial.println("LP5815 status LED ready on I2C controller 0");
}

void setLed(bool on) {
  if (!statusLedReady) return;
  if (statusLedOn == on) return;

  if (!lp5815WriteWhite(on ? 0xFF : 0x00)) {
    statusLedReady = false;
    Serial.println("LP5815 status LED write failed; LED disabled");
    return;
  }

  statusLedOn = on;
}

#endif  // BLINKS_GLASSES_STATUS_LED_H
