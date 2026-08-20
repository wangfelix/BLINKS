#include <Arduino.h>
#include <Wire.h>
#include <esp_camera.h>
#include <esp_err.h>

// Camera bring-up sketch for the custom Blinks glasses PCB (v7).
//
// v6 established that the 2V8 camera rail is down: 3V3 is up, but all four nets
// referenced to 2V8 read low, and a battery made no difference. v7 answers the
// two questions that follow from that.
//
//   Step 2  Is the REST of the board alive? Scans the system I2C bus for the
//           five chips listed on the schematic. If they all answer, the board
//           is well assembled and only the camera supply is missing, which
//           means a switch rather than a fault.
//   Step 3  Is there an on-switch? Walks every plausible enable pin, nudges it
//           high through the ESP32's internal ~45k pull-up, and re-checks the
//           2V8 witnesses. 45k is far too weak to fight or damage another
//           driver, so this cannot harm the board, but it is strong enough to
//           wake a regulator whose enable input is floating or weakly pulled
//           down.
//
// The camera probe and esp_camera_init() only run if 2V8 actually comes up.

namespace {

// ---------------------------------------------------------------------------
// Pin maps
// ---------------------------------------------------------------------------

// Recommended GPIO Table from the schematic. These are ESP32-S3 GPIO numbers
// and match the module symbol's pin NAMES (pin 31 is named IO35, so GPIO35).
constexpr int PIN_PWDN = 9;
constexpr int PIN_RESET = 8;
constexpr int PIN_XCLK = 40;
constexpr int PIN_SDA = 35;
constexpr int PIN_SCL = 36;

// System I2C bus carrying the LP5815 and the sensors.
constexpr int PIN_SYS_SDA = 12;
constexpr int PIN_SYS_SCL = 11;

constexpr uint32_t CAMERA_XCLK_HZ = 20000000;
constexpr uint32_t SCCB_HZ = 100000;
constexpr uint32_t SYS_I2C_HZ = 100000;
constexpr uint16_t I2C_TIMEOUT_MS = 25;
constexpr uint8_t OV2640_SCCB_ADDRESS = 0x30;   // 0x60 >> 1
constexpr uint8_t OV3660_SCCB_ADDRESS = 0x3C;   // 0x78 >> 1

// esp32-camera in ESP32 Arduino 3.3.8 is built with CONFIG_SCCB_HARDWARE_I2C_
// PORT1, so the diagnostic probes controller 1 to match the driver.
TwoWire cameraWire1(1);
TwoWire systemWire0(0);

struct PinUnderTest {
  int gpio;
  const char *net;
  bool expectExternalPullUp;
};

// Four separate nets are referenced to the 2V8 camera rail: R17/R16 pull
// CAM_SDA/CAM_SCL up on the MCU page, R13/R3 pull CAM_RESET/CAM_PWDN up on the
// camera page. All four resistors sit on the ESP32 side of the FPC, so they
// read HIGH whenever 2V8 is present, with or without a camera plugged in.
constexpr int RAIL_2V8_WITNESSES[] = {35, 36, 8, 9};

const PinUnderTest PIN_CENSUS[] = {
    {12, "SDA (system I2C, 4.7k to 3V3, control)", true},
    {11, "SCL (system I2C, 4.7k to 3V3, control)", true},
    {35, "CAM_SDA (R17, 4.7k to 2V8)", true},
    {36, "CAM_SCL (R16, 4.7k to 2V8)", true},
    {8, "CAM_RESET (R13, 10k to 2V8)", true},
    {9, "CAM_PWDN (R3, 10k to 2V8)", true},
    {37, "DVP_VSYNC", false},
    {38, "DVP_HREF", false},
    {48, "DVP_PCLK", false},
    {39, "DVP_Y9", false},
    {41, "DVP_Y8", false},
    {42, "DVP_Y7", false},
    {34, "DVP_Y6", false},
    {47, "DVP_Y5", false},
    {18, "DVP_Y4", false},
    {21, "DVP_Y3", false},
    {33, "DVP_Y2", false},
    {40, "XMCLK", false},
};

struct KnownChip {
  uint8_t address;
  const char *name;
};

// The I2C address list printed on the MCU page of the schematic.
const KnownChip SYSTEM_CHIPS[] = {
    {0x14, "Magnetometer"},
    {0x2D, "LP5815 status LED driver"},
    {0x55, "Fuel gauge"},
    {0x57, "PPG sensor"},
    {0x68, "IMU"},
};

// Addresses found on the system bus that the schematic does not list. These get
// a read-only register dump so they can be identified.
constexpr size_t MAX_UNLISTED = 8;
uint8_t unlistedAddresses[MAX_UNLISTED] = {0};
size_t unlistedCount = 0;

struct EnableCandidate {
  int gpio;
  const char *name;
};

// Every GPIO on this board that could plausibly gate a power rail, taken from
// the schematic's Recommended GPIO Table. Deliberately excluded: the camera
// pins themselves (they are the witnesses), the strapping pins GPIO0/3/45/46,
// the 32.768 kHz crystal on GPIO15/16, USB on GPIO19/20, UART0 on GPIO43/44,
// and GPIO26 which the PSRAM uses.
const EnableCandidate ENABLE_CANDIDATES[] = {
    {7, "SD_ENABLE"},
    {13, "GPOUT"},
    {10, "MUX_STATUS"},
    {17, "BTN"},
    {14, "#ERROR"},
    {4, "SD_STATE"},
    {6, "SPI_CS_SD"},
    {5, "SPI_MOSI_SD"},
    {2, "SPI_CLK_SD"},
    {1, "SPI_MISO_SD"},
};

bool censusPulledUp[sizeof(PIN_CENSUS) / sizeof(PIN_CENSUS[0])] = {false};
int xclkAttachedPin = -1;

void flushOut() {
  Serial.flush();
  delay(5);
}

const char *wireErrorName(uint8_t error) {
  switch (error) {
    case 0: return "ACK";
    case 1: return "data too long";
    case 2: return "address NACK";
    case 3: return "data NACK";
    case 4: return "other I2C error";
    case 5: return "timeout";
    default: return "unknown I2C error";
  }
}

// An external pull-up beats the ESP32's ~45k internal pull-down, so a pin that
// still reads HIGH with the internal pull-down engaged is sitting on a powered,
// externally pulled-up net. A floating pin reads LOW.
bool pinHasExternalPullUp(int gpio) {
  pinMode(gpio, INPUT_PULLDOWN);
  delay(5);
  const bool pulled = digitalRead(gpio) == HIGH;
  pinMode(gpio, INPUT);
  return pulled;
}

// True when ANY of the four 2V8-referenced nets shows its pull-up.
bool rail2V8IsUp() {
  for (int gpio : RAIL_2V8_WITNESSES) {
    if (pinHasExternalPullUp(gpio)) return true;
  }
  return false;
}

bool censusResultFor(int gpio) {
  for (size_t i = 0; i < sizeof(PIN_CENSUS) / sizeof(PIN_CENSUS[0]); i++) {
    if (PIN_CENSUS[i].gpio == gpio) return censusPulledUp[i];
  }
  return false;
}

// ---------------------------------------------------------------------------
// Step 0: board configuration
// ---------------------------------------------------------------------------

void reportBoardConfiguration() {
  Serial.println("== Step 0: board and build configuration ==");
  Serial.printf("Chip: %s rev %u, %u core(s)\n", ESP.getChipModel(),
                (unsigned)ESP.getChipRevision(), (unsigned)ESP.getChipCores());
  Serial.printf("Flash configured: %u bytes\n",
                (unsigned)ESP.getFlashChipSize());

  const bool psram = psramFound();
  const size_t psramSize = ESP.getPsramSize();
  Serial.printf("PSRAM: %s, size %u bytes\n", psram ? "found" : "NOT FOUND",
                (unsigned)psramSize);

  if (!psram) {
    Serial.println(
        "  !! The -N4R2 module has 2 MB QUAD PSRAM. No PSRAM here means the IDE "
        "PSRAM menu is 'Disabled' or wrongly set to 'OPI PSRAM'. With 'OPI "
        "PSRAM', GPIO33..GPIO37 are taken over by the PSRAM controller and five "
        "camera signals die. Select 'QSPI PSRAM'.");
  } else if (psramSize < 1500000 || psramSize > 2500000) {
    Serial.printf(
        "  !! Expected about 2 MB of PSRAM for -N4R2 but found %u bytes.\n",
        (unsigned)psramSize);
  } else {
    Serial.println(
        "  OK: quad PSRAM present, so GPIO33..GPIO37 are free for the camera.");
  }
  flushOut();
}

// ---------------------------------------------------------------------------
// Step 1: external pull-up census
// ---------------------------------------------------------------------------

void runPullUpCensus() {
  Serial.println();
  Serial.println("== Step 1: external pull-up census ==");
  Serial.println(
      "A pin reading HIGH against the internal pull-down is on a powered net "
      "with an external pull-up.");
  flushOut();

  for (size_t i = 0; i < sizeof(PIN_CENSUS) / sizeof(PIN_CENSUS[0]); i++) {
    const PinUnderTest &p = PIN_CENSUS[i];
    censusPulledUp[i] = pinHasExternalPullUp(p.gpio);
    Serial.printf("  GPIO%-2d  pulled=%-4s  %s%s\n", p.gpio,
                  censusPulledUp[i] ? "HIGH" : "LOW", p.net,
                  (p.expectExternalPullUp && !censusPulledUp[i])
                      ? "   <-- EXPECTED A PULL-UP HERE"
                      : "");
    flushOut();
  }

  const bool controlOk = censusResultFor(12) && censusResultFor(11);
  Serial.println();
  Serial.println(controlOk
                     ? "  3V3 rail: UP (system I2C pull-ups visible)."
                     : "  3V3 rail: pull-ups NOT visible. Treat everything "
                       "below as unreliable.");
  flushOut();
}

// ---------------------------------------------------------------------------
// Step 2: system I2C inventory
// ---------------------------------------------------------------------------

void inventorySystemBus() {
  Serial.println();
  Serial.println("== Step 2: is the rest of the board alive? ==");
  Serial.printf("Scanning system I2C on SDA GPIO%d / SCL GPIO%d\n", PIN_SYS_SDA,
                PIN_SYS_SCL);
  flushOut();

  systemWire0.setTimeOut(I2C_TIMEOUT_MS);
  if (!systemWire0.begin(PIN_SYS_SDA, PIN_SYS_SCL, SYS_I2C_HZ)) {
    Serial.println("  Failed to start the system I2C controller");
    flushOut();
    return;
  }

  bool present[sizeof(SYSTEM_CHIPS) / sizeof(SYSTEM_CHIPS[0])] = {false};
  uint8_t totalFound = 0;
  for (uint8_t address = 0x08; address <= 0x77; address++) {
    systemWire0.beginTransmission(address);
    if (systemWire0.endTransmission(true) != 0) continue;
    totalFound++;

    const char *name = "unlisted device";
    bool listed = false;
    for (size_t i = 0; i < sizeof(SYSTEM_CHIPS) / sizeof(SYSTEM_CHIPS[0]); i++) {
      if (SYSTEM_CHIPS[i].address == address) {
        present[i] = true;
        listed = true;
        name = SYSTEM_CHIPS[i].name;
      }
    }
    if (!listed && unlistedCount < MAX_UNLISTED) {
      unlistedAddresses[unlistedCount++] = address;
    }
    Serial.printf("  found 0x%02X  %s\n", address, name);
    flushOut();
  }

  uint8_t expectedFound = 0;
  for (size_t i = 0; i < sizeof(SYSTEM_CHIPS) / sizeof(SYSTEM_CHIPS[0]); i++) {
    if (present[i]) {
      expectedFound++;
    } else {
      Serial.printf("  MISSING 0x%02X  %s\n", SYSTEM_CHIPS[i].address,
                    SYSTEM_CHIPS[i].name);
    }
  }

  Serial.printf("  %u of %u expected chips answered (%u devices total)\n",
                (unsigned)expectedFound,
                (unsigned)(sizeof(SYSTEM_CHIPS) / sizeof(SYSTEM_CHIPS[0])),
                (unsigned)totalFound);
  if (expectedFound == 0) {
    Serial.println(
        "  => Nothing on the system bus answers. The problem is bigger than the "
        "camera: this board is not working as built.");
  } else if (expectedFound < sizeof(SYSTEM_CHIPS) / sizeof(SYSTEM_CHIPS[0])) {
    Serial.println(
        "  => Some chips answer and some do not. Partial assembly or a second "
        "missing supply rail, not only the camera's.");
  } else {
    Serial.println(
        "  => The whole sensor suite answers. The board is assembled and "
        "working; only the camera supply is missing.");
  }

  systemWire0.end();
  delay(5);
  flushOut();
}

// ---------------------------------------------------------------------------
// Step 2b: identify unlisted devices
// ---------------------------------------------------------------------------

bool readReg(TwoWire &wire, uint8_t address, uint8_t reg, uint8_t &value) {
  wire.beginTransmission(address);
  wire.write(reg);
  if (wire.endTransmission(false) != 0) return false;  // repeated START
  if (wire.requestFrom(address, static_cast<uint8_t>(1), true) != 1) return false;
  value = wire.read();
  return true;
}

// Reads only. No register on a power-management or sensor IC changes state
// because it was read, so this cannot alter the board's configuration.
void identifyUnlistedDevices() {
  if (unlistedCount == 0) return;

  Serial.println();
  Serial.println("== Step 2b: identifying devices the schematic does not list ==");
  Serial.println(
      "Read-only register dump. Reading cannot change the board's state.");
  flushOut();

  systemWire0.setTimeOut(I2C_TIMEOUT_MS);
  if (!systemWire0.begin(PIN_SYS_SDA, PIN_SYS_SCL, SYS_I2C_HZ)) return;

  for (size_t i = 0; i < unlistedCount; i++) {
    const uint8_t address = unlistedAddresses[i];
    Serial.printf("\n  Device at 0x%02X, registers 0x00..0x1F:\n", address);

    for (uint8_t base = 0x00; base < 0x20; base += 8) {
      Serial.printf("    %02X:", base);
      for (uint8_t offset = 0; offset < 8; offset++) {
        uint8_t value = 0;
        if (readReg(systemWire0, address, base + offset, value)) {
          Serial.printf(" %02X", value);
        } else {
          Serial.print(" --");
        }
      }
      Serial.println();
      flushOut();
    }

    // X-Powers PMICs are the best-known occupants of 0x34 and report a chip ID
    // in register 0x03. If this is one of them it very likely owns the 1V8 and
    // 2V8 rails, which would make the camera supply an I2C configuration step
    // rather than a hardware fault.
    uint8_t id = 0;
    if (readReg(systemWire0, address, 0x03, id)) {
      if (id == 0x03) {
        Serial.println("    Register 0x03 = 0x03: matches AXP192 PMIC");
      } else if (id == 0x4A) {
        Serial.println("    Register 0x03 = 0x4A: matches AXP2101 PMIC");
      }
    }
  }

  systemWire0.end();
  delay(5);
  flushOut();
}

// ---------------------------------------------------------------------------
// Step 2c: battery state from the fuel gauge
// ---------------------------------------------------------------------------

constexpr uint8_t FUEL_GAUGE_ADDRESS = 0x55;

bool readLe16(TwoWire &wire, uint8_t address, uint8_t reg, uint16_t &value) {
  uint8_t lo = 0, hi = 0;
  if (!readReg(wire, address, reg, lo)) return false;
  if (!readReg(wire, address, reg + 1, hi)) return false;
  value = static_cast<uint16_t>(lo) | (static_cast<uint16_t>(hi) << 8);
  return true;
}

// The schematic does not say which BQ27xxx variant this is, and the family uses
// two different register maps: BQ27441-style puts Voltage at 0x04 and
// StateOfCharge at 0x1C, BQ27220-style puts them at 0x08 and 0x2C. Rather than
// guess, dump the whole standard-command block and flag every 16-bit value that
// falls in the plausible single-cell LiPo range. Reads only; nothing is written.
void reportBatteryState() {
  Serial.println();
  Serial.println("== Step 2c: battery state from the fuel gauge (0x55) ==");
  flushOut();

  systemWire0.setTimeOut(I2C_TIMEOUT_MS);
  if (!systemWire0.begin(PIN_SYS_SDA, PIN_SYS_SCL, SYS_I2C_HZ)) {
    Serial.println("  Could not start the system I2C controller");
    return;
  }

  uint8_t probe = 0;
  if (!readReg(systemWire0, FUEL_GAUGE_ADDRESS, 0x00, probe)) {
    Serial.println("  Fuel gauge does not respond; cannot read the battery.");
    systemWire0.end();
    flushOut();
    return;
  }

  Serial.println("  Raw standard-command block 0x00..0x3F:");
  uint8_t raw[0x40] = {0};
  for (uint8_t reg = 0; reg < 0x40; reg++) {
    if (!readReg(systemWire0, FUEL_GAUGE_ADDRESS, reg, raw[reg])) raw[reg] = 0xFF;
  }
  for (uint8_t base = 0x00; base < 0x40; base += 8) {
    Serial.printf("    %02X:", base);
    for (uint8_t offset = 0; offset < 8; offset++) {
      Serial.printf(" %02X", raw[base + offset]);
    }
    Serial.println();
    flushOut();
  }

  // A healthy single LiPo cell sits between about 3.0 V and 4.25 V. Anything in
  // that window is very likely the voltage register whichever variant this is.
  Serial.println("  16-bit values in the plausible cell-voltage range:");
  bool anyPlausible = false;
  for (uint8_t reg = 0; reg < 0x3F; reg += 2) {
    const uint16_t value =
        static_cast<uint16_t>(raw[reg]) | (static_cast<uint16_t>(raw[reg + 1]) << 8);
    if (value >= 2500 && value <= 4500) {
      Serial.printf("    reg 0x%02X = %u mV\n", reg, value);
      anyPlausible = true;
    }
  }
  if (!anyPlausible) {
    Serial.println(
        "    NONE. No register holds anything that looks like a cell voltage. "
        "Either the pack is completely flat/disconnected, or this gauge needs "
        "different commands.");
  }

  uint16_t v441 = 0, soc441 = 0, v220 = 0, soc220 = 0;
  readLe16(systemWire0, FUEL_GAUGE_ADDRESS, 0x04, v441);
  readLe16(systemWire0, FUEL_GAUGE_ADDRESS, 0x1C, soc441);
  readLe16(systemWire0, FUEL_GAUGE_ADDRESS, 0x08, v220);
  readLe16(systemWire0, FUEL_GAUGE_ADDRESS, 0x2C, soc220);
  Serial.printf("  If BQ27441-style: voltage %u mV, charge %u %%\n", v441, soc441);
  Serial.printf("  If BQ27220-style: voltage %u mV, charge %u %%\n", v220, soc220);

  Serial.println(
      "  Reading: above ~3700 mV the pack is fine and the camera rails should "
      "come up on battery. Below ~3300 mV it is flat. Near 0 means the gauge "
      "sees no pack at all, which would point at the connector rather than the "
      "charge state.");
  Serial.println(
      "  Note: with USB plugged in the pack is being charged, so this reads "
      "higher than its resting voltage.");

  // The power MUX reports which source it selected.
  pinMode(10, INPUT);
  delay(5);
  Serial.printf("  MUX_STATUS (GPIO10) reads %s\n",
                digitalRead(10) == HIGH ? "HIGH" : "LOW");

  systemWire0.end();
  delay(5);
  flushOut();
}

// ---------------------------------------------------------------------------
// Step 3: safe hunt for a rail enable
// ---------------------------------------------------------------------------

// Uses ONLY the ESP32's internal ~45k pull-up. That is far too weak to fight
// another driver on the same net, so it cannot damage the board, but it is
// strong enough to enable a regulator whose EN input floats or is weakly
// pulled down.
void huntForRailEnable() {
  Serial.println();
  Serial.println("== Step 3: safe hunt for a camera-rail enable ==");
  Serial.println(
      "Nudging each candidate pin high through the internal ~45k pull-up and "
      "re-checking the 2V8 witnesses. This cannot damage anything.");
  flushOut();

  int foundGpio = -1;
  const char *foundName = nullptr;

  for (const EnableCandidate &candidate : ENABLE_CANDIDATES) {
    pinMode(candidate.gpio, INPUT_PULLUP);
    delay(50);
    const bool up = rail2V8IsUp();
    Serial.printf("  GPIO%-2d %-14s -> 2V8 %s\n", candidate.gpio, candidate.name,
                  up ? "CAME UP" : "still down");
    flushOut();
    if (up) {
      foundGpio = candidate.gpio;
      foundName = candidate.name;
      break;
    }
    pinMode(candidate.gpio, INPUT);
  }

  if (foundGpio < 0) {
    Serial.println("  No single pin brought the rail up. Trying all together.");
    flushOut();
    for (const EnableCandidate &candidate : ENABLE_CANDIDATES) {
      pinMode(candidate.gpio, INPUT_PULLUP);
    }
    delay(100);
    if (rail2V8IsUp()) {
      Serial.println(
          "  2V8 CAME UP with all candidates pulled high at once. Re-run and "
          "bisect the list to find which one matters.");
      foundGpio = -2;
    } else {
      Serial.println("  All candidates pulled high at once: 2V8 still down.");
      for (const EnableCandidate &candidate : ENABLE_CANDIDATES) {
        pinMode(candidate.gpio, INPUT);
      }
    }
    flushOut();
  }

  if (foundGpio >= 0) {
    Serial.printf(
        "  => FOUND IT. GPIO%d (%s) enables the camera supply. The firmware "
        "fix is to drive it HIGH before esp_camera_init().\n",
        foundGpio, foundName);
    flushOut();
  }
}

// ---------------------------------------------------------------------------
// Step 4: camera probe, only worth running once 2V8 is up
// ---------------------------------------------------------------------------

bool startXclk(int gpio) {
  if (!ledcAttach(gpio, CAMERA_XCLK_HZ, 1) || !ledcWrite(gpio, 1)) {
    Serial.printf("  Failed to start XCLK on GPIO%d\n", gpio);
    return false;
  }
  xclkAttachedPin = gpio;
  Serial.printf("  %u MHz XCLK running on GPIO%d\n",
                (unsigned)(CAMERA_XCLK_HZ / 1000000), gpio);
  flushOut();
  return true;
}

void stopXclk() {
  if (xclkAttachedPin < 0) return;
  ledcDetach(xclkAttachedPin);
  xclkAttachedPin = -1;
}

// The OV2640 powers up with PWDN asserted and RESET low, then releases PWDN,
// then RESET, with XCLK already running.
void releaseCamera(bool pwdnActiveHigh) {
  const int released = pwdnActiveHigh ? LOW : HIGH;
  pinMode(PIN_PWDN, OUTPUT);
  pinMode(PIN_RESET, OUTPUT);
  digitalWrite(PIN_PWDN, pwdnActiveHigh ? HIGH : LOW);
  digitalWrite(PIN_RESET, LOW);
  delay(20);
  digitalWrite(PIN_PWDN, released);
  delay(10);
  digitalWrite(PIN_RESET, HIGH);
  delay(50);
  Serial.printf("  Camera released: PWDN GPIO%d %s (active-%s), RESET HIGH\n",
                PIN_PWDN, released == HIGH ? "HIGH" : "LOW",
                pwdnActiveHigh ? "high" : "low");
  flushOut();
}

bool readRegister(TwoWire &wire, uint8_t address, uint8_t reg, uint8_t &value) {
  wire.beginTransmission(address);
  wire.write(reg);
  if (wire.endTransmission(true) != 0) return false;
  if (wire.requestFrom(address, static_cast<uint8_t>(1), true) != 1) return false;
  value = wire.read();
  return true;
}

void printOv2640Identity(TwoWire &wire) {
  // Register 0xFF selects the OV2640 register bank; identity lives in bank 1.
  wire.beginTransmission(OV2640_SCCB_ADDRESS);
  wire.write(0xFF);
  wire.write(0x01);
  wire.endTransmission(true);

  uint8_t pidh = 0, ver = 0;
  if (readRegister(wire, OV2640_SCCB_ADDRESS, 0x0A, pidh) &&
      readRegister(wire, OV2640_SCCB_ADDRESS, 0x0B, ver)) {
    Serial.printf("  Sensor ID: PIDH=0x%02X VER=0x%02X\n", pidh, ver);
    Serial.println(pidh == 0x26 ? "  OV2640 identity confirmed"
                                : "  Unexpected sensor ID; expected 0x26");
  }
  flushOut();
}

uint8_t probeSccb() {
  pinMode(PIN_SDA, INPUT);
  pinMode(PIN_SCL, INPUT);
  delay(5);
  if (digitalRead(PIN_SDA) != HIGH || digitalRead(PIN_SCL) != HIGH) {
    Serial.println("  SCCB bus is not idle HIGH; skipping to avoid a stall.");
    flushOut();
    return 0;
  }

  cameraWire1.setTimeOut(I2C_TIMEOUT_MS);
  if (!cameraWire1.begin(PIN_SDA, PIN_SCL, SCCB_HZ)) return 0;
  delay(5);

  uint8_t found = 0;
  const uint8_t targets[] = {OV2640_SCCB_ADDRESS, OV3660_SCCB_ADDRESS};
  for (uint8_t target : targets) {
    cameraWire1.beginTransmission(target);
    const uint8_t error = cameraWire1.endTransmission(true);
    Serial.printf("  Probe 0x%02X: %s (%u)\n", target, wireErrorName(error),
                  error);
    flushOut();
    if (error == 0) {
      found = target;
      if (target == OV2640_SCCB_ADDRESS) printOv2640Identity(cameraWire1);
      break;
    }
  }

  cameraWire1.end();
  delay(5);
  return found;
}

void tryDriverInit() {
  Serial.println();
  Serial.println("== Step 5: esp_camera_init() ==");
  flushOut();
  stopXclk();
  delay(10);

  camera_config_t config = {};
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer = LEDC_TIMER_0;
  config.pin_d0 = 33;
  config.pin_d1 = 21;
  config.pin_d2 = 18;
  config.pin_d3 = 47;
  config.pin_d4 = 34;
  config.pin_d5 = 42;
  config.pin_d6 = 41;
  config.pin_d7 = 39;
  config.pin_xclk = PIN_XCLK;
  config.pin_pclk = 48;
  config.pin_vsync = 37;
  config.pin_href = 38;
  config.pin_sccb_sda = PIN_SDA;
  config.pin_sccb_scl = PIN_SCL;
  config.pin_pwdn = PIN_PWDN;
  config.pin_reset = PIN_RESET;
  config.xclk_freq_hz = CAMERA_XCLK_HZ;
  config.frame_size = FRAMESIZE_VGA;
  config.pixel_format = PIXFORMAT_JPEG;
  config.grab_mode = CAMERA_GRAB_WHEN_EMPTY;
  config.fb_location = psramFound() ? CAMERA_FB_IN_PSRAM : CAMERA_FB_IN_DRAM;
  config.jpeg_quality = 12;
  config.fb_count = 1;

  const esp_err_t err = esp_camera_init(&config);
  Serial.printf("  esp_camera_init: 0x%x (%s)\n", err, esp_err_to_name(err));
  flushOut();
  if (err != ESP_OK) {
    Serial.println(
        "  0x105 ESP_ERR_NOT_FOUND and 0x106 ESP_ERR_NOT_SUPPORTED both mean "
        "the driver got no usable sensor ID over SCCB.");
    flushOut();
    return;
  }

  camera_fb_t *fb = esp_camera_fb_get();
  if (!fb) {
    Serial.println(
        "  Capture FAILED. SCCB works but the parallel DVP path does not: "
        "check PCLK, VSYNC, HREF and D0..D7.");
  } else {
    Serial.printf("  Captured %ux%u JPEG, %u bytes\n", (unsigned)fb->width,
                  (unsigned)fb->height, (unsigned)fb->len);
    const bool jpegOk = fb->len > 4 && fb->buf[0] == 0xFF && fb->buf[1] == 0xD8;
    Serial.println(jpegOk ? "  Valid JPEG: the full camera path works"
                          : "  Buffer is not a valid JPEG");
    esp_camera_fb_return(fb);
  }
  flushOut();
}

}  // namespace

void setup() {
  Serial.begin(115200);
  delay(2000);
  Serial.println();
  Serial.println("BLINKS glasses camera diagnostic v9");
  Serial.println("Target: custom ESP32-S3-MINI-1-N4R2 glasses PCB (not XIAO)");
  flushOut();

  reportBoardConfiguration();
  runPullUpCensus();
  inventorySystemBus();
  identifyUnlistedDevices();
  reportBatteryState();

  bool railUp = rail2V8IsUp();
  if (!railUp) {
    huntForRailEnable();
    railUp = rail2V8IsUp();
  } else {
    Serial.println();
    Serial.println("2V8 rail is already up; skipping the enable hunt.");
  }

  if (railUp) {
    Serial.println();
    Serial.println("== Step 4: SCCB probe ==");
    flushOut();
    uint8_t found = 0;
    if (startXclk(PIN_XCLK)) {
      for (int attempt = 0; attempt < 2 && !found; attempt++) {
        releaseCamera(attempt == 0);
        found = probeSccb();
      }
    }
    tryDriverInit();
  }

  Serial.println();
  Serial.println("=========== WHAT THIS MEANS ===========");
  if (!railUp) {
    Serial.println(
        "The 2.8 V camera supply is still off. No firmware change can create "
        "it. Next step is a hardware one: measure 2.8 V at the far pad of R3, "
        "R13, R16 or R17, and at pin 11 of the camera ribbon connector, then "
        "trace back to whichever regulator should produce it.");
  } else {
    Serial.println(
        "The 2.8 V camera supply is present. Any remaining failure is now in "
        "the camera module, the ribbon cable, or its connector wiring, not in "
        "the power path.");
  }
  Serial.println("=======================================");
  flushOut();
}

void loop() { delay(1000); }
