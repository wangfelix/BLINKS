# Study-Config: Vertrag

Status: **Freigegeben** (Martin, 17.10. 19:38; Entscheidungen Felix F1–F7 siehe Abschnitt 8). Implementiert im Branch `BE/study-config`.
Vorher: Entwurf zur Review durch Martin (Study-Config-Rollout, BE-Teil), Pre-Review von Martin
eingearbeitet.
Implementiert wurde erst nach Martins Freigabe. Felix' Vorgaben: eine zentrale
YAML-Datei, **keine** Versionierung/Hashing/DB-Snapshot, Validierung beim
Start, Prompts und Overreliance-Werte gehen nie an Clients.

Dateien in diesem Branch:

| Datei | Zweck |
|---|---|
| `server/src/study-config/schema.ts` | zod-Schema, **einzige Quelle** für die Struktur + Cross-Checks |
| `config/study-config.schema.json` | daraus generiertes JSON Schema (draft 2020-12) für die Python-Worker |
| `server/scripts/generate-study-config-schema.ts` | Generator (`npm run generate-study-config-schema`, `-- --check`) |
| `config/study.example.yaml` | Paper-Studie 1:1, sensible Felder nur als Platzhalter |
| `server/scripts/test-study-config-schema.ts` | Schema aktuell, Example gültig, Example = heutige Konstanten/Texte, Fehlerfälle |
| `server/vlm/test_study_example_prompts.py` | Golden-Test: aus der Example-YAML gerenderte Prompts byte-identisch zu heute |
| `docs/ble-capture-config.md` | BLE-Spec `0x03` + Device-Info-Characteristic `…0004` |

## 1. Datei, Pfad, Laden

- Pfad: Env `BLINKS_STUDY_CONFIG`, Default `config/study.yaml` (relativ zum Repo-Root).
  `config/study.yaml` ist gitignored. Fehlt sie, fällt der Loader auf
  `config/study.example.yaml` zurück, **mit deutlicher Warnung** (Dev/Tests).
  **In Produktion (`NODE_ENV=production`) gibt es keinen Fallback (F1, entschieden).**
- YAML-Parser: Node `yaml` (YAML 1.2), Python `PyYAML` (`safe_load`, YAML 1.1).
  Damit beide gleich parsen: Zeiten, PIN und mehrdeutige Strings (`on`, `no`,
  `0000`) **immer quoten**. Das Example hält sich daran.
- Ablauf beim Start (Server, VLM-Worker, Face-Blur-Worker):
  1. YAML parsen, 2. Shape validieren (zod bzw. `jsonschema` gegen
  `config/study-config.schema.json`), 3. Cross-Checks, 4. bei Fehlern: alle
  Fehler als `pfad.zum.feld: Grund` auf stderr, Exit-Code 2, kein Start.
- Defaults: nur `privacy.faceBlur.enabled` (Default `true`). Alles andere ist
  Pflicht, damit Node und Python nicht auseinanderlaufen. Python setzt den einen
  Default explizit.
- Unbekannte Felder sind Fehler (`additionalProperties: false`), damit Tippfehler
  wie `overreliance.rat` nicht still ignoriert werden.

### Cross-Checks (nicht im JSON Schema)

`[py]` = auch die Python-Worker prüfen das (sie brauchen nur diese).

- `[py]` Keys eindeutig in `activities`, `categories`, `experienceItems`, `devices.formFactors`
- `experienceItems[].appliesTo` verweist auf existierende Kategorien
- `scale.min < scale.max` und `max - min <= 10` (Layout), `min >= 0` steht schon im Shape
- `capture.intervalMsByFormFactor` hat genau die Keys aus `devices.formFactors`
- `[py]` jedes Intervall `<` Fenster; Intervall in `[5000, 600000]` ms (Firmware-Grenzen, schon im Shape)
- `[py]` `60 % windowing.windowMinutes == 0` **und** jeder UTC-Offset von `study.timezone`
  ist ein Vielfaches davon (geprüft: Offsets am 1. und 15. jedes Monats im laufenden und
  im nächsten Jahr). Grund: Die Fenster sind epoch-ausgerichtet (`chunkStartOf`), nur so
  liegen sie auf lokalen Marken und laufen nie über Mitternacht oder einen DST-Wechsel
  (Review PR #1, M3, Variante A). Europe/Berlin: 1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60;
  Asia/Kolkata (+05:30): 1, 2, 3, 5, 6, 10, 15, 30. Die Fehlermeldung nennt die erlaubten Werte.
  Außerdem `idleCloseMinutes >= windowMinutes`.
- `[py]` nur erlaubte Prompt-Platzhalter (Liste unten)
- `[py]` `study.timezone` ist eine bekannte IANA-Zone
- `overreliance.enabled: false` **oder** `overreliance.rate: 0` ⇒ `texts.rounds.assistedReminderIncorrectLabelsNotice` muss `null` sein
  (sonst würde Teilnehmenden etwas Falsches gesagt)
- `reminders.bedtime.afterMidnightCutoff <= latestAt`
- `[py]` `overreliance.enabled: true` und `rate > 0` ⇒ mindestens 2 Kategorien (Review PR #1, m1)

**Nur in Produktion** (Server-Loader, Python-Loader und `deploy.sh`, Review PR #1, m2):
`app.studySettingsPin` darf weder der Platzhalter-PIN aus `study.example.yaml` noch der
alte PIN aus der Zeit vor der Config sein (Vergleich per SHA-256). Survey- und Payout-Links
mit `example.org`/`example.com` werden abgelehnt. Damit fällt auch eine 1:1-Kopie des
Examples unter anderem Namen auf.
- `categories[].icon` nur aus der Allowlist `briefcase, pause, ellipsis, coffee, users, house, book-open, heart, circle` (Shape, zod-Enum). Das Mapping auf lucide-react baut Martin im Web

## 2. Struktur (Kurzüberblick)

Siehe `schema.ts` (kommentiert) und `config/study.example.yaml`.

| Key | Ersetzt heute |
|---|---|
| `study.{name, timezone}` | `DRM_TZ`, `NEXT_PUBLIC_DRM_TZ` |
| `ui.{locale, thumbnailsPerActivity}` | `en-GB`-Formatter, `THUMBNAIL_COUNT = 5` |
| `windowing.{windowMinutes, idleCloseMinutes}` | `CHUNK_WINDOW_MS`, `FIVE_MINUTE_MS`, `CHUNK_IDLE_CLOSE_MS` |
| `devices.formFactors[]` | `CAMERA_FORM_FACTORS` + DB-CHECK |
| `capture.intervalMsByFormFactor` | `#define CAPTURE_INTERVAL_MS` (15000 / 30000) |
| `schedule.{reconstructionOpensAt, endSessionAvailableAt, dayOverrunHours}` | `DRM_AVAILABLE_FROM_HOUR`, `END_SESSION_AVAILABLE_HOUR`, `DRM_DAY_OVERRUN_HOURS` |
| `activities[]: {key, displayLabel, vlmDefinition}` | 3 Vokabular-Dateien |
| `categories[]: {key, displayLabel, icon, description, vlmDefinition}` | `CATEGORY_LABELS`, `CATEGORY_ITEMS`, Legend-Card, Prompt |
| `experienceItems[]: {key, appliesTo, question, shortLabel, scale, requiredOnSubmit}` | `workload_rating`/`recovery_rating`, `SCALE_COPY`, Kurzlabel „Mental demand 4/7“ |
| `segmentation.mergeAcrossCaptureGaps` | Regel 3 in `segmentation.ts` |
| `vlm.{model, request, maxFramesPerWindow, prompts}` | `VLM_MODEL`, `VLM_TEMPERATURE`, `VLM_REASONING_EFFORT`, `VLM_MAX_COMPLETION_TOKENS`, `VLM_CHUNK_MAX_FRAMES`, `SYSTEM_PROMPT`, `_build_user_prompt` |
| `overreliance.{enabled, rate, minConfidence, fallbackToTopWhenNoneAboveThreshold}` | `INCORRECT_ANNOTATION_*` |
| `privacy.faceBlur.{enabled, threshold, method, blocks, blurKernel, margin}` | `FACE_*` Env |
| `reminders.bedtime.{enabled, leadMinutes, defaultBedtime, latestAt, afterMidnightCutoff}` | `push.ts`-Konstanten, `DRM_DEFAULT_BEDTIME` |
| `texts.{push, rounds, progress, app, app.onboarding}` | hartkodierte UI-/Push-/Notification-/App-Onboarding-Texte |
| `surveys.{onboarding, final, payoutUrl}` **sensibel** | `NEXT_PUBLIC_*_SURVEY_URL`, `PAYOUT_URL` |
| `app.studySettingsPin` **sensibel** | `EXPO_PUBLIC_STUDY_SETTINGS_PIN` in `eas.json` |

Bleibt Env: `CAMERA_PORT`, `RECORDINGS_DIR`, `DATA_DIR`, `AUTH_DB_PATH`, `WEB_URL`,
`DISABLE_PUSH`, `DRM_DEV_MODE`, `KIT_API_KEY`, `KIT_BASE_URL`, `VLM_TIMEOUT`,
`VLM_MAX_ATTEMPTS`, `VLM_RETRY_DELAYS_S`, `VLM_CONCURRENCY`, `BATCH_SIZE`, `POLL_INTERVAL_S`.

## 3. Prompt-Templates (Golden-Test)

Rendering = **ein** Durchlauf, der jedes `{{name}}` ersetzt. Eingesetzte Werte
werden nicht erneut gescannt (ein Beruf wie `"{{frame_count}}"` bleibt wörtlich).
Erlaubte Platzhalter:

| Template | Platzhalter |
|---|---|
| `vlm.prompts.system` | `{{window_minutes}}`, `{{activity_count}}` |
| `vlm.prompts.user` | `{{occupation_context}}`, `{{frame_count}}`, `{{window_minutes}}`, `{{activity_count}}`, `{{activity_definitions}}`, `{{category_keys}}`, `{{category_definitions}}` |
| `vlm.prompts.occupationKnown` | `{{occupation}}` |
| `vlm.prompts.workDescription` | `{{work_description}}` |
| `vlm.prompts.occupationUnknown` | – |

Abgeleitete Werte (exakt so, sonst bricht der Golden-Test):

- `activity_definitions`: pro Aktivität `- "<key>": <vlmDefinition>`, mit `\n` verbunden
- `category_keys`: `[` + `"<key>"` mit `", "` verbunden + `]` → `["work", "break", "other"]`
  (nicht `JSON.stringify`, das lässt die Leerzeichen weg)
- `category_definitions`: `"<key>" = <vlmDefinition>`, mit einem Leerzeichen verbunden
- `occupation_context`: Beruf und Beschreibung werden getrimmt. Leerer Beruf →
  `occupationUnknown`, sonst `occupationKnown` + (falls Beschreibung nicht leer) `workDescription`
- `window_minutes`, `activity_count`, `frame_count`: Dezimalzahl

`server/vlm/test_study_example_prompts.py` belegt heute schon: System- und
User-Prompt aus `study.example.yaml` sind **byte-identisch** zu `SYSTEM_PROMPT`
und `_build_user_prompt()` (6 Fälle inkl. leerem Beruf und Platzhalter-Injection).
Hinweis: Der System-Prompt sagt wörtlich „about five minutes“. Ein Platzhalter
würde „5 minutes“ ergeben und den Golden-Test brechen, deshalb bleibt der Text
wörtlich. Wer das Fenster ändert, passt den Prompt-Text mit an.

Das Response-Schema (`VLM_RESPONSE_FORMAT`) wird weiter im Worker aus den Keys
gebaut und ist nicht konfigurierbar.

## 4. API

Allgemein: `GET`, JSON, `Cache-Control: no-store`. Die Werte gelten ab
Server-Start (keine Versionierung, kein Versionsfeld). Jede erfolgreiche
Antwort überschreibt den Client-Cache. Der Server loggt die Responses nicht,
den PIN nie.

**Nie in einer Client-Response** (Test belegt das): `vlm.*` (Prompts, Modell,
Request), `activities[].vlmDefinition`, `categories[].vlmDefinition`,
`overreliance.*`, `privacy.*`, `reminders.*`, `segmentation.*`, `texts.push`,
`surveys.payoutUrl`. Der PIN nur in `/api/app-config`.

### 4.1 `GET /api/study-config` (drm-web)

- Auth: `Authorization: Bearer <token>`, Participant **oder** Admin (Admin z. B.
  für das Fenster-Label in der Tabellenansicht). Kein Cookie-Fallback. Erlaubt
  auch während Onboarding (`must_change_password`) und nach Studienende.
- `surveys` nur für Participant-Tokens, für Admin-Tokens `null`.
- Reihenfolge der Arrays = Reihenfolge in der YAML (Dropdowns, Items).

Exakter Payload:

```ts
export interface StudyConfigResponse {
  study: { timezone: string };                       // "Europe/Berlin"
  ui: { locale: string; thumbnailsPerActivity: number }; // "en-GB", 5
  windowing: { windowMinutes: number };              // 5
  schedule: { reconstructionOpensAt: string };       // "19:00"
  activities: { key: string; displayLabel: string }[];
  categories: {
    key: string;
    displayLabel: string;
    icon: CategoryIcon;
    description: string;
  }[];
  experienceItems: {
    key: string;
    appliesTo: string[];            // category keys
    question: string;
    shortLabel: string;             // "Mental demand" -> "Mental demand 4/7"
    scale: { min: number; max: number; lowAnchor: string; highAnchor: string };
    requiredOnSubmit: boolean;
  }[];
  texts: {
    rounds: {
      selfIntroTitle: string;
      selfIntroDescription: string;
      assistedIntroTitle: string;
      assistedIntroDescription: string;
      assistedReminderTitle: string;
      assistedReminderBody: string;
      assistedReminderIncorrectLabelsNotice: string | null; // null = nicht anzeigen
      selfEditorHint: string;
      assistedEditorHint: string;
      selfEmptyStateHint: string;
    };
    progress: { selfRound: string; assistedRound: string };
  };
  surveys: {
    onboarding: { url: string; participantParameter: string }; // "participant_id"
    final: { url: string; participantParameter: string };      // "participantId"
  } | null;
}

export type CategoryIcon =
  | "briefcase" | "pause" | "ellipsis" | "coffee" | "users"
  | "house" | "book-open" | "heart" | "circle";
```

Das Web hängt wie heute `participantParameter=<username>` an die URL an.

### 4.2 `GET /api/payout` (neu, ersetzt die Next-Route `/payout`)

- **Auth (geändert nach Review von PR #1, M1):** nur für eine angemeldete Teilnehmerin
  mit abgeschlossenem Onboarding, wie auf master das Next-Gate in `drm-web/src/proxy.ts`.
  Der Link ist eine normale Browser-Navigation ohne Bearer. Deshalb akzeptiert der Server
  neben `Authorization: Bearer` auch das Cookie `blinks_token`, das das Web schon für
  `/frames/*` setzt (same-origin über Apache bzw. den Dev-Proxy). Nur GET ohne
  Seiteneffekt, daher ist der Cookie-Fallback CSRF-unkritisch.
- Ohne gültige Teilnehmer-Session (kein/ungültiges Token, Admin-Token): `401`
  `{ "error": "unauthorized" }`. Onboarding nicht abgeschlossen: `403`
  `{ "error": "onboarding required", "code": "onboarding_required" }`. In beiden Fällen
  kein `Location`, der Payout-Link wird nie anonym herausgegeben.
- Web: `survey/page.tsx` verlinkt same-origin `/api/payout`, das Cookie wird mitgeschickt,
  keine Änderung nötig. App: ruft den Endpunkt nicht auf.
- `302` mit `Location: surveys.payoutUrl`, `Cache-Control: no-store` (auch bei 401/403).
- `503` Text `Payout link is not configured.`, falls `payoutUrl` fehlt oder kein https ist.
  (Mit Pflichtfeld im Schema praktisch nur bei einer Example-Config mit Platzhalter,
  die der Loader in Produktion ablehnen soll, siehe F1.)
- Apache leitet `/api` schon an den Server. `drm-web/src/app/payout/route.ts` und
  `PAYOUT_URL` im Web-Service entfallen, `survey/page.tsx` verlinkt `/api/payout`.

### 4.3 `GET /api/app-config` (App, nach Login)

- Auth: Participant-Bearer (`requireAuth`). Ein Admin-Token gilt dort nicht als
  Participant → `401`.
- Die **komplette** Intervall-Map wird geliefert, damit eine in Study Settings
  geänderte Bauform sofort gilt, auch offline.

Exakter Payload:

```ts
export interface AppConfigResponse {
  timezone: string;                                  // "Europe/Berlin"
  schedule: { endSessionAvailableAt: string };       // "19:00", in `timezone`
  devices: { formFactors: { key: string; displayLabel: string }[] };
  capture: { intervalMsByFormFactor: Record<string, number> }; // { necklace: 15000, glasses: 30000 }
  texts: {
    app: {
      recordingNotificationTitle: string;
      recordingNotificationBody: string;
      testRecordingNotificationTitle: string;
      testRecordingNotificationBody: string;
      endSessionAvailableFrom: string;               // enthält "{{time}}"
      onboarding: {
        title: string;
        intro: string;
        occupationLabel: string;
        occupationPlaceholder: string;
        workDescriptionLabel: string;
        workDescriptionPlaceholder: string;
        wakeTimeLabel: string;
        bedTimeLabel: string;
      };
    };
  };
  studySettingsPin: string;                          // 4-8 Ziffern
}
```

`endSessionAvailableAt` wird künftig in `timezone` gerechnet, nicht mehr in der
Telefon-Zeitzone. Auf den Studien-Telefonen (Europe/Berlin) ändert sich nichts.

### 4.4 Fehlerfälle

| Endpunkt | Status | Body | Wann / Client-Verhalten |
|---|---|---|---|
| beide | `401` | `{ "error": "unauthorized" }` | Token fehlt/ungültig (bei app-config auch Admin-Token) → Login |
| beide | `5xx` / Netzwerk | – | Web: Fehlerzustand mit Retry, **keine Defaults im Web-Code**. App: Cache (4.5) |
| `/api/payout` | `401` | `{ "error": "unauthorized" }` | keine Teilnehmer-Session (Bearer oder Cookie `blinks_token`) → Login |
| `/api/payout` | `403` | `{ "error": "onboarding required", "code": "onboarding_required" }` | Onboarding offen → Onboarding |
| `/api/payout` | `503` | Text | nicht konfiguriert |

Eine ungültige Config gibt es zur Laufzeit nicht, weil der Server dann nicht startet.

### 4.5 Offline / Cache (App)

- Der letzte erfolgreiche Stand wird **pro User** gecacht: PIN in SecureStore,
  der Rest als Datei (SecureStore-Werte über ~2 KB können scheitern).
  Jede erfolgreiche Antwort überschreibt den Cache vollständig.
- Die Aufnahme scheitert nie an der Config. **Ohne Cache:** Die Kamera nimmt mit
  dem Firmware-Default auf, die App sendet **kein** `0x03`, Study Settings bleibt
  gesperrt („einmal online öffnen“). Es gibt **keinen Fallback-PIN im Code**
  (`app-config.ts` und `eas.json` werden bereinigt).
- Logout löscht den Cache dieses Users.

### 4.6 Ratings (ersetzt `workloadRating`/`recoveryRating`)

Betrifft Round-API (`GET/PUT /api/reconstruction/round/:round`, `POST …/submit`),
Photos-/Admin-Responses mit Activities.

```ts
ratings: Record<string /* experienceItem.key */, number | null>;
```

Regeln:

1. **Response:** enthält immer **alle** konfigurierten Item-Keys, `null` = keine Antwort.
2. **Request (PUT/Submit):** Teilmenge erlaubt, fehlende Keys = `null`. `ratings` fehlt ganz = alle `null`.
3. Gespeichert wird jeder gesendete Wert, auch für Items, die nicht zur aktuellen
   Kategorie gehören (wie heute, damit ein Wechsel hin und zurück die Antwort
   behält). **Gewertet** wird nur ein Item mit `categoryLabel ∈ appliesTo`.
4. **Submit:** Jedes Item mit `requiredOnSubmit: true` und finaler Kategorie in
   `appliesTo` muss beantwortet sein. Kategorie ohne Items (z. B. `other`) braucht keins.
5. Anzeige-Reihenfolge der Items = Reihenfolge in der Config. Mehrere Items pro Kategorie sind erlaubt.
6. **Merge** (Web, `mergeWithNextActivity`): Pro Item bleibt der Wert nur, wenn
   beide Zeilen denselben Wert haben **und** das Item zur verbleibenden Kategorie
   gehört. Sonst `null`. Wird die Kategorie geleert, werden alle Items `null`.
7. Kurzlabel in der Read-only-Ansicht: `` `${shortLabel} ${value}/${scale.max}` ``
   für die Items der finalen Kategorie.

Fehlerfälle (`400`, `{ "error": string }`, ein Fehler pro Request wie heute):

| Fall | `error` |
|---|---|
| `ratings` kein Objekt | `activity <i>: ratings must be an object` |
| unbekannter Key | `activity <i>: unknown rating item "<key>"` |
| kein Integer / außerhalb der Skala | `activity <i>: ratings.<key> must be an integer <min>-<max> or null` |
| Pflicht-Item fehlt beim Submit | `activity <i>: ratings.<key> is required to submit a <category> activity` |
| Altes Feld `workloadRating`/`recoveryRating` gesendet | `activity <i>: workloadRating is no longer supported, use ratings` |

### 4.7 Weitere geänderte Shapes

- `GET /api/reconstruction/state`: `availableFromHour: number` wird ersetzt durch
  `availableFrom: "HH:MM"` (Martin stellt das Web um, gleicher Merge).
- Study Settings (`PUT` Bauform): Validierung gegen `devices.formFactors[].key`
  statt der festen Liste. Der DB-CHECK auf `camera_form_factor` entfällt (Tabellen-Rebuild).
- Admin: `activity_ratings` kommt in `ADMIN_TABLE_NAMES` (Tabellenansicht + CSV-Download,
  Whitelist auf dem Server). Das Label macht Martin.

### 4.8 `POST /api/recording/device-info` (F3, entschieden: ja)

Die App meldet nach jedem Connect (BLE-Doc Abschnitt 3, nach Schritt 4) die
Geräteinfo der Kamera. Append-only, best-effort: Die App queued die Meldung wie
die Recording-Events (pro Participant, SecureStore) und wiederholt sie
idempotent. Fehler blockieren die Aufnahme nie.

- Auth: Participant-Bearer (`requireAuth`), Admin-Token → `401`.
- `settingsFormFactor` und `info.formFactor` werden **nicht** gegen `devices.formFactors`
  abgelehnt (eine Abweichung ist genau die Diagnose, die gespeichert werden soll). Der
  Server loggt dann eine Warnung. Werte vom Gerät stehen im Log ohne Steuerzeichen und
  auf 32 Zeichen gekürzt, in der DB unverändert (Review n1/n5).
- Nur für die **Haupt-Session** senden, nicht für Test-Aufnahmen (die erzeugen
  bewusst keine DB-Zeilen). Der Server prüft nicht, ob die Session schon ein
  `start`-Event hat (Queue-Reihenfolge ist best-effort).

Request (`Content-Type: application/json`):

```ts
export interface DeviceInfoReportRequest {
  eventId: string;            // vom Client erzeugt, 1-128 Zeichen, eindeutig pro Participant (Idempotenz)
  session: number;            // Session-ID (Epoch-Sekunden des Start-Taps), wie bei /ingest
  device: string;             // Kamera-BLE-MAC ohne Doppelpunkte, wie bei /ingest (1-64 Zeichen [A-Za-z0-9])
  clientEpochMs: number;      // Telefonzeit der Messung (nach dem zweiten Lesen von …0004)
  requestedIntervalMs: number | null;  // per 0x03 geschrieben; null = kein 0x03 (alte Firmware / kein Config-Cache)
  settingsFormFactor: string | null;   // Bauform aus Study Settings (null = nicht gesetzt)
  info: {                     // JSON aus …0004; null = Characteristic fehlt (alte Firmware) oder unlesbar
    v: number;
    fw: string;
    formFactor: string;
    intervalMs: number;
    defaultMs: number;
    minMs: number;
    maxMs: number;
    [extra: string]: unknown; // unbekannte Felder werden mitgespeichert, nicht abgelehnt
  } | null;
}
```

Antworten:

| Status | Body | Wann |
|---|---|---|
| `201` | `{ "ok": true, "duplicate": false }` | neu gespeichert |
| `200` | `{ "ok": true, "duplicate": true }` | gleiche `eventId` mit identischem Inhalt erneut gesendet (Retry) |
| `200` | `{ "ok": true, "duplicate": false, "stored": false }` | Obergrenze von 5000 gespeicherten Meldungen pro Participant erreicht (Review n5). Bestätigt, aber nicht gespeichert; der Server loggt das einmal. App: wie `201` behandeln (zusätzliches Feld, kein neuer Status) |
| `400` | `{ "error": "<feld>: <grund>" }` | Validierung, z. B. `session must be a positive integer`, `info.intervalMs must be an integer`, `info must be an object or null` |
| `401` | `{ "error": "unauthorized" }` | Token fehlt/ungültig/Admin |
| `409` | `{ "error": "eventId already used with a different payload" }` | `eventId` wiederverwendet mit anderem Inhalt. App: verwerfen, nicht erneut senden |

Die App behandelt `200`/`201`/`400`/`409` als erledigt (aus der Queue entfernen,
`400`/`409` loggen) und wiederholt nur bei Netzwerkfehler und `5xx`.

Speicherung (Tabelle `device_info_reports`, append-only, in Admin-Tabellen + CSV):
`participant, event_id, session, device, client_epoch_ms, server_received_epoch_ms,
requested_interval_ms, settings_form_factor, firmware_version, form_factor,
interval_ms, default_ms, info_json`, `PRIMARY KEY (participant, event_id)`.
`info_json` = das gesendete `info`-Objekt unverändert (oder NULL).

## 5. Overreliance

`enabled: false` → keine Injection, `presented_* = genuine`,
`is_incorrect_annotation_injected = 0`. Der Hinweistext muss dann `null` sein
(Validierungsfehler sonst). Bei `enabled: true` ist `null` erlaubt (bewusste
Studienentscheidung). Logik sonst wie heute: Ziel `ceil(rate × gültige Aktivitäten)`
aus denen mit `mean confidence >= minConfidence`. Liegt keine darüber und
`fallbackToTopWhenNoneAboveThreshold: true`, wird die eine mit der höchsten
Confidence gewählt (heutiges Verhalten). **`rate: 0` bedeutet „nie injizieren“**
(entschieden 17.10., Felix): auch der Fallback entfällt, Verhalten wie `enabled: false`.
Entsprechend muss der Hinweistext auch bei `rate: 0` `null` sein (Validierungsfehler sonst).

## 6. Face-Blur-Schalter

- `true`: exakt heutiges Verhalten.
- `false`: Ingestion legt Frames direkt mit `face_status='done'`,
  `face_method='disabled'`, `face_count=NULL` an. Die drei Gate-Stellen
  (`listFrames`, `getFrameStatusByPath`, VLM `_claim_batch`) bleiben unverändert.
  Server und `deploy.sh` warnen deutlich: unverpixelte Frames gehen an die
  Teilnehmenden **und an den externen VLM-Endpunkt**. Der Blur-Worker arbeitet den
  Rückstand ab und beendet sich mit Hinweis (Exit 3; im systemd-Unit
  `SuccessExitStatus=3`/`RestartPreventExitStatus=3` bei `Restart=always`; `--once`: Exit 0).
  `deploy.sh` toleriert dann den gestoppten `blinks-face-blur`.
- Nach dem Wiedereinschalten bleiben Frames mit `face_method='disabled'` unverpixelt,
  bis sie mit `npm run requeue-unblurred-frames -- --apply` auf `pending` gesetzt werden
  (Review PR #1, m4).
- Schon `pending` Frames beim Umschalten bleiben im Worker-Pfad (werden nicht
  automatisch freigegeben).
- `METHOD_TAG` bleibt `"<method>:centerface@<threshold>"`.

## 7. Ratings-Migration (Plan, Umsetzung nach Freigabe)

```sql
CREATE TABLE activity_ratings (
  activity_id INTEGER NOT NULL
    REFERENCES activities(id) ON DELETE CASCADE,
  item_key    TEXT    NOT NULL,
  value       INTEGER NOT NULL,
  PRIMARY KEY (activity_id, item_key)
);
```

- Unbeantwortet = **keine Zeile**. Kein Abgleich von `item_key` mit der Config in
  der DB (Config ist nicht in der DB, Vorgabe Felix). Der Server validiert beim Schreiben.
- Migration in `initDb`, **eine Transaktion**, Muster wie die bestehenden Migrationen:
  1. falls `activities.workload_rating` existiert: Tabelle anlegen
  2. `INSERT … SELECT id, 'mental_demand', workload_rating FROM activities WHERE workload_rating IS NOT NULL`
  3. dito `recovery_rating → 'mental_recovery'`
  4. Prüfen: Anzahl Nicht-NULL-Ratings vorher = Zeilen in `activity_ratings`
  5. `activities` ohne die zwei Spalten neu bauen (Rebuild wegen Self-FK
     `proposal_activity_id`), IDs erhalten
  6. `PRAGMA foreign_key_check` leer, sonst Rollback
- Die Keys `mental_demand`/`mental_recovery` sind in der Migration fest (sie
  beschreiben die Alt-Daten), unabhängig von der aktuellen Config.
- Nachziehen: Draft-PUT/Submit ersetzen auch die Ratings der Kinder,
  Proposal→Assisted-Kopie, `ADMIN_TABLE_NAMES`, `seed-demo-data.ts`,
  `backfill-demo-vlm-probabilities.ts`. `export.csv` ist frame-basiert, ohne Ratings.
- Test: `scripts/test-ratings-migration.ts` analog `test-reconstruction-timing-migration.ts`.
  Danach **Kopie der Prod-DB** (`sqlite3 .backup`, über Alessa von Felix):
  Zeilenzahlen vorher/nachher, `PRAGMA quick_check`, `PRAGMA foreign_key_check`,
  Stichprobe. Protokoll in den PR.

## 8. Entscheidungen

Mit Martin geklärt (Freigabe 17.10.): Kurzlabel, Skalengrenzen, Icon-Allowlist,
`availableFrom: "HH:MM"`, Zeitzone in app-config, Hinweis-Validierung,
Mindestintervall 5 s, Payloads, `/api/payout`, Ratings-Regeln (400 für alte
Rating-Felder), Cache, BLE-Ablauf, bei Bauform-Mismatch gilt Study Settings + Warnung.

Von **Felix** entschieden (17.10., alle wie vorgeschlagen):

- **F1 entschieden:** Ohne `config/study.yaml` startet die Produktion nicht (`NODE_ENV=production`,
  kein Fallback auf die Example). `deploy.sh` prüft und validiert die Datei.
- **F2 entschieden:** Mindest-Capture-Intervall 5 s.
- **F3 entschieden:** Die App meldet die Device-Info an den Server (4.8).
- **F4 entschieden:** Auflösung und JPEG-Qualität bleiben fix, nicht konfigurierbar.
- **F5 entschieden:** Segmentierung nur über `segmentation.mergeAcrossCaptureGaps`.
- **F6 entschieden:** Für die nächste Studie wird ein neuer Settings-PIN in `study.yaml` gesetzt.
- **F7 entschieden:** `endSessionAvailableAt` gilt in `study.timezone`, nicht in der Telefon-Zeitzone.
