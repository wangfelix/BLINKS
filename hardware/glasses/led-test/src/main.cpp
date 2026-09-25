/*
 * Bluff Band - RGB LED blink test
 * ---------------------------------------------------------------
 * Target : ESP32-S3-MINI-1-N4R2, Arduino framework (PlatformIO)
 * Device : TI LP5815 3-channel RGB LED driver
 * Bus    : I2C @ 0x2D, SDA = IO12, SCL = IO11
 *
 * Cycles the RGB LED red -> green -> blue -> white -> off.
 */

#include <Arduino.h>
#include <Wire.h>

// ------------------------------------------------------------------
// Board wiring
// ------------------------------------------------------------------
static const int PIN_I2C_SDA = 12;
static const int PIN_I2C_SCL = 11;

// LP5815 STAT pin. If you routed it to a GPIO, put the number here so
// we can hold it LOW. Leave at -1 if it only has the 100k pull-down.
static const int PIN_LP5815_STAT = -1;

static const uint8_t LP5815_ADDR = 0x2D;

// Which LP5815 output drives which LED colour.
// TI's reference wiring is OUT0=red, OUT1=green, OUT2=blue.
// >>> Verify against your schematic and swap if needed. <<<
static const uint8_t CH_RED   = 0;
static const uint8_t CH_GREEN = 1;
static const uint8_t CH_BLUE  = 2;

// Analog current per channel (Dot Current, 8 bit, ratio of IOUT_MAX).
// With MAX_CURRENT = 0 the ceiling is 25.5 mA, so 0x30 (48/255 = 19 %)
// gives roughly 4.8 mA -- a dim status indicator, not a flashlight.
static const uint8_t DOT_CURRENT = 0x30;

// ------------------------------------------------------------------
// LP5815 register map (8-bit register addresses, single address byte)
// ------------------------------------------------------------------
static const uint8_t REG_CHIP_EN     = 0x00; // bit0 CHIP_EN, bit1 INSTABLINK_DIS
static const uint8_t REG_DEV_CONFIG0 = 0x01; // bit0 MAX_CURRENT (0 = 25.5 mA)
static const uint8_t REG_DEV_CONFIG1 = 0x02; // bits2..0 OUT2/1/0_EN
static const uint8_t REG_DEV_CONFIG2 = 0x03; // fade time + per-channel fade enable
static const uint8_t REG_DEV_CONFIG3 = 0x04; // exponential dimming + auto-animation
static const uint8_t REG_DEV_CONFIG4 = 0x05; // animation engine mapping
static const uint8_t REG_RESET_CMD   = 0x0E; // write 0xCC
static const uint8_t REG_UPDATE_CMD  = 0x0F; // write 0x55
static const uint8_t REG_STOP_CMD    = 0x11; // write 0xAA
static const uint8_t REG_FLAG_CLR    = 0x13; // bit1 TSD_CLR, bit0 POR_CLR
static const uint8_t REG_OUT0_DC     = 0x14; // 0x14/0x15/0x16
static const uint8_t REG_OUT0_PWM    = 0x18; // 0x18/0x19/0x1A
static const uint8_t REG_FLAG        = 0x40; // busy / TSD / POR status

// ------------------------------------------------------------------
// Low-level I2C helpers
// ------------------------------------------------------------------
static bool lp5815Write(uint8_t reg, uint8_t value) {
  Wire.beginTransmission(LP5815_ADDR);
  Wire.write(reg);
  Wire.write(value);
  uint8_t err = Wire.endTransmission();
  if (err != 0) {
    Serial.printf("  I2C write reg 0x%02X failed (err %u)\n", reg, err);
    return false;
  }
  return true;
}

static bool lp5815Read(uint8_t reg, uint8_t &value) {
  Wire.beginTransmission(LP5815_ADDR);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return false;   // repeated START
  if (Wire.requestFrom((int)LP5815_ADDR, 1) != 1) return false;
  value = Wire.read();
  return true;
}

// ------------------------------------------------------------------
// Driver
// ------------------------------------------------------------------
static void setRGB(uint8_t r, uint8_t g, uint8_t b) {
  // Manual mode: PWM registers take effect immediately, no UPDATE needed.
  lp5815Write(REG_OUT0_PWM + CH_RED,   r);
  lp5815Write(REG_OUT0_PWM + CH_GREEN, g);
  lp5815Write(REG_OUT0_PWM + CH_BLUE,  b);
}

static bool lp5815Begin() {
  // Optional clean slate. Ignored if the chip is in instant-blink mode.
  lp5815Write(REG_RESET_CMD, 0xCC);
  delay(2);

  // 1) Disable instant blinking (bit1) AND enable the chip (bit0).
  //    Instant-blink mode makes the device ignore all software commands,
  //    so this has to happen before anything else.
  if (!lp5815Write(REG_CHIP_EN, 0x03)) {
    Serial.println("  LP5815 did not ACK - check wiring, address, VCC");
    return false;
  }
  delay(2);

  // 2) Global max current: 0 = 25.5 mA per channel.
  lp5815Write(REG_DEV_CONFIG0, 0x00);

  // 3) Enable all three current sinks.
  lp5815Write(REG_DEV_CONFIG1, 0x07);

  // 4) No fading, manual PWM mode, linear dimming curve.
  lp5815Write(REG_DEV_CONFIG2, 0x00);
  lp5815Write(REG_DEV_CONFIG3, 0x00);
  lp5815Write(REG_DEV_CONFIG4, 0x00);

  // 5) *** Latch DEV_CONFIG0..4. Without this they have no effect. ***
  lp5815Write(REG_UPDATE_CMD, 0x55);
  delay(2);

  // 6) Per-channel analog current. Resets to 0x00 = NO current, so the
  //    LED stays dark no matter what you write to the PWM registers.
  lp5815Write(REG_OUT0_DC + 0, DOT_CURRENT);
  lp5815Write(REG_OUT0_DC + 1, DOT_CURRENT);
  lp5815Write(REG_OUT0_DC + 2, DOT_CURRENT);

  // 7) Start dark, then clear the power-on-reset / thermal flags.
  setRGB(0, 0, 0);
  lp5815Write(REG_FLAG_CLR, 0x03);
  return true;
}

static void scanI2C() {
  Serial.println("I2C scan:");
  uint8_t found = 0;
  for (uint8_t addr = 0x08; addr < 0x78; addr++) {
    Wire.beginTransmission(addr);
    if (Wire.endTransmission() == 0) {
      Serial.printf("  device at 0x%02X\n", addr);
      found++;
    }
  }
  if (found == 0) Serial.println("  nothing found - check pull-ups and power");
}

// ------------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  delay(1500);                       // give the USB CDC port time to enumerate
  Serial.println("\nBluff Band - LP5815 RGB test");

  if (PIN_LP5815_STAT >= 0) {        // keep STAT low -> no instant blinking
    pinMode(PIN_LP5815_STAT, OUTPUT);
    digitalWrite(PIN_LP5815_STAT, LOW);
  }

  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL, 400000);
  delay(5);                          // LP5815 needs ~1 ms after VCC is up

  scanI2C();

  if (lp5815Begin()) {
    Serial.println("LP5815 initialised");
    uint8_t flag;
    if (lp5815Read(REG_FLAG, flag)) Serial.printf("FLAG = 0x%02X\n", flag);
  } else {
    Serial.println("LP5815 init FAILED");
  }
}

void loop() {
  const uint8_t LVL = 0xFF;          // PWM duty; brightness ceiling is DOT_CURRENT
  const uint16_t STEP_MS = 500;

  setRGB(LVL, 0, 0);   delay(STEP_MS);   // red
  setRGB(0, LVL, 0);   delay(STEP_MS);   // green
  setRGB(0, 0, LVL);   delay(STEP_MS);   // blue
  setRGB(LVL, LVL, LVL); delay(STEP_MS); // white
  setRGB(0, 0, 0);     delay(STEP_MS);   // off
}