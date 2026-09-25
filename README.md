# BLINKS

BLINKS is a wearable-camera research system for vision-language-model (VLM) assisted day reconstruction. A neck-worn bodycam or custom camera glasses capture images, an Android app relays them to a server, and a web application lets participants review and revise an activity timeline.

This repository contains the hardware documentation and enclosure models as well as the firmware, server side code, and participant facing website and mobile application.

## How it works

```text
Wearable camera → Bluetooth LE → Android app → Server
                                                 ↓
                                       Face processing → VLM
                                                 ↓
                                        Participant web review
```

The server stores images and recording metadata. A separate worker pixelates detected faces before images are served or sent for inference. The VLM classifies five-minute windows into activity labels and the categories `work`, `break`, and `other`; matching windows form proposed activity spans.

The current study workflow uses one recording day and two sequential reconstruction rounds. Participants first reconstruct their day from memory, then review and edit the VLM proposal alongside the recorded images. Images and proposals unlock after the unaided round is submitted. External questionnaires complete the workflow.

## Repository guide

| Component | Documentation and files |
| --- | --- |
| Hardware overview | [Available materials and build paths](hardware/README.md), [import provenance](hardware/PROVENANCE.md) |
| Bodycam hardware | [Assembly guide](hardware/bodycam/README.md), [enclosure models](hardware/bodycam/models/) |
| Glasses hardware | [Assembly guide](hardware/glasses/README.md), [frame models](hardware/glasses/models/) |
| Bodycam firmware | [XIAO ESP32-S3 Sense BLE firmware](camera-firmware/README.md) |
| Glasses firmware | [Shared camera firmware](glasses-camera-firmware/README.md), [PlatformIO build with automatic light sleep](glasses-camera-firmware-pio/README.md) |
| Android app | [BLE capture, recording controls, and server relay](blinks-edge-app/README.md) |
| API and storage | [Server source](server/), [startup and account commands](COMMANDS.md) |
| Processing workers | [Face processing](server/face-blur/README.md), [VLM inference and configuration](server/vlm/README.md) |
| Participant website | [Day reconstruction web app](drm-web/README.md) |
| Deployment | [Host setup and deployment workflow](deploy/README.md) |

[Glasses diagnostics](glasses-camera-diagnostic/README.md) support hardware troubleshooting. The [earlier BLE feasibility prototype](feasibility/README.md) and [hardware LED bring-up code](hardware/glasses/led-test/) are retained as historical references.

## Getting started

1. **Explore the reconstruction workflow.** Follow the demo-data instructions in [COMMANDS.md](COMMANDS.md) to run the API and website with seeded activities. This path needs neither a camera nor live VLM inference. Reseeding replaces the `demo` and `demo2` accounts' data.
2. **Choose and assemble a camera.** Start with the [hardware overview](hardware/README.md), then follow the matching assembly and firmware guides. The glasses PlatformIO target builds the shared glasses sketch with additional power-management configuration.
3. **Prepare the recording stack.** Install each component's dependencies, configure the API address and web questionnaire URLs, and prepare the two Python workers. Set the VLM endpoint, model, and credentials using its [configuration guide](server/vlm/README.md).
4. **Build the Android app.** Follow its [native development-build instructions](blinks-edge-app/README.md). BLE and the recording foreground service require a native build; Expo Go cannot run this app. Set `EXPO_PUBLIC_SERVER_URL` to your chosen API address before starting Metro.

Use Node.js 22 for the web and mobile tools, Python 3 with virtual environments for the workers, and the Android SDK for local Android builds. Firmware toolchains are documented separately. The API, website, and mobile app each have their own npm package and lockfile; install dependencies in their respective directories.

After completing the setup in [COMMANDS.md](COMMANDS.md), the repository launcher can check and start the full local stack:

```bash
./dev-all.sh --check
./dev-all.sh
```

The launcher requires installed dependencies, both worker virtual environments, VLM credentials, and configured ngrok. It starts the API on port **3000**, the website on **3002**, both workers, the development proxy/tunnel, and Expo Metro. Configure the mobile app's API URL separately to match your tunnel. See the component guides for running services individually.

For deployment, follow [deploy/README.md](deploy/README.md). The website uses Next.js standalone output and requires its asset-copy steps and bundled server; its `npm start` script is not the production launch path.

## Data, availability, and licensing

Recording images and metadata live under `server/recordings/`; authentication data lives under `server/data/`. These locations are configurable. Keep credentials, recordings, and participant datasets out of version control. The hardware import includes no study data or credentials.

The imported hardware materials contain assembly documentation, enclosure/frame models, and LED bring-up code. The source snapshot does not include PCB design files, schematics, Gerbers, native editable CAD projects, or an explicit license. See the [hardware availability notes](hardware/README.md) and [provenance record](hardware/PROVENANCE.md) for the import's scope. This repository does not establish a new license for those materials or a blanket license covering the hardware and software.
