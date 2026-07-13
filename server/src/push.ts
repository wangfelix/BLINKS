// ===========================================================================
// Bedtime fallback push reminder (DRM subproject, single-day design).
//
// Participants are told in the lab to do the evening reconstruction + surveys
// on their own; the push is only the FALLBACK if they forget. In-process
// scheduler: every 60 s it computes the local time in the study timezone and,
// once the participant's reminder time is reached (their reported bedtime
// from app onboarding minus BEDTIME_LEAD_MIN minutes), sends one push to
// every participant with a registered Expo push token, >=1 frame captured
// today, and a reconstruction that is not fully submitted (round 2 still
// open). Sent at most once per day (participants.last_reminder_day).
//
// A bedtime shortly after midnight cannot fire on the study day itself (the
// local date flips first), so bedtimes before 12:00 clamp the reminder to
// 23:50. Participants without a stored bedtime fall back to
// DRM_DEFAULT_BEDTIME (default 22:00).
//
// Delivery is a plain fetch to the Expo push service (which fronts FCM); a
// batch array of messages is allowed in one request. Failures are logged and
// never crash the server — a missed reminder must not cost frames.
// ===========================================================================

import {
  countFramesOnDay,
  getReconstruction,
  listPushParticipants,
  setLastReminderDay,
} from "./db";
import { currentLocalMinutes, timeOfDayToMinutes, todayKey } from "./time";

const EXPO_PUSH_ENDPOINT = "https://exp.host/--/api/v2/push/send";
const WEB_URL = process.env.WEB_URL ?? "http://blinks.win.kit.edu";
const DEFAULT_BEDTIME = process.env.DRM_DEFAULT_BEDTIME ?? "22:00";
const BEDTIME_LEAD_MIN = 10;
const LATEST_REMINDER_MINUTES = 23 * 60 + 50; // 23:50, see header comment
const TICK_INTERVAL_MS = 60_000;

interface PushMessage {
  to: string;
  title: string;
  body: string;
  data: { url: string };
}

// Minutes since local midnight at which a participant's fallback reminder
// fires.
export function reminderMinutesFor(bedTime: string | null | undefined): number {
  const bedMinutes =
    timeOfDayToMinutes(bedTime) ?? timeOfDayToMinutes(DEFAULT_BEDTIME) ?? 22 * 60;
  // Bedtime after midnight (heuristic: before noon) -> last chance is 23:50
  // of the study day; firing at bedMinutes-10 would go off in the MORNING of
  // the field day once frames exist.
  if (bedMinutes < 12 * 60) return LATEST_REMINDER_MINUTES;
  return Math.min(bedMinutes - BEDTIME_LEAD_MIN, LATEST_REMINDER_MINUTES);
}

const sendPushMessages = async (messages: PushMessage[]): Promise<void> => {
  try {
    const response = await fetch(EXPO_PUSH_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(messages),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      console.error(`Expo push send failed: HTTP ${response.status} ${detail}`);
      return;
    }
    console.log(`Sent ${messages.length} push message(s)`);
  } catch (err) {
    console.error("Expo push send failed:", err);
  }
};

const runSchedulerTick = async (): Promise<void> => {
  try {
    const nowMinutes = currentLocalMinutes();
    const today = todayKey();

    const messages: PushMessage[] = [];
    for (const participant of listPushParticipants()) {
      if (!participant.push_token) continue;
      if (participant.last_reminder_day === today) continue;
      if (nowMinutes < reminderMinutesFor(participant.bed_time)) continue;
      // No frames today = the camera was not worn; nothing to reconstruct.
      if (countFramesOnDay(participant.username, today) === 0) continue;
      // Fully done for the evening once round 2 is submitted.
      if (getReconstruction(participant.username, 2)?.status === "submitted") {
        continue;
      }

      // Mark before sending so a flaky Expo endpoint cannot cause spam.
      setLastReminderDay(participant.username, today);
      messages.push({
        to: participant.push_token,
        title: "Before you go to bed",
        body: "Please open the study website and reconstruct today before going to sleep.",
        data: { url: WEB_URL },
      });
    }

    if (messages.length > 0) await sendPushMessages(messages);
  } catch (err) {
    console.error("Push scheduler tick failed:", err);
  }
};

// Starts the 60 s scheduler loop. DISABLE_PUSH=1 turns it off entirely
// (tests, local dev without Expo credentials).
export function startPushScheduler(): void {
  if (process.env.DISABLE_PUSH === "1") {
    console.log("Push scheduler disabled (DISABLE_PUSH=1)");
    return;
  }
  setInterval(() => {
    void runSchedulerTick();
  }, TICK_INTERVAL_MS);
  console.log(
    `Push scheduler started (bedtime fallback, lead ${BEDTIME_LEAD_MIN} min, default bedtime ${DEFAULT_BEDTIME} local study time)`,
  );
}
