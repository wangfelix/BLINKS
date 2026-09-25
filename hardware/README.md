# BLINKS hardware

Assembly documentation and printable enclosure parts for the two BLINKS camera
forms. These are ordinary files in the same repository as the firmware, phone
application, server and reconstruction website. No submodule setup is needed.

| Device | Assembly | Printable parts | Recording firmware |
| --- | --- | --- | --- |
| Neck-worn bodycam (called “necklace” in the original hardware repository) | [Bodycam assembly](bodycam/README.md) | [Three STL models](bodycam/models/) | [XIAO BLE camera firmware](../camera-firmware/README.md) |
| Camera glasses | [Glasses assembly](glasses/README.md) | [Seven STL models](glasses/models/) | [Glasses PlatformIO build](../glasses-camera-firmware-pio/README.md) |

The [glasses LED test](glasses/led-test/README.md) is an optional historical
bring-up example. It does not capture images or connect to the phone.

## What is available

- Ten STL enclosure/fixture models.
- Sixteen assembly photographs and a glasses electronics block diagram.
- Parts lists and illustrated assembly steps for both camera forms.
- The original LP5815 LED-test source and PlatformIO configuration.

The imported hardware source does **not** contain the custom glasses board's
schematic, PCB layout, fabrication/assembly exports, a complete electronic BOM,
or native editable CAD files. The glasses guide therefore assumes access to an
existing assembled board. The block diagram is not a schematic, and the STL
files are manufacturing meshes rather than native CAD sources. This package is
not yet sufficient to independently manufacture the custom electronics.

## Provenance and licensing

The hardware materials originate from [MKnierim/Blinks](https://github.com/MKnierim/Blinks).
See [provenance](PROVENANCE.md) for the exact imported revision, file mapping,
and documentation changes. The original repository contains no license file;
this import preserves its attribution and does not introduce a license grant.
Licensing for the hardware, documentation and existing software must be stated
explicitly before claiming a fully licensed open-source release.
