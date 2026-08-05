/**
 * Tracks whether the student actually attempted anything between hints.
 *
 * Without this, pressing "Ask" three times on untouched code walks straight to
 * a level-3 pseudocode hint — the classic hint-abuse path. The tracker also
 * produces a compact diff of what did change, which the tutor uses to answer
 * follow-ups like "I tried that and it still fails" against the real edit.
 *
 * Pure module: no vscode imports, so it is unit-testable on its own.
 */

/** How long an unchanged ask is held at the same hint level. */
export const HINT_COOLDOWN_MS = 45_000;

/** Mirrors MAX_EDIT_SUMMARY_CHARS in backend/models.py. */
export const MAX_EDIT_SUMMARY_CHARS = 2000;

const MAX_LINE_CHARS = 120;
const DEFAULT_MAX_DIFF_LINES = 8;

export type AttemptSignal =
  /** No hint has been given for this file yet. */
  | "first"
  /** The student edited the code since the last hint. */
  | "changed"
  /** Nothing changed, but they have been sitting with it a while. */
  | "stalled"
  /** Nothing changed and they asked again immediately. */
  | "unchanged";

export interface AttemptEvaluation {
  signal: AttemptSignal;
  /** Whether the hint level should advance. */
  escalate: boolean;
  /** Diff of what changed since the last hint; "" when nothing did. */
  editSummary: string;
  /** Time left on the cooldown, 0 unless the signal is "unchanged". */
  cooldownRemainingMs: number;
}

function clip(text: string): string {
  const trimmed = text.trimEnd();
  return trimmed.length > MAX_LINE_CHARS
    ? `${trimmed.slice(0, MAX_LINE_CHARS)}…`
    : trimmed;
}

/**
 * A line-level diff of `before` → `after`, rendered as numbered `-`/`+` lines.
 *
 * Deliberately naive — common-prefix/suffix trim, then the changed span. The
 * model only needs to know roughly what moved, and a real diff algorithm would
 * be dependency weight for no pedagogical gain.
 */
export function summarizeEdit(
  before: string,
  after: string,
  maxLines = DEFAULT_MAX_DIFF_LINES
): string {
  if (before === after) return "";

  // An empty document is zero lines, not one blank one — otherwise creating a
  // file from scratch reports a phantom "1 - " deletion.
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    start++;
  }

  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }

  const entries: string[] = [];
  for (let i = start; i <= endA; i++) {
    entries.push(`${i + 1} - ${clip(a[i])}`);
  }
  for (let i = start; i <= endB; i++) {
    entries.push(`${i + 1} + ${clip(b[i])}`);
  }
  if (entries.length === 0) return "";

  const shown =
    entries.length <= maxLines
      ? entries
      : [
          ...entries.slice(0, maxLines),
          `… and ${entries.length - maxLines} more changed line(s)`,
        ];
  return shown.join("\n").slice(0, MAX_EDIT_SUMMARY_CHARS);
}

interface Attempt {
  code: string;
  at: number;
}

export class AttemptTracker {
  private readonly attempts = new Map<string, Attempt>();

  constructor(private readonly cooldownMs: number = HINT_COOLDOWN_MS) {}

  /**
   * Decide how to treat the next hint request for `key` (one document).
   * Read-only: call `record` once the hint is actually delivered.
   */
  evaluate(key: string, code: string, now: number = Date.now()): AttemptEvaluation {
    const previous = this.attempts.get(key);
    if (!previous) {
      return { signal: "first", escalate: true, editSummary: "", cooldownRemainingMs: 0 };
    }
    if (previous.code !== code) {
      return {
        signal: "changed",
        escalate: true,
        editSummary: summarizeEdit(previous.code, code),
        cooldownRemainingMs: 0,
      };
    }
    const elapsed = now - previous.at;
    if (elapsed < this.cooldownMs) {
      return {
        signal: "unchanged",
        escalate: false,
        editSummary: "",
        cooldownRemainingMs: this.cooldownMs - elapsed,
      };
    }
    return { signal: "stalled", escalate: true, editSummary: "", cooldownRemainingMs: 0 };
  }

  /** Remember the code a hint was given against. */
  record(key: string, code: string, now: number = Date.now()): void {
    this.attempts.set(key, { code, at: now });
  }

  /** Forget one document, or everything when no key is given. */
  clear(key?: string): void {
    if (key === undefined) {
      this.attempts.clear();
    } else {
      this.attempts.delete(key);
    }
  }
}

/** What to say when a student asks again without touching anything. */
export function nudgeForUnchangedCode(cooldownRemainingMs: number): string {
  const seconds = Math.max(1, Math.ceil(cooldownRemainingMs / 1000));
  return (
    "You haven't changed anything yet — so here's the same level of hint again.\n\n" +
    "Tell me what you tried, or what you expected to happen and what happened instead. " +
    `Editing the code (or waiting ${seconds}s) unlocks a deeper hint.`
  );
}
