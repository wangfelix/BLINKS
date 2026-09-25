# Hardware import provenance

- Source: [MKnierim/Blinks](https://github.com/MKnierim/Blinks).
- Imported revision: [`0d8fa58be4bac74d579ba05c3ff33a7a50eab16e`](https://github.com/MKnierim/Blinks/tree/0d8fa58be4bac74d579ba05c3ff33a7a50eab16e).
- Source commit date: 7 August 2026, “Added glasses assembly instructions”.
- Imported on: 24 September 2026.

This is a file import into the BLINKS repository, not a Git submodule or nested
repository. The original repository is unchanged. Its Git history has not been
merged into this repository by this file import; the revision above identifies
the source precisely. No claim is made that this revision is the complete
hardware/software configuration used by every study participant.

## File mapping

| Original location | Integrated location |
| --- | --- |
| `models/necklace/` | `bodycam/models/` |
| `docs/necklace/` | `bodycam/images/` |
| `models/glasses/` | `glasses/models/` |
| `docs/glasses/` | `glasses/images/` |
| `docs/systemDiagram.png` | `glasses/images/system-diagram.png` |
| `src/main.cpp`, `platformio.ini` | `glasses/led-test/` with the original project layout |
| `README.md` | Adapted into the hardware overview and the two device assembly guides |

`Frount-Inner.stl` was renamed to `Front-Inner.stl`; its contents are unchanged.
All ten STL files, sixteen JPEGs, the system diagram and both LED-test files
are byte-for-byte copies of the source. [The import manifest](import-manifest.json)
records the original paths, destination paths, sizes and SHA-256 checksums.

The original editor-extension recommendations and empty PlatformIO scaffolding
(`include/README`, `lib/README`, `test/README`) were omitted. A local ignore file
keeps build output out of Git while allowing assembly photographs to be tracked
despite the software repository's general JPEG ignore rule.

## Documentation changes

The source assembly guide was separated by device and its image links updated.
The bodycam guide uses the same name as the rest of BLINKS. The glasses guide
retains the source's U8 rework requirement, inverted battery-cable specifications
and battery-dependent startup observations. It makes explicit that breakout
separation and connector work happen with USB and batteries disconnected; the
source placed battery connection before those operations.

The overview distinguishes board capabilities from implemented camera firmware
and documents the missing board-manufacturing and native CAD files. The source's
claim that the whole device can be reproduced from the STL package was not
carried forward. The LED test is labelled as historical and unverified in the
current toolchain; its source and build configuration are unchanged.

## Licensing

No license file was present at the imported revision. No new license was chosen
for these materials, and no hardware license is applied to the existing software.
Retain the source attribution when preparing the project's release licenses.
