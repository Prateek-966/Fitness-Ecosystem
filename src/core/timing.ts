import type { Db } from './db';
import { getSetting } from './settings';

/**
 * Acceptance criterion 1 says "under 3 seconds, measured not estimated".
 * A number nobody stored is an estimate, so every capture stores one.
 *
 * The clock starts at the mic tap, not at the transcript, because the
 * hypothesis under test is about the whole gesture — tap to persisted —
 * not about the part of it this code happens to control.
 */

export interface CaptureMarks {
  micTap: number;
  sttReturned?: number;
  utteranceCommitted?: number;
  entriesCommitted: number;
}

export function recordTiming(
  db: Db, utteranceId: number, marks: CaptureMarks, fastPath: boolean, entryCount: number,
): number {
  const total = marks.entriesCommitted - marks.micTap;
  db.run(
    `INSERT INTO capture_timing
       (utterance_id, mic_tap_to_stt, stt_to_capture, capture_to_entry,
        total_ms, fast_path, entry_count)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(utterance_id) DO UPDATE SET
       mic_tap_to_stt   = excluded.mic_tap_to_stt,
       stt_to_capture   = excluded.stt_to_capture,
       capture_to_entry = excluded.capture_to_entry,
       total_ms         = excluded.total_ms,
       fast_path        = excluded.fast_path,
       entry_count      = excluded.entry_count`,
    [
      utteranceId,
      marks.sttReturned != null ? marks.sttReturned - marks.micTap : null,
      marks.sttReturned != null && marks.utteranceCommitted != null
        ? marks.utteranceCommitted - marks.sttReturned : null,
      marks.utteranceCommitted != null
        ? marks.entriesCommitted - marks.utteranceCommitted : null,
      total,
      fastPath ? 1 : 0,
      entryCount,
    ],
  );
  return total;
}

export function isUnderTarget(db: Db, totalMs: number): boolean {
  return totalMs <= getSetting(db, 'target_capture_ms');
}
