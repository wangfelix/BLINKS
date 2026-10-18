// Closed activity vocabulary shared by the reconstruction API contract.
// Source of truth: activities[] in the study config (config/study.yaml).
import { ACTIVITY_KEY_SET, ACTIVITY_KEYS } from "./study-config";

export const ACTIVITY_LABELS: readonly string[] = ACTIVITY_KEYS;

export type ActivityLabel = string;

export const ACTIVITY_LABEL_SET: ReadonlySet<string> = ACTIVITY_KEY_SET;
