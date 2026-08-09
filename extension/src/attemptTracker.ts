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
  /** The code is untouched, but they reasoned about it in the chat. */
  | "answered"
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

/**
 * "Same code?" the way the backend asks it (see `code_fingerprint` in
 * backend/session_store.py): trailing whitespace per line stripped, then the
 * whole thing trimmed.
 *
 * Comparing raw strings let a single blank line count as an attempt, which is
 * exactly the hint-abuse path this module exists to close — and it also sent
 * the tutor an `edit_summary` describing an edit the student never made.
 */
export function normalizeCode(code: string): string {
  return code
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n")
    .trim();
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
   *
   * `answered` is the student having reasoned in the chat since the last hint.
   * It escalates like an edit does, because a student working out a concept
   * out loud is trying - the old rule pinned them at hint 1 for talking.
   */
  evaluate(
    key: string,
    code: string,
    now: number = Date.now(),
    answered = false
  ): AttemptEvaluation {
    const previous = this.attempts.get(key);
    if (!previous) {
      return { signal: "first", escalate: true, editSummary: "", cooldownRemainingMs: 0 };
    }
    if (normalizeCode(previous.code) !== normalizeCode(code)) {
      return {
        signal: "changed",
        escalate: true,
        editSummary: summarizeEdit(previous.code, code),
        cooldownRemainingMs: 0,
      };
    }
    // Checked after the edit case on purpose: a real edit carries a diff the
    // tutor answers follow-ups against, and an answer has none to offer.
    if (answered) {
      return { signal: "answered", escalate: true, editSummary: "", cooldownRemainingMs: 0 };
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

/**
 * Phrases that mean "I have not tried", however they are padded.
 *
 * Deliberately a list and not a model call. Having the tutor judge this was
 * built and measured: it scored 7/10 against this list's 12/12, and it erred
 * in both directions - waving through students who gave up and, worse,
 * stonewalling students who had reasoned their way to the answer. A
 * misjudgement here withholds help from someone who earned it, so the
 * judgement is deterministic.
 */
const GIVE_UP = [
  "i dont know",
  "i don't know",
  "idk",
  "dunno",
  "no idea",
  "just tell me",
  "tell me the answer",
  "give me the answer",
  "show me the answer",
  "no clue",
  "i give up",
];

/**
 * Did this message engage with the problem at all?
 *
 * A guess, a wrong-but-considered idea, a question about the concept and a
 * report of what they tried all count. Only an outright give-up does not.
 * Gameable by typing nonsense, which is accepted: the gate exists to stop
 * repeated clicking on untouched code, and typing nonsense repeatedly is more
 * effort than the behaviour it guards against.
 */
export function isAttempt(message: string): boolean {
  const text = (message ?? "").toLowerCase().split(/\s+/).filter(Boolean).join(" ");
  if (!text) return false;
  return !GIVE_UP.some((phrase) => text.includes(phrase));
}
