import type { ImportStatus, PhotoStatus, RowStatus } from "./api";
import type { Tone } from "./ui";

// How each status is called and colored, the same everywhere in the dashboard

export const IMPORT_STATUS: Record<ImportStatus, { label: string; tone: Tone }> = {
  waiting_for_files: { label: "Waiting for photos", tone: "neutral" },
  queued: { label: "Queued", tone: "info" },
  running: { label: "Running", tone: "info" },
  paused: { label: "Paused", tone: "paused" },
  done: { label: "Done", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
};

export const ROW_STATUS: Record<RowStatus, { label: string; tone: Tone }> = {
  pending: { label: "Waiting", tone: "neutral" },
  processing: { label: "Working", tone: "info" },
  done: { label: "Done", tone: "success" },
  needs_review: { label: "Needs review", tone: "warning" },
  failed: { label: "Failed", tone: "danger" },
};

export const PHOTO_STATUS: Record<PhotoStatus, { label: string; tone: Tone }> = {
  pending: { label: "Not matched yet", tone: "neutral" },
  matched: { label: "Matched", tone: "success" },
  unmatched: { label: "Unmatched", tone: "warning" },
  rejected: { label: "Rejected", tone: "danger" },
};

export const ACTIVE_STATUSES: ImportStatus[] = ["queued", "running", "paused"];

export const LANGUAGE_NAMES: Record<string, string> = { de: "German", fr: "French" };
