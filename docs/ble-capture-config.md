# BLE: Capture-Intervall setzen (`0x03`) + Device-Info (`…0004`) — WP0-Entwurf

Status: **Entwurf zur Review durch Martin** (BLINKS-tasks#3/#4), Pre-Review
(https://github.com/wangfelix/BLINKS-tasks/issues/3#issuecomment-6237693031) eingearbeitet.
Gilt für beide Firmwares (`camera-firmware/` = Necklace, `glasses-camera-firmware/`
= Glasses, der PIO-Build inkludiert die Glasses-`.ino`) und die App
(`blinks-edge-app/src/capture/ble/`). Byte-Layout, Keys und Grenzen sind auf
beiden Seiten identisch.

Unverändert (nicht im Scope): Service `9a8b7c6d-0001-4a5b-8c9d-0e1f2a3b4c5d`,
Frame-Characteristic `…0002` (notify, `[0x01][len BE4][counter BE4]` / `[0x02][≤180 B]`),
Advertising-Name `BLINKS-CAM`, Opcodes `0x01` pause / `0x02` resume.

## 1. Opcode `0x03` auf Control `9a8b7c6d-0003-4a5b-8c9d-0e1f2a3b4c5d`

**Payload: genau 5 Bytes**, write-with-response:

| Byte | Länge | Inhalt |
|---|---|---|
| 0 | 1 | `0x03` = SET_CAPTURE_INTERVAL |
| 1–4 | 4 | `intervalMs`, `uint32` **big-endian** (wie der Frame-Header) |

Beispiele: 15 s `03 00 00 3A 98`, 30 s `03 00 00 75 30`, 60 s `03 00 00 EA 60`.

Firmware:

- **Länge ≠ 5** → ignorieren, Log `Control: bad 0x03 length <n>`, Intervall unverändert.
- **Clamping:** `CAPTURE_INTERVAL_MIN_MS = 5000`, `CAPTURE_INTERVAL_MAX_MS = 600000`
  (gleiche Werte wie `server/src/study-config/schema.ts`). Werte außerhalb werden
  auf die Grenze gezogen, Log mit Roh- und Effektivwert. `static_assert(CAMERA_WARMUP_MS < CAPTURE_INTERVAL_MIN_MS)`.
- **Wirkung sofort:** nächster Capture bei `letzter Capture + neues Intervall`.
  Ist das schon vorbei, wird nach dem Warm-up beim nächsten `loop()` aufgenommen.
  `warmupThreshold = intervalMs - CAMERA_WARMUP_MS` aus der Laufzeitvariablen.
- `#define CAPTURE_INTERVAL_MS` bleibt der **Default** (15000 Necklace, 30000 Glasses).
- **Disconnect:** zurück auf den Default, analog zu `paused`. Das Handy ist die
  Autorität und setzt den Wert bei jedem Connect neu.
- Pause und Intervall sind unabhängig.
- Unbekannte Opcodes (`default:`-Zweig) werden weiter nur geloggt.

**Alte Firmware** hat keinen `0x03`-Fall, loggt `unknown opcode 0x03` und nimmt
mit dem einkompilierten Intervall weiter auf. Der GATT-Write gelingt trotzdem.
Deshalb erkennt die App Support **nicht am Write, sondern an `…0004`**.

## 2. Device-Info `9a8b7c6d-0004-4a5b-8c9d-0e1f2a3b4c5d` (read)

Neu, nur lesbar, kein Notify. Inhalt: **kompaktes UTF-8-JSON**, ohne Leerzeichen:

```json
{"v":1,"fw":"1.3.0","formFactor":"glasses","intervalMs":30000,"defaultMs":30000,"minMs":5000,"maxMs":600000}
```

| Feld | Typ | Bedeutung |
|---|---|---|
| `v` | int | Format dieser Characteristic (`1`). Keine Config-Version |
| `fw` | string | Firmware-Version (neue Konstante `FIRMWARE_VERSION`, semver) |
| `formFactor` | string | `"necklace"` / `"glasses"`, dieselben Keys wie `devices.formFactors[].key` |
| `intervalMs` | int | **effektives** Intervall nach Clamping |
| `defaultMs` | int | einkompilierter Default |
| `minMs`, `maxMs` | int | Clamping-Grenzen |

- Länge ~110 Bytes. Die App fordert schon MTU 517 an (`camera-link.ts:219`),
  sonst liest Android lange Werte per Read Blob.
- Die Firmware aktualisiert den Wert bei Connect, nach `0x03` und bei Disconnect.
- Erweiterungen: nur neue Felder. Die App ignoriert unbekannte Felder. `v` steigt
  nur bei inkompatiblen Änderungen. Ungültiges JSON → wie „nicht unterstützt“ behandeln, loggen.

## 3. App: Support-Erkennung und Reihenfolge beim Connect

Support: Ist `…0004` nach `discoverAllServicesAndCharacteristics` vorhanden, kann
die Kamera `0x03`. Fehlt sie → Warnung ins Log, **kein** `0x03`, Aufnahme mit Firmware-Default.

Reihenfolge nach jedem (Re-)Connect:

1. `requestMTU(517)`, discover
2. `…0004` lesen (Support + gemeldete Bauform)
3. Intervall = `capture.intervalMsByFormFactor[<Bauform aus Study Settings>]` aus
   `/api/app-config` (Cache) → `0x03` schreiben. Ohne Config-Cache: kein `0x03`.
4. `…0004` erneut lesen, `intervalMs` loggen. Warnung, wenn es vom gewünschten
   Wert abweicht (geklemmt) oder `formFactor` ≠ Bauform aus Study Settings.
   Bei Mismatch gilt weiter die Bauform aus Study Settings (die Teilnehmer-Einstellung
   ist die Wahrheit, wie heute), die Warnung erscheint in Study Settings.
5. Pause-Zustand neu setzen (`0x01`/`0x02`), wie heute
6. Frames auf `…0002` abonnieren

Fehler in 2–4 brechen die Aufnahme **nie** ab. Ändert sich die Bauform in Study
Settings während einer Verbindung, schreibt die App `0x03` sofort neu und liest `…0004`.

## 4. Device-Info an den Server melden? (offen für Felix)

**Vorschlag: ja**, minimal und append-only.

Begründung:
- Das effektive Intervall bestimmt, wie viele Frames ein 5-Minuten-Fenster maximal
  hat. Für die Auswertung von Frame-Loss (`device_frame`-Lücken) und für den
  Methodenteil muss pro Session belegbar sein, mit welchem Intervall und welcher
  Firmware aufgenommen wurde. Nur App-Logs sind dafür nicht zuverlässig
  (Hintergrund-Logs gehen verloren, kein Zugriff nach Rückgabe der Geräte).
- Mit konfigurierbarem Intervall ist das neu eine echte Variable. Ein Klemmen oder
  alte Firmware würde sonst unbemerkt bleiben.

Form (Vorschlag): `POST /api/recording/device-info` (Participant-Bearer) mit
`{ session, device, clientEpochMs, info: <JSON aus …0004> }` nach Schritt 4 bei
jedem Connect. Speicherung in einer neuen Tabelle
`device_info_reports(participant, session, device, client_epoch_ms, server_received_epoch_ms, firmware_version, form_factor, interval_ms, default_ms)`.
Best-effort: Queue wie bei Recording-Events, Fehler blockieren nie. Kein Teil der
Recording-Events, damit deren Idempotenz-Regeln unverändert bleiben.

Folgen: neue Tabelle mit Gerätedaten in der Prod-DB, kleiner zusätzlicher Endpunkt.
Deshalb **offen für Felix (F3)**. Bis zur Entscheidung loggt die App nur. Der
Endpunkt kann nach der Freigabe nachgezogen werden, ohne den übrigen Vertrag zu ändern.

## 5. Hardware-Test (Felix, im Firmware-PR)

1. Beide Firmwares flashen, Serial 115200.
2. Intervall 15 s / 30 s / 60 s per App setzen, Frame-Abstand prüfen (Serial + `capture_epoch_ms`).
3. Grenzen: 1000 ms → 5000 ms, 700000 ms → 600000 ms (Log + `…0004`). Falsche Länge wird ignoriert.
4. Disconnect/Reconnect: Firmware fällt auf den Default, App setzt neu.
5. Alte App + neue Firmware (Default) und neue App + alte Firmware (kein `…0004`, kein `0x03`, keine Störung).
6. Glasses: kurzer Akku-Test 30 s vs. 15 s.
