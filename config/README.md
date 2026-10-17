# Study config

One YAML file holds every study setting: activity labels and categories,
rating items, windowing, capture intervals, schedule, VLM model and prompts,
overreliance injection, face blur, reminders, texts, links and the app PIN.
The server, the VLM worker, the face-blur worker, the app and the DRM website
all read the same file. The full contract (fields, invariants, endpoints) is
in [`docs/study-config-contract.md`](../docs/study-config-contract.md).

| File                        | Purpose                                                                             |
| --------------------------- | ----------------------------------------------------------------------------------- |
| `study.example.yaml`        | paper default; tracked; dummy links and PIN `0000`, **never used in production**    |
| `study.test.yaml`           | a deliberately different study for tests (5 labels, 3 items, `[TEST]` texts)        |
| `study-config.schema.json`  | JSON Schema generated from the zod schema (editor support, Python validation)       |
| `study.yaml`                | the real study; **gitignored**, created per deployment, not a symlink               |

## Which file is used

1. `BLINKS_STUDY_CONFIG` (absolute, or relative to the process's working directory)
2. `config/study.yaml`
3. `config/study.example.yaml`, only outside production, with a
   `WARNING: using config/study.example.yaml ...` log line

Production is `NODE_ENV=production` (server) or `BLINKS_ENV=production` /
`NODE_ENV=production` (Python workers). There, a missing file or the example
file is a fatal error. Every process loads the file once at start-up; after an
edit, restart the services (`deploy.sh` does that).

An invalid file stops the process with exit code 2 and one line per problem
(`path.to.field: reason`, e.g. `experienceItems.0.scale: min must be smaller than max`).

## Setting up a new study

```bash
cp config/study.example.yaml config/study.yaml
$EDITOR config/study.yaml
```

Check at least:

- `study.name`, `study.timezone` (IANA, e.g. `Europe/Berlin`)
- `activities` / `categories`: keys are stored in the database. Do not rename
  or remove keys while a study is running; add new ones instead.
- `experienceItems`: keys, scales, `required`, `appliesToCategories`. Ratings
  are stored per item key (`activity_ratings`).
- `capture.intervalMsByFormFactor`: at least 5000 ms (firmware lower bound);
  the app sends the interval to the camera on every connect.
- `schedule.reconstructionOpensAt` / `endSessionAvailableAt` (study time zone)
- `vlm.model`, `vlm.prompts` (placeholders: see the contract)
- `overreliance.enabled` / `rate`: needs at least 2 categories when enabled.
  `rate: 0` disables only the rate-based selection; with
  `fallbackToTopWhenNoneAboveThreshold: true` one label per day is still
  injected when no activity reaches `minConfidence`. To inject nothing, set
  `enabled: false`.
- `privacy.faceBlur.enabled`: see "Face blur off" below before switching it off.
- `surveys.*` and `texts.*` links: real URLs. `deploy.sh` refuses
  `example.org` / `example.com` links.
- `app.studySettingsPin`: a new PIN per study. In production the loaders
  (server and both workers) and `deploy.sh` refuse the placeholder PIN from
  `study.example.yaml` and the retired pre-config PIN, as well as
  `example.org`/`example.com` survey/payout links. The file is not public, but it
  is not a secret store either: keep it readable only by the service user
  (`chmod 600`; `deploy.sh` warns about any group/other bits).

Validate before deploying:

```bash
cd server && npm run build
BLINKS_STUDY_CONFIG=../config/study.yaml NODE_ENV=production \
  node -e 'require("./dist/study-config")' && echo OK
```

`deploy.sh` runs the same check (plus the Python loaders in both worker venvs)
before it restarts anything.

## Face blur off (`privacy.faceBlur.enabled: false`)

Only with an ethics/GDPR basis for it. While it is off:

- new frames are stored as already anonymized (`face_method='disabled'`) and
  are shown to the participant **unblurred**;
- the same unblurred frames are sent to the **external VLM endpoint**
  (`vlm.*`), since the VLM worker only waits for `face_status='done'`;
- the server and `deploy.sh` log a warning, `blinks-face-blur` finishes the
  pending backlog and stops (exit 3, not restarted).

Switching it back on only affects new frames. Frames stored while it was off
**stay unblurred** until they are requeued:

```bash
cd server
npx tsx scripts/requeue-unblurred-frames.ts           # count (dry run)
npx tsx scripts/requeue-unblurred-frames.ts --apply   # after enabled: true + deploy
```

Requeued frames are hidden until `blinks-face-blur` has processed them. VLM
labels already computed from the unblurred frames are not changed.

## Analysis notes

- Ratings are stored per item key in `activity_ratings`. Values for items whose
  `appliesTo` does not include the activity's final category can exist (the
  editor keeps a value when the category is changed afterwards, and the
  `activity_ratings` migration carried such legacy values over). The API
  returns them, so filter by `appliesTo` and the final `category_label` in the
  analysis.

## Changing the schema

The zod schema in `server/src/study-config/schema.ts` is the source of truth.
After changing it, run `npm run generate-study-config-schema` and
`npm run test-study-config-schema` in `server/`, and update the contract doc.

## Neue Studie konfigurieren

Kurzanleitung für das Studienteam. Die Details stehen oben und im Vertrag
([`docs/study-config-contract.md`](../docs/study-config-contract.md)).

### 1. Datei anlegen

```bash
cp config/study.example.yaml config/study.yaml   # study.yaml ist gitignored
chmod 640 config/study.yaml
$EDITOR config/study.yaml
```

Nie `study.example.yaml` oder `study.test.yaml` für eine echte Studie verwenden.

### 2. Was wo sichtbar wird

| Block in der YAML | Wirkung in Web (DRM-Website) und App |
|---|---|
| `study.timezone` | Zeitanzeige im Web, Abend-Gate, Ende-Session-Zeit in der App |
| `ui.locale`, `ui.thumbnailsPerActivity` | Datums-/Zeitformat im Web, Anzahl Vorschaubilder pro Aktivität in Runde 2 |
| `windowing.windowMinutes` | Raster in „Adjust times“ und Texte („five-minute“/„ten-minute“), Admin-Label der Chunks |
| `activities[].displayLabel` | Auswahlliste „Activity“ in beiden Runden |
| `categories[]` (`displayLabel`, `icon`, `description`) | Auswahl „Activity type“ und die Legende „Categories“. Erlaubte Icons: `briefcase, pause, ellipsis, coffee, users, house, book-open, heart, circle` |
| `experienceItems[]` | Eine Bewertungsskala pro Item und Kategorie (`appliesTo`), Skalenlänge `min..max`, Anker, Pflicht beim Absenden (`requiredOnSubmit`), Kurzlabel in der Zusammenfassung („Mental demand 4/7“) |
| `texts.rounds`, `texts.progress` | Intro-, Reminder- und Hinweistexte der Runden, Schritt-Labels oben. `assistedReminderIncorrectLabelsNotice: null` blendet den Hinweis auf falsche Labels aus |
| `surveys.onboarding/final` | Links zu den Fragebögen inkl. Teilnehmer-Parameter (`participantParameter`) |
| `surveys.payoutUrl` | Ziel von `/api/payout` (Link „Payout“ auf der Survey-Seite) |
| `devices.formFactors` | Auswahl „Camera type“ in den Study Settings der App |
| `capture.intervalMsByFormFactor` | Aufnahmeintervall, das die App bei jeder Kamera-Verbindung per BLE `0x03` setzt (5000–600000 ms) |
| `schedule.endSessionAvailableAt` | Ab wann „End session“ in der App aktiv ist (Studien-Zeitzone) |
| `texts.app` | Benachrichtigungs- und Onboarding-Texte der App, „Available from {{time}}“ |
| `app.studySettingsPin` | PIN der Study Settings (4–8 Ziffern). **Für jede Studie neu vergeben**, der alte PIN steht in der öffentlichen Git-Historie |

Wichtig: Die `key`-Werte (Aktivitäten, Kategorien, Items, Bauformen) landen in
der Datenbank. Während einer laufenden Studie nicht umbenennen oder löschen,
nur neue hinzufügen. Anzeigetexte (`displayLabel`, Fragen, Texte) dürfen sich
ändern.

### 3. Lokal prüfen

```bash
cd server && npm run build
BLINKS_STUDY_CONFIG=../config/study.yaml node -e 'require("./dist/study-config")' && echo OK
```

Zum Durchklicken einen Server mit eigener Datenablage starten. Damit das
Abend-Gate offen ist, eine Kopie mit `reconstructionOpensAt: "00:00"` nehmen:

```bash
sed 's/reconstructionOpensAt: "[0-9:]*"/reconstructionOpensAt: "00:00"/' \
  ../config/study.yaml > /tmp/study.local.yaml
BLINKS_STUDY_CONFIG=/tmp/study.local.yaml DATA_DIR=/tmp/neu/data \
  RECORDINGS_DIR=/tmp/neu/rec DISABLE_PUSH=1 npm run dev
# zweites Terminal
cd drm-web && npm run dev    # http://localhost:3002
```

Web und App brauchen für eine neue Config **keinen neuen Build**, sie laden die
Werte zur Laufzeit. Wie eine völlig andere Studie aussieht, zeigt
`config/study.test.yaml` (5 Labels, 2 Kategorien, 3 Items, 10-Minuten-Fenster,
Texte mit „[TEST]“).

### 4. Ausrollen

1. `config/study.yaml` auf dem Server ablegen; `deploy.sh` validiert sie und
   startet die Dienste neu.
2. **Nicht während einer Abend-Rekonstruktion deployen.** Das Web lädt die
   Config einmal pro Anmeldung bzw. Seitenaufruf. Ein offener Tab mit altem
   Stand sieht erst nach dem Neuladen die neuen Werte. Ein Tab mit der Web-Version
   vor dieser Umstellung (alte Felder `workloadRating`/`recoveryRating`) bekommt
   beim Speichern `400` und muss neu geladen werden.
3. App: Jedes Telefon muss sich nach der Umstellung **einmal online anmelden**
   (oder bei Verbindung die Study Settings öffnen). Erst dann ist der PIN
   bekannt und das Aufnahmeintervall wird gesetzt. Vorher sind die Study
   Settings gesperrt und die Kamera nimmt mit ihrem Firmware-Default auf
   (15 s Bodycam, 30 s Glasses). Danach funktioniert alles auch offline aus
   dem Cache. Abmelden löscht den Cache dieses Users.
4. Nach dem ersten Verbinden der Kamera in den Study Settings prüfen, dass
   keine Warnung angezeigt wird (geklemmtes Intervall oder abweichende Bauform).
   Im Admin-Bereich steht jede Verbindung in der Tabelle „Camera device info“.
