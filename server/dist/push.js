"use strict";
// ===========================================================================
// Evening push reminders (DRM subproject).
//
// In-process scheduler: every 60 s it computes the local time in the study
// timezone. At/after the reminder hour (19:00) every participant with a
// registered Expo push token and >=1 frame captured today gets a "reconstruct
// your day" push, once per day (tracked via participants.last_reminder_day).
// At/after the follow-up hour (21:00) a second push goes out if today's
// reconstruction is still not submitted (tracked via last_followup_day).
//
// Delivery is a plain fetch to the Expo push service (which fronts FCM); a
// batch array of messages is allowed in one request. Failures are logged and
// never crash the server — a missed reminder must not cost frames.
// ===========================================================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.startPushScheduler = startPushScheduler;
const db_1 = require("./db");
const time_1 = require("./time");
const EXPO_PUSH_ENDPOINT = "https://exp.host/--/api/v2/push/send";
const WEB_URL = process.env.WEB_URL ?? "http://blinks.win.kit.edu";
const REMINDER_HOUR = Number(process.env.DRM_REMINDER_HOUR ?? 19);
const FOLLOWUP_HOUR = Number(process.env.DRM_FOLLOWUP_HOUR ?? 21);
const TICK_INTERVAL_MS = 60000;
const sendPushMessages = async (messages) => {
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
    }
    catch (err) {
        console.error("Expo push send failed:", err);
    }
};
const runSchedulerTick = async () => {
    try {
        const hour = (0, time_1.currentLocalHour)();
        if (hour < REMINDER_HOUR)
            return;
        const today = (0, time_1.todayKey)();
        const messages = [];
        for (const participant of (0, db_1.listPushParticipants)()) {
            if (!participant.push_token)
                continue;
            // No frames today = the camera was not worn; nothing to reconstruct.
            if ((0, db_1.countFramesOnDay)(participant.username, today) === 0)
                continue;
            if (participant.last_reminder_day !== today) {
                // Mark before sending so a flaky Expo endpoint cannot cause spam.
                (0, db_1.setLastReminderDay)(participant.username, today);
                messages.push({
                    to: participant.push_token,
                    title: "Time to reconstruct your day",
                    body: "Please open the study website and reconstruct today's activities.",
                    data: { url: WEB_URL },
                });
                continue;
            }
            if (hour >= FOLLOWUP_HOUR && participant.last_followup_day !== today) {
                const reconstruction = (0, db_1.getReconstruction)(participant.username, today);
                if (reconstruction?.status === "submitted")
                    continue;
                (0, db_1.setLastFollowupDay)(participant.username, today);
                messages.push({
                    to: participant.push_token,
                    title: "Your day is still waiting",
                    body: "Today's reconstruction is not submitted yet. Please open the study website to finish it.",
                    data: { url: WEB_URL },
                });
            }
        }
        if (messages.length > 0)
            await sendPushMessages(messages);
    }
    catch (err) {
        console.error("Push scheduler tick failed:", err);
    }
};
// Starts the 60 s scheduler loop. DISABLE_PUSH=1 turns it off entirely
// (tests, local dev without Expo credentials).
function startPushScheduler() {
    if (process.env.DISABLE_PUSH === "1") {
        console.log("Push scheduler disabled (DISABLE_PUSH=1)");
        return;
    }
    setInterval(() => {
        void runSchedulerTick();
    }, TICK_INTERVAL_MS);
    console.log(`Push scheduler started (reminder ${REMINDER_HOUR}:00, follow-up ${FOLLOWUP_HOUR}:00 local study time)`);
}
