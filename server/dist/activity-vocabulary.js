"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ACTIVITY_LABEL_SET = exports.ACTIVITY_LABELS = void 0;
// Closed activity vocabulary shared by the reconstruction API contract.
// Source of truth: activities[] in the study config (config/study.yaml).
const study_config_1 = require("./study-config/index.js");
exports.ACTIVITY_LABELS = study_config_1.ACTIVITY_KEYS;
exports.ACTIVITY_LABEL_SET = study_config_1.ACTIVITY_KEY_SET;
