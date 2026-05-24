/**
 * types.ts
 * Shared TypeScript interfaces and constants used across the entire
 * Bounded extension (data, business, and presentation layers).
 * No VS Code or Node.js imports — pure type definitions only.
 */

// ── Primitive union types ────────────────────────────────────────────────────

/** BRI severity band as stored and displayed. */
export type BRIStateLabel = 'low' | 'moderate' | 'severe';

/** Operating mode chosen by the user. */
export type BoundedMode = 'Standard' | 'Strict';

// ── Core data shapes ─────────────────────────────────────────────────────────

/** Per-session counters held in memory and embedded in bri-state.json. */
export interface SessionSnapshot {
  linesTyped: number;
  linesPasted: number;
  pasteEventCount: number;
  unmodifiedPastes: number;
  longestTypingStreak: number;
  briDeltaSinceStart: number;
}

/**
 * Full BRI state persisted to bri-state.json on every workspace save (FR-11).
 * Never contains code content (FR-10).
 */
export interface BRIState {
  currentBRI: number;       // 0.0 – 1.0
  stateLabel: BRIStateLabel;
  activeMode: BoundedMode;
  lastSaved: string;        // ISO 8601 timestamp
  sessionSnapshot: SessionSnapshot;
}

/**
 * One completed session record appended to session-history.json.
 * Never contains code content (FR-10).
 */
export interface SessionRecord {
  date: string;             // ISO date string e.g. "2025-04-21"
  finalBRI: number;
  linesTyped: number;
  linesPasted: number;
  pasteEventCount: number;
  modeActive: BoundedMode;
}

/**
 * A single behavioral event captured during a session.
 * Kept in memory only — never written to disk.
 */
export interface BehavioralEvent {
  eventId: string;          // uuid or timestamp-based ID
  sessionId: string;
  occurredAt: string;       // ISO 8601 timestamp
  eventType: 'PASTE' | 'UNDO' | 'MODIFICATION';
  lineCount: number;
  isInternal: boolean;      // FR-04: internal paste → no BRI change
  isUndone: boolean;        // FR-06: undone paste → BRI decrease
  modificationDepth: number; // FR-05: 0 = no edits, higher = more edits applied
}

// ── Defaults ─────────────────────────────────────────────────────────────────

/** Returned on first launch or when bri-state.json is missing / corrupt. */
/**This is a fallback object that consists of the same interface it was typed in (BRIState)*/
export const DEFAULT_BRI_STATE: BRIState = {
  currentBRI: 0,
  stateLabel: 'low',
  activeMode: 'Standard',
  lastSaved: new Date().toISOString(),
  sessionSnapshot: {
    linesTyped: 0,
    linesPasted: 0,
    pasteEventCount: 0,
    unmodifiedPastes: 0,
    longestTypingStreak: 0,
    briDeltaSinceStart: 0,
  },
};
