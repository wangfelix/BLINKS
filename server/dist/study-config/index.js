"use strict";
// Process-wide study config plus the derived values the server uses.
// Loaded once on first import; an invalid file exits the process with code 2
// (see load.ts). All study-relevant values come from here, never from env.
Object.defineProperty(exports, "__esModule", { value: true });
exports.minutesOfTimeOfDay = exports.IDLE_CLOSE_MS = exports.WINDOW_MS = exports.EXPERIENCE_ITEMS = exports.FORM_FACTOR_KEYS = exports.CATEGORY_KEY_SET = exports.CATEGORY_KEYS = exports.ACTIVITY_KEY_SET = exports.ACTIVITY_KEYS = exports.studyConfig = void 0;
const load_1 = require("./load.js");
exports.studyConfig = (0, load_1.getStudyConfig)();
exports.ACTIVITY_KEYS = exports.studyConfig.activities.map((activity) => activity.key);
exports.ACTIVITY_KEY_SET = new Set(exports.ACTIVITY_KEYS);
exports.CATEGORY_KEYS = exports.studyConfig.categories.map((category) => category.key);
exports.CATEGORY_KEY_SET = new Set(exports.CATEGORY_KEYS);
exports.FORM_FACTOR_KEYS = exports.studyConfig.devices.formFactors.map((formFactor) => formFactor.key);
exports.EXPERIENCE_ITEMS = exports.studyConfig.experienceItems;
exports.WINDOW_MS = exports.studyConfig.windowing.windowMinutes * 60000;
exports.IDLE_CLOSE_MS = exports.studyConfig.windowing.idleCloseMinutes * 60000;
/** "HH:MM" -> minutes since midnight (already validated by the schema). */
const minutesOfTimeOfDay = (value) => {
    const [hour, minute] = value.split(":").map(Number);
    return hour * 60 + minute;
};
exports.minutesOfTimeOfDay = minutesOfTimeOfDay;
