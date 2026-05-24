/**
 * eventListener.ts
 * Registers all VS Code editor event listeners and routes events to callbacks
 * via dependency injection. This module owns no business logic; it delegates
 * inserted-code classification to pasteClassifier.ts and notifies callers
 * through the callbacks provided at construction time.
 *
 * NF-01: The onDidChangeTextDocument handler is synchronous. No awaits inside.
 *        Any async follow-up work is wrapped in setImmediate.
 */

import * as vscode from 'vscode';
import { BehavioralEvent } from '../types';
import { classifyInsertedTexts, classifyPasteEvent } from './pasteClassifier';

/** Maximum number of inserted-code events held in memory for undo/modification matching. */
const RECENT_PASTE_WINDOW = 20;
const MAX_CACHED_FILE_BYTES = 1_000_000;
const AGENT_INSERT_BATCH_DELAY_MS = 1200;
const AGENT_INSERT_RECLASSIFY_WINDOW_MS = 6000;
const AGENT_INSERT_MIN_TEXT_LENGTH = 8;

interface TrackedRange {
  startLine: number;
  endLine: number;
  modifiedLines: Set<number>;
}

/**
 * Inserted-code event enriched with document ranges.
 * Ranges let us track multi-location AI edits without treating everything
 * between the first and last edit as inserted code.
 */
interface TrackedPaste {
  event: BehavioralEvent;
  ranges: TrackedRange[];
}

interface PendingInsertBatch {
  document: vscode.TextDocument;
  previousDocumentText: string;
  internalSourceTexts: readonly string[];
  insertedTexts: string[];
  ranges: TrackedRange[];
  netNonEmptyLineDelta: number;
  emittedTypingDelta: number;
  timeout?: ReturnType<typeof setTimeout>;
  expireTimeout?: ReturnType<typeof setTimeout>;
}

export class EventListenerModule {
  private recentPastes: TrackedPaste[] = [];
  private pendingInsertBatches: Map<string, PendingInsertBatch> = new Map();
  private documentLineSnapshots: Map<string, string[]> = new Map();
  private workspaceTextCache: Map<string, string> = new Map();
  private sessionId: string = '';

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly onPasteDetected: (event: BehavioralEvent) => void,
    private readonly onUndoDetected: (eventId: string, lineCount: number) => void,
    private readonly onModificationDetected: (
      eventId: string,
      modificationDepth: number
    ) => void,
    private readonly onWorkspaceSaved: () => void,
    private readonly onTypingDetected: (linesAdded: number) => void
  ) {}

  public activate(sessionId: string): void {
    this.sessionId = sessionId;
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.scheme === 'file' || doc.uri.scheme === 'untitled') {
        this.documentLineSnapshots.set(this.getDocumentKey(doc), this.snapshotLines(doc));
        this.workspaceTextCache.set(this.getDocumentKey(doc), doc.getText());
      }
    }
    this.refreshWorkspaceTextCache();

    const changeListener = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.contentChanges.length === 0) {
        return;
      }

      const scheme = e.document.uri.scheme;
      if (scheme !== 'file' && scheme !== 'untitled') {
        return;
      }

      const documentKey = this.getDocumentKey(e.document);
      const previousLines = this.documentLineSnapshots.get(documentKey);
      if (previousLines === undefined) {
        this.documentLineSnapshots.set(documentKey, this.snapshotLines(e.document));
        return;
      }

      const previousDocumentText = previousLines.join('\n');
      const internalSourceTexts = Array.from(this.workspaceTextCache.entries())
        .filter(([key]) => key !== documentKey)
        .map(([, text]) => text);
      const pasteEvent = classifyPasteEvent(
        e,
        this.sessionId,
        previousDocumentText,
        internalSourceTexts
      );
      if (pasteEvent !== null) {
        this.flushPendingInsertBatchAsTyping(documentKey, false);

        const currentLines = this.snapshotLines(e.document);
        this.documentLineSnapshots.set(documentKey, currentLines);
        this.workspaceTextCache.set(documentKey, e.document.getText());

        if (pasteEvent.isInternal) {
          console.log(`Bounded: internal insert ignored - lines: ${pasteEvent.lineCount}`);
        } else {
          this.trackInsertedEvent(pasteEvent, e.contentChanges);
        }
        return;
      }

      if (
        this.isPotentialAgentInsertEvent(e, previousLines) ||
        (this.pendingInsertBatches.has(documentKey) && this.hasPositiveLineGrowth(e))
      ) {
        const currentLines = this.snapshotLines(e.document);
        const netLineDelta =
          this.countNonEmptyLines(currentLines) - this.countNonEmptyLines(previousLines);

        this.documentLineSnapshots.set(documentKey, currentLines);
        this.workspaceTextCache.set(documentKey, e.document.getText());
        this.addToPendingInsertBatch(
          documentKey,
          e.document,
          e.contentChanges,
          previousDocumentText,
          internalSourceTexts,
          netLineDelta
        );
        return;
      }

      this.flushPendingInsertBatchAsTyping(documentKey, false);

      const consumedByUndo = new Set<number>();

      for (let ci = 0; ci < e.contentChanges.length; ci++) {
        const c = e.contentChanges[ci];
        const changeStart = c.range.start.line;
        const changeEnd = c.range.end.line;
        const addedLines = c.text === '' ? 0 : c.text.split('\n').length - 1;
        const lineDelta = addedLines - (changeEnd - changeStart);

        for (let i = this.recentPastes.length - 1; i >= 0; i--) {
          const tracked = this.recentPastes[i];
          let modified = false;

          for (let ri = tracked.ranges.length - 1; ri >= 0; ri--) {
            const range = tracked.ranges[ri];

            if (
              c.text.trim() === '' &&
              !c.range.isEmpty &&
              changeStart <= range.startLine &&
              changeEnd >= range.endLine
            ) {
              tracked.ranges.splice(ri, 1);
              consumedByUndo.add(ci);
              continue;
            }

            if (c.text.trim() === '') {
              if (changeEnd < range.startLine) {
                range.startLine += lineDelta;
                range.endLine += lineDelta;
              } else if (changeStart <= range.endLine && changeEnd >= range.startLine) {
                this.adjustRangeForWhitespaceChange(c, range, lineDelta);
              }
              continue;
            }

            if (changeStart <= range.endLine && changeEnd >= range.startLine) {
              if (this.isManualNonEmptyInsertOnEmptyLine(c, previousLines)) {
                continue;
              }

              consumedByUndo.add(ci);
              modified = true;
              const touchedStart = Math.max(changeStart, range.startLine);
              const touchedEnd = Math.min(Math.max(changeEnd, changeStart), range.endLine);
              for (let line = touchedStart; line <= touchedEnd; line++) {
                range.modifiedLines.add(line);
              }
              continue;
            }

            if (changeEnd < range.startLine) {
              range.startLine += lineDelta;
              range.endLine += lineDelta;
            }
          }

          if (tracked.ranges.length === 0) {
            this.recentPastes.splice(i, 1);
            setImmediate(() => this.onUndoDetected(tracked.event.eventId, tracked.event.lineCount));
            continue;
          }

          if (modified) {
            const modifiedLineCount = tracked.ranges.reduce(
              (sum, range) => sum + range.modifiedLines.size,
              0
            );
            const modificationDepth = Math.min(
              1,
              modifiedLineCount / Math.max(1, tracked.event.lineCount)
            );
            tracked.event.modificationDepth = modificationDepth;
            setImmediate(() =>
              this.onModificationDetected(tracked.event.eventId, modificationDepth)
            );
          }
        }
      }

      const currentLines = this.snapshotLines(e.document);
      const netLineDelta =
        consumedByUndo.size === 0
          ? this.countNonEmptyLines(currentLines) - this.countNonEmptyLines(previousLines)
          : 0;
      this.documentLineSnapshots.set(documentKey, currentLines);
      this.workspaceTextCache.set(documentKey, e.document.getText());
      if (netLineDelta !== 0) {
        setImmediate(() => this.onTypingDetected(netLineDelta));
      }
    });

    const saveListener = vscode.workspace.onDidSaveTextDocument(() => {
      this.onWorkspaceSaved();
    });

    this.context.subscriptions.push(changeListener, saveListener);
  }

  public dispose(): void {
    this.recentPastes = [];
    for (const batch of this.pendingInsertBatches.values()) {
      if (batch.timeout !== undefined) {
        clearTimeout(batch.timeout);
      }
      if (batch.expireTimeout !== undefined) {
        clearTimeout(batch.expireTimeout);
      }
    }
    this.pendingInsertBatches.clear();
    this.documentLineSnapshots.clear();
    this.workspaceTextCache.clear();
  }

  private refreshWorkspaceTextCache(): void {
    vscode.workspace.findFiles(
      '**/*',
      '**/{.git,node_modules,out,dist,build,.vscode-test}/**'
    ).then(async (uris) => {
      for (const uri of uris) {
        try {
          const stat = await vscode.workspace.fs.stat(uri);
          if (stat.size > MAX_CACHED_FILE_BYTES) {
            continue;
          }
          const bytes = await vscode.workspace.fs.readFile(uri);
          this.workspaceTextCache.set(uri.toString(), new TextDecoder('utf-8').decode(bytes));
        } catch {
          // Ignore files that disappear or cannot be decoded; the cache is best-effort.
        }
      }
    }, () => {
      // The cache is best-effort; open documents and future edits still update it.
    });
  }

  private getDocumentKey(document: vscode.TextDocument): string {
    return document.uri.toString();
  }

  private snapshotLines(document: vscode.TextDocument): string[] {
    const lines: string[] = [];
    for (let i = 0; i < document.lineCount; i++) {
      lines.push(document.lineAt(i).text);
    }
    return lines;
  }

  private countNonEmptyLines(lines: string[]): number {
    return lines.filter((line) => line.trim() !== '').length;
  }

  private countNonEmptyTextLines(text: string): number {
    return text.split('\n').filter((line) => line.trim() !== '').length;
  }

  private isPotentialAgentInsertEvent(
    e: vscode.TextDocumentChangeEvent,
    previousLines: readonly string[]
  ): boolean {
    const insertedChanges = this.getNonEmptyInsertedChanges(e);
    if (insertedChanges.length === 0) {
      return false;
    }

    if (insertedChanges.length > 1) {
      return true;
    }

    const change = insertedChanges[0];
    if (this.countNonEmptyTextLines(change.text) > 1) {
      return true;
    }

    return (
      change.text.trim().length >= AGENT_INSERT_MIN_TEXT_LENGTH &&
      (change.range.isEmpty ||
        this.isWhitespaceOnlyRange(change, previousLines) ||
        this.isWholeLineReplacement(change, previousLines))
    );
  }

  private getNonEmptyInsertedChanges(
    e: vscode.TextDocumentChangeEvent
  ): vscode.TextDocumentContentChangeEvent[] {
    return e.contentChanges.filter((change) => change.text.trim() !== '');
  }

  private hasPositiveLineGrowth(e: vscode.TextDocumentChangeEvent): boolean {
    return e.contentChanges.some((change) => {
      if (change.text.trim() === '') {
        return false;
      }

      const addedLines = change.text.split('\n').length - 1;
      const removedLines = change.range.end.line - change.range.start.line;
      return addedLines - removedLines > 0;
    });
  }

  private isWhitespaceOnlyRange(
    change: vscode.TextDocumentContentChangeEvent,
    previousLines: readonly string[]
  ): boolean {
    if (change.range.isEmpty) {
      return true;
    }

    const startLine = change.range.start.line;
    const endLine = change.range.end.line;
    if (startLine === endLine) {
      const line = previousLines[startLine] ?? '';
      return line
        .slice(change.range.start.character, change.range.end.character)
        .trim() === '';
    }

    const selectedParts: string[] = [];
    for (let line = startLine; line <= endLine; line++) {
      const text = previousLines[line] ?? '';
      if (line === startLine) {
        selectedParts.push(text.slice(change.range.start.character));
      } else if (line === endLine) {
        selectedParts.push(text.slice(0, change.range.end.character));
      } else {
        selectedParts.push(text);
      }
    }

    return selectedParts.join('\n').trim() === '';
  }

  private isWholeLineReplacement(
    change: vscode.TextDocumentContentChangeEvent,
    previousLines: readonly string[]
  ): boolean {
    if (change.range.isEmpty || change.range.start.line !== change.range.end.line) {
      return false;
    }

    const previousLine = previousLines[change.range.start.line] ?? '';
    return (
      change.range.start.character === 0 &&
      change.range.end.character >= previousLine.length &&
      previousLine.trim() !== ''
    );
  }

  private addToPendingInsertBatch(
    documentKey: string,
    document: vscode.TextDocument,
    changes: readonly vscode.TextDocumentContentChangeEvent[],
    previousDocumentText: string,
    internalSourceTexts: readonly string[],
    netNonEmptyLineDelta: number
  ): void {
    const existing = this.pendingInsertBatches.get(documentKey);
    if (existing !== undefined) {
      if (existing.timeout !== undefined) {
        clearTimeout(existing.timeout);
      }
      if (existing.expireTimeout !== undefined) {
        clearTimeout(existing.expireTimeout);
        existing.expireTimeout = undefined;
      }
    }

    const batch = existing ?? {
      document,
      previousDocumentText,
      internalSourceTexts,
      insertedTexts: [],
      ranges: [],
      netNonEmptyLineDelta: 0,
      emittedTypingDelta: 0,
    };

    batch.insertedTexts.push(
      ...changes
        .map((change) => change.text)
        .filter((text) => text.trim() !== '')
    );
    batch.ranges.push(...this.createTrackedRanges(changes));
    batch.netNonEmptyLineDelta += netNonEmptyLineDelta;
    batch.timeout = setTimeout(
      () => this.flushPendingInsertBatchAsTyping(documentKey, true),
      AGENT_INSERT_BATCH_DELAY_MS
    );

    this.pendingInsertBatches.set(documentKey, batch);
    this.tryEmitPendingInsertBatch(documentKey);
  }

  private tryEmitPendingInsertBatch(documentKey: string): void {
    const batch = this.pendingInsertBatches.get(documentKey);
    if (batch === undefined) {
      return;
    }

    const classification = classifyInsertedTexts(
      batch.insertedTexts,
      batch.document,
      batch.previousDocumentText,
      batch.internalSourceTexts
    );
    if (classification === null) {
      return;
    }

    if (batch.timeout !== undefined) {
      clearTimeout(batch.timeout);
    }
    if (batch.expireTimeout !== undefined) {
      clearTimeout(batch.expireTimeout);
    }
    this.pendingInsertBatches.delete(documentKey);

    if (batch.emittedTypingDelta !== 0) {
      setImmediate(() => this.onTypingDetected(-batch.emittedTypingDelta));
    }

    const event: BehavioralEvent = {
      eventId: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      sessionId: this.sessionId,
      occurredAt: new Date().toISOString(),
      eventType: 'PASTE',
      lineCount: classification.lineCount,
      isInternal: classification.isInternal,
      isUndone: false,
      modificationDepth: 0.0,
    };

    if (event.isInternal) {
      console.log(`Bounded: internal insert ignored - lines: ${event.lineCount}`);
      return;
    }

    this.trackInsertedEvent(event, batch.ranges);
  }

  private flushPendingInsertBatchAsTyping(
    documentKey: string,
    retainForReclassification: boolean
  ): void {
    const batch = this.pendingInsertBatches.get(documentKey);
    if (batch === undefined) {
      return;
    }

    if (batch.timeout !== undefined) {
      clearTimeout(batch.timeout);
      batch.timeout = undefined;
    }
    if (batch.netNonEmptyLineDelta !== 0) {
      const typingDelta = batch.netNonEmptyLineDelta;
      batch.emittedTypingDelta += typingDelta;
      batch.netNonEmptyLineDelta = 0;
      setImmediate(() => this.onTypingDetected(typingDelta));
    }

    if (!retainForReclassification) {
      if (batch.expireTimeout !== undefined) {
        clearTimeout(batch.expireTimeout);
      }
      this.pendingInsertBatches.delete(documentKey);
      return;
    }

    if (batch.expireTimeout !== undefined) {
      clearTimeout(batch.expireTimeout);
    }
    batch.expireTimeout = setTimeout(() => {
      this.pendingInsertBatches.delete(documentKey);
    }, AGENT_INSERT_RECLASSIFY_WINDOW_MS);
  }

  private createTrackedRanges(
    changes: readonly vscode.TextDocumentContentChangeEvent[]
  ): TrackedRange[] {
    return changes
      .filter((change) => change.text.trim() !== '')
      .map((change) => ({
        startLine: change.range.start.line,
        endLine: change.range.start.line + change.text.split('\n').length - 1,
        modifiedLines: new Set<number>(),
      }));
  }

  private trackInsertedEvent(
    event: BehavioralEvent,
    changesOrRanges: readonly vscode.TextDocumentContentChangeEvent[] | readonly TrackedRange[]
  ): void {
    const ranges =
      changesOrRanges.length > 0 && 'text' in changesOrRanges[0]
        ? this.createTrackedRanges(changesOrRanges as readonly vscode.TextDocumentContentChangeEvent[])
        : (changesOrRanges as readonly TrackedRange[]).map((range) => ({
            startLine: range.startLine,
            endLine: range.endLine,
            modifiedLines: new Set<number>(range.modifiedLines),
          }));

    this.recentPastes.push({ event, ranges });
    if (this.recentPastes.length > RECENT_PASTE_WINDOW) {
      this.recentPastes.shift();
    }
    setImmediate(() => this.onPasteDetected(event));
  }

  private adjustRangeForWhitespaceChange(
    change: vscode.TextDocumentContentChangeEvent,
    range: TrackedRange,
    lineDelta: number
  ): void {
    if (lineDelta <= 0) {
      range.endLine = Math.max(range.startLine, range.endLine + lineDelta);
      return;
    }

    const addsLineAtRangeEnd =
      change.range.isEmpty && change.range.start.line >= range.endLine;
    if (!addsLineAtRangeEnd) {
      range.endLine = Math.max(range.startLine, range.endLine + lineDelta);
    }
  }

  private isManualNonEmptyInsertOnEmptyLine(
    change: vscode.TextDocumentContentChangeEvent,
    previousLines: readonly string[]
  ): boolean {
    if (!change.range.isEmpty || change.text.trim() === '') {
      return false;
    }

    const previousLine = previousLines[change.range.start.line] ?? '';
    return previousLine.trim() === '';
  }
}
