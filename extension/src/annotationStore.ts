/**
 * Every annotation EduPeer has attached to one document: scan flags, cached
 * line hints, and the state of each lens.
 *
 * Pure module — no vscode import — because the staleness rules are the part
 * worth testing and they have nothing to do with the editor. `inlineTutor` is
 * the adapter that converts to and from VS Code's own types.
 *
 * Line numbers here are 0-based, matching the editor. `LineFlag` arrives from
 * the backend 1-based, so `setFlags`/`flags` convert at that boundary and
 * nowhere else.
 */

import type { LineFlag } from "./apiClient";

/** Inclusive, 0-based. */
export interface LineSpan {
  start: number;
  end: number;
}

export interface LineHint {
  hint: string;
  concept: string;
  /** True when it came from localTutor rather than the backend. */
  local?: boolean;
}

export type LensErrorReason = "auth" | "rate-limit" | "llm" | "offline" | "unknown";

export type LensState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; hint: string }
  | { kind: "empty" }
  | { kind: "error"; reason: LensErrorReason; message: string };

const IDLE: LensState = { kind: "idle" };

/**
 * One text edit, in the shape `vscode.TextDocumentContentChangeEvent` gives
 * once its `range` and `text` have been reduced to line counts.
 */
export interface ContentChange {
  /** Inclusive 0-based first line of the replaced range. */
  startLine: number;
  /** Inclusive 0-based last line of the replaced range. */
  endLine: number;
  /** Lines in the replacement text; 1 when the text has no newline. */
  insertedLineCount: number;
}

/** How many lines the document grew (positive) or shrank (negative). */
export function lineDelta(change: ContentChange): number {
  return change.insertedLineCount - (change.endLine - change.startLine + 1);
}

interface StoredFlag extends LineSpan {
  flag: LineFlag;
}

export class AnnotationStore {
  private storedFlags: StoredFlag[] = [];
  private hints = new Map<number, LineHint>();
  private lensStates = new Map<number, LensState>();
  private rev = 0;

  /**
   * Bumped whenever an edit or a dismissal invalidates what a caller captured.
   *
   * A line hint takes seconds to come back, and the line number it was asked
   * about is captured before the first await. Anything that shifts or drops
   * entries in the meantime makes that number a lie, so callers snapshot this
   * before awaiting and drop their answer if it moved.
   */
  get revision(): number {
    return this.rev;
  }

  /** Replace the flag set wholesale, as a fresh scan does. */
  setFlags(flags: LineFlag[]): void {
    this.storedFlags = flags.map((flag) => ({
      // The backend is 1-based; everything below this line is 0-based.
      start: Math.max(0, flag.line - 1),
      end: Math.max(0, Math.max(flag.line, flag.end_line) - 1),
      flag,
    }));
  }

  /** The one place a stored span becomes wire-shaped, 1-based line numbers. */
  private toWireFlag(stored: StoredFlag): LineFlag {
    return { ...stored.flag, line: stored.start + 1, end_line: stored.end + 1 };
  }

  /** Flags in wire form, with their current (possibly shifted) line numbers. */
  flags(): LineFlag[] {
    return this.storedFlags.map((s) => this.toWireFlag(s));
  }

  setHint(line: number, hint: LineHint): void {
    this.hints.set(line, hint);
  }

  setLensState(line: number, state: LensState): void {
    if (state.kind === "idle") {
      this.lensStates.delete(line);
      return;
    }
    this.lensStates.set(line, state);
  }

  lensStateAt(line: number): LensState {
    return this.lensStates.get(line) ?? IDLE;
  }

  /**
   * Lines carrying a state other than idle, ascending.
   *
   * The lens provider needs these: Ctrl+Alt+H works on any line, so a line the
   * student nudged must be able to show its own state even when it is neither
   * a definition nor a flagged line.
   */
  activeLensLines(): number[] {
    return [...this.lensStates.keys()].sort((a, b) => a - b);
  }

  /** Forget everything EduPeer said about one line: the student dismissed it. */
  clearLine(line: number): void {
    this.rev++;
    this.hints.delete(line);
    this.lensStates.delete(line);
  }

  /**
   * Forget a cached hint without invalidating anything in flight.
   *
   * Distinct from `clearLine`: this is the tutor deciding it has nothing to
   * say about the line, not the student throwing away what it said. Nothing a
   * caller captured before its own await has been made stale by it.
   */
  clearHint(line: number): void {
    this.hints.delete(line);
  }

  annotationsAt(line: number): { flag?: LineFlag; hint?: LineHint } {
    const stored = this.storedFlags.find((f) => line >= f.start && line <= f.end);
    return {
      flag: stored ? this.toWireFlag(stored) : undefined,
      hint: this.hints.get(line),
    };
  }

  /**
   * Age every annotation against a batch of edits.
   *
   * An edit that touches an annotation's own lines destroys it: the student
   * changed the thing we commented on, so the comment is void. An edit
   * entirely above it slides it down or up. An edit below it changes nothing.
   *
   * Every change is measured against pre-edit coordinates and the deltas are
   * summed, so the result does not depend on the order VS Code hands them
   * over — it delivers them in reverse document order, which would otherwise
   * have to be reasoned about at every call site.
   */
  applyChanges(changes: readonly ContentChange[]): void {
    if (changes.length === 0) return;
    this.rev++;

    const intersects = (span: LineSpan) =>
      changes.some((c) => c.startLine <= span.end && c.endLine >= span.start);

    const shiftFor = (span: LineSpan) =>
      changes
        .filter((c) => c.endLine < span.start)
        .reduce((total, c) => total + lineDelta(c), 0);

    this.storedFlags = this.storedFlags
      .filter((f) => !intersects(f))
      .map((f) => {
        const delta = shiftFor(f);
        return { ...f, start: f.start + delta, end: f.end + delta };
      });

    this.hints = this.remapByLine(this.hints, intersects, shiftFor);
    this.lensStates = this.remapByLine(this.lensStates, intersects, shiftFor);
  }

  private remapByLine<T>(
    source: Map<number, T>,
    intersects: (span: LineSpan) => boolean,
    shiftFor: (span: LineSpan) => number
  ): Map<number, T> {
    const next = new Map<number, T>();
    for (const [line, value] of source) {
      const span: LineSpan = { start: line, end: line };
      if (intersects(span)) continue;
      next.set(line + shiftFor(span), value);
    }
    return next;
  }
}
