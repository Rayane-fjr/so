/**
 * pasteClassifier.ts
 * Determines whether a VS Code TextDocumentChangeEvent qualifies as inserted
 * external code, including clipboard pastes and AI-agent edits.
 *
 * FR-04: Internal inserts must never affect BRI.
 * FR-10: No code content is ever logged, stored, or transmitted.
 *        Only metadata (lineCount, isInternal, IDs, timestamps) is extracted.
 */

import * as vscode from 'vscode';
import { BehavioralEvent } from '../types';

/** Minimum number of inserted lines for a change to affect BRI. */
const MIN_INSERTED_LINES = 3;

interface InsertClassification {
  lineCount: number;
  isInternal: boolean;
}

function normalizeForInternalComparison(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
}

function normalizeCodeBlockLines(text: string): string[] {
  return normalizeForInternalComparison(text)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

function countInsertedLines(text: string): number {
  return text.split('\n').filter((line) => line.trim() !== '').length;
}

export function containsInsertedCode(sourceText: string, insertedText: string): boolean {
  const normalizedInsert = normalizeForInternalComparison(insertedText);
  if (normalizedInsert === '') {
    return true;
  }

  const normalizedSource = normalizeForInternalComparison(sourceText);
  if (normalizedSource.includes(normalizedInsert)) {
    return true;
  }

  const insertedLines = normalizeCodeBlockLines(insertedText);
  if (insertedLines.length < MIN_INSERTED_LINES) {
    return false;
  }

  const sourceLines = normalizeCodeBlockLines(sourceText);
  for (let i = 0; i <= sourceLines.length - insertedLines.length; i++) {
    let matches = true;
    for (let j = 0; j < insertedLines.length; j++) {
      if (sourceLines[i + j] !== insertedLines[j]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return true;
    }
  }

  return false;
}

/**
 * Checks whether insertedText exists verbatim in any open workspace document
 * other than the document that was just changed.
 *
 * FR-10: insertedText is read here for comparison only; it is never stored.
 */
function isInternalInsert(
  insertedText: string,
  excludeDoc: vscode.TextDocument,
  previousDocumentText?: string,
  internalSourceTexts: readonly string[] = []
): boolean {
  if (
    previousDocumentText !== undefined &&
    containsInsertedCode(previousDocumentText, insertedText)
  ) {
    return true;
  }

  if (internalSourceTexts.some((text) => containsInsertedCode(text, insertedText))) {
    return true;
  }

  for (const doc of vscode.workspace.textDocuments) {
    if (doc === excludeDoc) {
      continue;
    }
    if (containsInsertedCode(doc.getText(), insertedText)) {
      return true;
    }
  }
  return false;
}

function areInsertedTextsInternal(
  insertedTexts: readonly string[],
  excludeDoc: vscode.TextDocument,
  previousDocumentText?: string,
  internalSourceTexts: readonly string[] = []
): boolean {
  const combinedInsertedText = insertedTexts.join('\n');
  if (
    isInternalInsert(
      combinedInsertedText,
      excludeDoc,
      previousDocumentText,
      internalSourceTexts
    )
  ) {
    return true;
  }

  const substantialTexts = insertedTexts.filter(
    (text) => countInsertedLines(text) >= MIN_INSERTED_LINES
  );
  if (substantialTexts.length === 0 || substantialTexts.length !== insertedTexts.length) {
    return false;
  }

  return substantialTexts.every((text) =>
    isInternalInsert(text, excludeDoc, previousDocumentText, internalSourceTexts)
  );
}

export function classifyInsertedTexts(
  insertedTexts: readonly string[],
  excludeDoc: vscode.TextDocument,
  previousDocumentText?: string,
  internalSourceTexts: readonly string[] = []
): InsertClassification | null {
  const nonEmptyInsertedTexts = insertedTexts.filter((text) => text.trim() !== '');
  if (nonEmptyInsertedTexts.length === 0) {
    return null;
  }

  const lineCount = nonEmptyInsertedTexts.reduce(
    (sum, text) => sum + countInsertedLines(text),
    0
  );

  if (lineCount < MIN_INSERTED_LINES) {
    return null;
  }

  return {
    lineCount,
    isInternal: areInsertedTextsInternal(
      nonEmptyInsertedTexts,
      excludeDoc,
      previousDocumentText,
      internalSourceTexts
    ),
  };
}

/**
 * Classifies a TextDocumentChangeEvent as a BehavioralEvent or returns null.
 *
 * A change qualifies as inserted external code when:
 *   - One or more content-change entries insert non-whitespace text
 *   - The inserted text spans MIN_INSERTED_LINES or more non-empty lines
 *
 * FR-10: Inserted text is used only for internal-source checks and is never
 * attached to the returned BehavioralEvent.
 */
export function classifyPasteEvent(
  change: vscode.TextDocumentChangeEvent,
  sessionId: string,
  previousDocumentText?: string,
  internalSourceTexts: readonly string[] = []
): BehavioralEvent | null {
  const insertedTexts = change.contentChanges
    .map((contentChange) => contentChange.text)
    .filter((text) => text.trim() !== '');

  if (insertedTexts.length === 0) {
    return null;
  }

  const classification = classifyInsertedTexts(
    insertedTexts,
    change.document,
    previousDocumentText,
    internalSourceTexts
  );
  if (classification === null) {
    return null;
  }

  // Keep the historical event type for compatibility with the rest of the app.
  return {
    eventId: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    sessionId,
    occurredAt: new Date().toISOString(),
    eventType: 'PASTE',
    lineCount: classification.lineCount,
    isInternal: classification.isInternal,
    isUndone: false,
    modificationDepth: 0.0,
  };
}
