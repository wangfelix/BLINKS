"use strict";
// ===========================================================================
// Bedtime fallback push reminder (DRM subproject, single-day design).
//
// Participants are told in the lab to do the evening reconstruction + surveys
// on their own; the push is only the FALLBACK if they forget. In-process
// scheduler: every 60 s it computes the local time in the study timezone and,
// once the participant's reminder time is reached (their reported bedtime
// from app onboarding minus BEDTIME_REMINDER_LEAD_MIN minutes), sends one push to
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.getPushSchedulerStatus = exports.BEDTIME_REMINDER_LEAD_MIN = void 0;
exports.acceptedExpoPushTickets = acceptedExpoPushTickets;
exports.reminderMinutesFor = reminderMinutesFor;
exports.startPushScheduler = startPushScheduler;
const db_1 = require("./db");
const time_1 = require("./time");
const EXPO_PUSH_ENDPOINT = "https://exp.host/--/api/v2/push/send";
const WEB_URL = process.env.WEB_URL ?? "https://blinks.win.kit.edu";
const DEFAULT_BEDTIME = process.env.DRM_DEFAULT_BEDTIME ?? "22:00";
exports.BEDTIME_REMINDER_LEAD_MIN = 30;
const LATEST_REMINDER_MINUTES = 23 * 60 + 50; // 23:50, see header comment
const TICK_INTERVAL_MS = 60000;
const PUSH_REQUEST_TIMEOUT_MS = 10000;
function acceptedExpoPushTickets(payload, expectedCount) {
    const fallback = Array.from({ length: expectedCount }, () => false);
    if (typeof payload !== "object" || payload === null)
        return fallback;
    const tickets = payload.data;
    if (!Array.isArray(tickets) || tickets.length !== expectedCount) {
        return fallback;
    }
    return tickets.map((ticket) => typeof ticket === "object" &&
        ticket !== null &&
        ticket.status === "ok");
}
// Minutes since local midnight at which a participant's fallback reminder
// fires.
function reminderMinutesFor(bedTime) {
    const bedMinutes = (0, time_1.timeOfDayToMinutes)(bedTime) ?? (0, time_1.timeOfDayToMinutes)(DEFAULT_BEDTIME) ?? 22 * 60;
    // Bedtime after midnight (heuristic: before noon) -> last chance is 23:50
    // of the study day; firing at bedMinutes-lead would go off in the MORNING of
    // the field day once frames exist.
    if (bedMinutes < 12 * 60)
        return LATEST_REMINDER_MINUTES;
    return Math.min(bedMinutes - exports.BEDTIME_REMINDER_LEAD_MIN, LATEST_REMINDER_MINUTES);
}
const sendPushMessages = async (messages) => {
    const rejected = () => messages.map(() => false);
    try {
        const response = await fetch(EXPO_PUSH_ENDPOINT, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(messages),
            signal: AbortSignal.timeout(PUSH_REQUEST_TIMEOUT_MS),
        });
        if (!response.ok) {
            const detail = await response.text().catch(() => "");
            console.error(`Expo push send failed: HTTP ${response.status} ${detail}`);
            return rejected();
        }
        const payload = (await response.json().catch(() => null));
        const accepted = acceptedExpoPushTickets(payload, messages.length);
        const tickets = typeof payload === "object" && payload !== null
            ? payload.data
            : undefined;
        if (Array.isArray(tickets)) {
            tickets.forEach((ticket, index) => {
                if (accepted[index])
                    return;
                const typedTicket = ticket;
                console.error(`Expo rejected push ${index + 1}: ${typedTicket.message ?? "unknown error"}` +
                    (typedTicket.details?.error
                        ? ` (${typedTicket.details.error})`
                        : ""));
            });
        }
        else {
            console.error("Expo push send failed: malformed ticket response");
        }
        console.log(`Expo accepted ${accepted.filter(Boolean).length}/${messages.length} push message(s)`);
        return accepted;
    }
    catch (err) {
        console.error("Expo push send failed:", err);
        return rejected();
    }
};
const runSchedulerTick = async () => {
    try {
        const nowMinutes = (0, time_1.currentLocalMinutes)();
        const today = (0, time_1.todayKey)();
        const pending = [];
        for (const participant of (0, db_1.listPushParticipants)()) {
            if (!participant.push_token)
                continue;
            if (participant.last_reminder_day === today)
                continue;
            if (nowMinutes < reminderMinutesFor(participant.bed_time))
                continue;
            // No frames today = the camera was not worn; nothing to reconstruct.
            if ((0, db_1.countFramesOnDay)(participant.username, today) === 0)
                continue;
            // Fully done for the evening once round 2 is submitted.
            if ((0, db_1.getRoundResponseList)(participant.username, 2)?.status === "submitted") {
                continue;
            }
            pending.push({
                participant: participant.username,
                message: {
                    to: participant.push_token,
                    title: "Before you go to bed",
                    body: "Please open the study website and reconstruct today before going to sleep.",
                    data: { url: WEB_URL },
                    priority: "high",
                    channelId: "default",
                },
            });
        }
        if (pending.length > 0) {
            const accepted = await sendPushMessages(pending.map((item) => item.message));
            accepted.forEach((wasAccepted, index) => {
                if (wasAccepted)
                    (0, db_1.setLastReminderDay)(pending[index].participant, today);
            });
        }
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
    let tickRunning = false;
    setInterval(() => {
        if (tickRunning) {
            console.warn("Push scheduler skipped an overlapping tick");
            return;
        }
        tickRunning = true;
        void runSchedulerTick().finally(() => {
            tickRunning = false;
        });
    }, TICK_INTERVAL_MS);
    console.log(`Push scheduler started (bedtime fallback, lead ${exports.BEDTIME_REMINDER_LEAD_MIN} min, default bedtime ${DEFAULT_BEDTIME} local study time)`);
}
const getPushSchedulerStatus = () => ({
    enabled: process.env.DISABLE_PUSH !== "1",
    leadMinutes: exports.BEDTIME_REMINDER_LEAD_MIN,
});
exports.getPushSchedulerStatus = getPushSchedulerStatus;
