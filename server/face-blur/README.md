# Face-anonymization worker

Automatically pixelates (or blurs) every human face in ingested frames, so an
unblurred face is never retained on disk or served to a participant.

It is a **separate long-lived Python process**, never inline with WebSocket
ingestion — the same design as the planned VLM service. Detection latency or a
crash here can never cost a frame, and the worker runs *before* the VLM so the
VLM only ever sees anonymized images.

```
camera → BLE → phone → WS → server   (writes JPEG + frames.face_status='pending')
                                │
                                ▼
                          [this worker]  detect faces → pixelate in place → 'done'
                                │
                                ▼
                          VLM service (later) reads the already-anonymized image
```

- **Detector:** CenterFace (the ONNX model bundled with [`deface`](https://github.com/ORB-HD/deface)), run through OpenCV's DNN module on CPU (~30 ms/frame). Tuned for **recall over precision**: a missed face is a privacy breach, a false positive merely pixelates a doorknob.
- **Obscuring:** mosaic/pixelate by default (`FACE_METHOD=blur` for gaussian blur).
- **In place:** the blurred JPEG atomically **overwrites the original** (temp file + `os.replace`). No unblurred copy is kept.
- **Serving gate:** the server only lists and serves frames whose `face_status='done'` (see `server/src/db.ts` and `server/src/server.ts`), so even in the brief window before this worker runs, an unblurred frame is never exposed.

## Setup

```bash
cd server/face-blur
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

On a **headless server**, if `import cv2` fails with `libGL.so.1: cannot open
shared object file`, install the system libraries (do **not** swap to
`opencv-python-headless` — see `requirements.txt`):

```bash
sudo apt-get install -y libgl1 libglib2.0-0
```

## Run

```bash
.venv/bin/python blur_worker.py            # daemon: poll forever (production)
.venv/bin/python blur_worker.py --once     # process the current backlog, then exit
.venv/bin/python blur_worker.py --max 100  # stop after 100 frames (testing)
```

The worker reads `recordings.db` (and the JPEGs) written by the Node server, so
it must run on the same host with access to the recordings tree. It picks up the
existing backlog automatically (every pre-existing row defaults to
`face_status='pending'`).

## Config (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `RECORDINGS_DIR` | `../recordings` | recordings tree (matches the server's env) |
| `RECORDINGS_DB` | `<RECORDINGS_DIR>/recordings.db` | the SQLite index |
| `FACE_THRESHOLD` | `0.2` | CenterFace confidence; **lower = more faces blurred = safer**. Matches deface's default. |
| `FACE_METHOD` | `mosaic` | `mosaic` (pixelate) or `blur` (gaussian) |
| `FACE_BLOCKS` | `8` | mosaic granularity; smaller = coarser |
| `FACE_BLUR_KSIZE` | `0` | gaussian kernel for `method=blur` (0 = auto-scale to face size) |
| `FACE_MARGIN` | `0.12` | fraction each detected box is expanded (catches forehead/ears/chin) |
| `POLL_INTERVAL_S` | `2.0` | sleep between polls when the queue is empty |
| `BATCH_SIZE` | `50` | rows fetched per poll |

`face_method` is recorded per frame (e.g. `mosaic:centerface@0.2`) so every
anonymized frame stays traceable for the paper's methods section.

## systemd (KIT VM)

Run it as a service alongside the `blinks` server. `/etc/systemd/system/blinks-face-blur.service`:

```ini
[Unit]
Description=BLINKS face-anonymization worker
After=blinks.service

[Service]
WorkingDirectory=/root/BLINKS/server/face-blur
ExecStart=/root/BLINKS/server/face-blur/.venv/bin/python blur_worker.py
Environment=RECORDINGS_DIR=/root/BLINKS/server/recordings
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now blinks-face-blur
sudo journalctl -u blinks-face-blur -f
```
