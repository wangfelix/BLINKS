# Figures

Paper figures for the camera pipeline / VLM scene-understanding project.

## Source of truth

The **`.svg` files are the source**. Edit those by hand; never edit the `.pdf`
or `.png`, which are generated artifacts and are overwritten on every render.

| File              | Role                                                                 |
| ----------------- | ------------------------------------------------------------------- |
| `pipeline.svg`    | Conceptual contribution: VLM scene understanding as a shared context layer (camera → VLM → scene-state descriptors → change point detection → adaptive survey timing + biosignal segmentation). |
| `architecture.svg`| Engineering system: edge cameras → Apache (TLS) → ingestion server → filesystem + SQLite → async Python VLM service → Expo/FCM push → mobile app. |

For each, two artifacts are generated:

- **`.pdf`** — vector, for LaTeX (`\includegraphics{figures/architecture.pdf}`). Preferred for submission.
- **`.png`** — raster preview, for quick viewing / Markdown / slides.

## Regenerate

Requires Inkscape (1.x). From this directory:

```bash
for f in pipeline architecture; do
  inkscape "$f.svg" --export-type=pdf --export-filename="$f.pdf"
  inkscape "$f.svg" --export-type=png --export-filename="$f.png" --export-width=1200
done
```

(Single file, e.g. after editing the pipeline figure:
`inkscape pipeline.svg --export-type=pdf --export-filename=pipeline.pdf`)

## Conventions (keep consistent across both figures)

- **Box fill = role:** inputs blue (`#e8f1fb`/`#2e6ca4`), processing amber
  (`#fdf3e3`/`#c77f1a`), storage & outcomes teal (`#e5f6f2`/`#1f8a70`),
  client/push violet (`#f0eaf8`/`#6c4ab6`). Text `#243441`, muted sub-text `#5a6b78`.
- **Line style = plane** (so it reads in grayscale): solid = data plane,
  dashed = control plane (pause/resume, assignment), dotted = biosignal
  time-alignment, violet = push notification. See the legend in `architecture.svg`.
- No embedded "Figure N" caption — add captions in LaTeX.
- Sized for a full-width (two-column span) placement; vector, so they scale down
  to single-column losslessly.

## Caveat

These figures depict the **planned** design (SQLite metadata store, async VLM
service, Expo/FCM push). As of this writing the server still writes the
per-session CSV and the DB / VLM worker / mobile app are not yet implemented.
Treat the figures as the target architecture, not as-built. Verify device names
(Cardioban EKG, Mendi fNIRS) before submission.
