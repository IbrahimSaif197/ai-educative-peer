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

/**
 * What to say when a student asks again with nothing new to go on.
 *
 * This card only fires when the code is untouched AND the message was a
 * give-up, so by the time the student reads it they have usually typed
 * something. It used to open with "you haven't changed anything yet", which
 * was both wrong and unhelpful: describing what they typed is now the fastest
 * way out, so that is what it leads with.
 */
export function nudgeForUnchangedCode(cooldownRemainingMs: number): string {
  const seconds = Math.max(1, Math.ceil(cooldownRemainingMs / 1000));
  return (
    "Same depth for now — I don't know what you've already tried.\n\n" +
    "Tell me what you tried, or what you expected and what happened instead: that unlocks a " +
    `deeper hint straight away. So does editing the code, or waiting ${seconds}s.`
  );
}

/**
 * Words that pad a refusal without adding anything to it.
 *
 * Stripped before the comparison below, so "I really have no idea at all"
 * still reads as the bare "no idea" it is.
 */
const GIVE_UP_PADDING = new Set([
  "i",
  "im",
  "ive",
  "really",
  "honestly",
  "truly",
  "at",
  "all",
  "just",
  "can",
  "could",
  "you",
  "please",
  "sorry",
  "have",
  "ok",
  "okay",
  "well",
]);

/**
 * Phrases that mean "I have not tried", once the padding above is stripped.
 *
 * Deliberately a list and not a model call. Having the tutor judge this was
 * built and measured: it scored 7/10 against this list's 12/12, and it erred
 * in both directions - waving through students who gave up and, worse,
 * stonewalling students who had reasoned their way to the answer. A
 * misjudgement here withholds help from someone who earned it, so the
 * judgement is deterministic.
 *
 * The list's entries were rewritten for the padding-stripped core they are
 * now matched against: "i dont know" became "dont know", "i give up" became
 * "give up", and "just tell me" widened to the bare "tell me". The matching
 * rule below changed too, from a bare substring test to requiring the
 * stripped clause to match in full.
 */
const GIVE_UP = new Set([
  "dont know",
  "idk",
  "dunno",
  "no idea",
  "no clue",
  "give up",
  "tell me",
  "tell me the answer",
  "give me the answer",
  "show me the answer",
]);

/**
 * One thought per entry: the punctuation a beginner uses to move from a
 * shrug to a guess ("dunno, maybe it needs <=").
 *
 * Apostrophes go first so "don't" and "dont" are the same word, and every
 * other symbol becomes a space so `+=` or `<=` cannot glue words together.
 */
function clausesOf(message: string): string[] {
  return (message ?? "")
    .toLowerCase()
    .replace(/['‘’]/g, "")
    .split(/[,;.!?\n]+/)
    .map((clause) => clause.replace(/[^a-z0-9]+/g, " ").trim())
    .filter(Boolean);
}

/** Is this clause a refusal and nothing else? */
function isSurrender(clause: string): boolean {
  const core = clause
    .split(" ")
    .filter((word) => !GIVE_UP_PADDING.has(word))
    .join(" ");
  return GIVE_UP.has(core);
}

/**
 * Did this message engage with the problem at all?
 *
 * A guess, a wrong-but-considered idea, a question about the concept and a
 * report of what they tried all count. Only an outright give-up does not.
 *
 * A give-up phrase has to be the *whole* of every clause, not merely present
 * somewhere in the message. Matching it as a bare substring scored a
 * beginner's most natural way of phrasing a real guess as a refusal - "i dont
 * know if range should start at 0 or 1" and "dunno, maybe it needs to be <="
 * both reasoned correctly and were both held at the same depth. That is the
 * error direction the design calls out as the worse one: it withholds help
 * from someone who earned it.
 *
 * Gameable by typing nonsense, which is accepted: the gate exists to stop
 * repeated clicking on untouched code, and typing nonsense repeatedly is more
 * effort than the behaviour it guards against.
 */
export function isAttempt(message: string): boolean {
  const clauses = clausesOf(message);
  if (clauses.length === 0) return (message ?? "").trim().length > 0;
  return !clauses.every(isSurrender);
}

/**
 * Phrases that mean "stop guiding me and give me the fix".
 *
 * Entries are written in their padding-stripped form, because that is what
 * they are matched against — exactly like `GIVE_UP` above. "just" is padding,
 * so "just fix it" arrives here as "fix it" and the entry reads that way;
 * writing "just fix it" in this set would never match anything.
 *
 * Deliberately excludes the bare "tell me", which `GIVE_UP` does contain:
 * there it is safe because it only holds the ladder, but here it would route
 * "tell me more about ranges" straight past the Socratic tutor to the answer.
 */
const ANSWER_REQUEST = new Set([
  "tell me the answer",
  "give me the answer",
  "show me the answer",
  "what is the answer",
  "whats the answer",
  "show me the solution",
  "give me the solution",
  "whats the fix",
  "fix it",
  "show me the code",
]);

/**
 * Is the student asking outright for the answer?
 *
 * True for any clause in the message, so a student who describes what they
 * tried and *then* asks for the answer still gets it — the request is the
 * signal, and burying it behind a sentence of context does not make it less
 * of one.
 *
 * Routed before the attempt gate in `handleAskFromWebview`, so these phrases
 * never reach `isAttempt`. That is why `GIVE_UP` still contains three of them
 * unchanged: they no longer get that far.
 */
export function isAnswerRequest(message: string): boolean {
  return clausesOf(message).some((clause) => {
    const core = clause
      .split(" ")
      .filter((word) => !GIVE_UP_PADDING.has(word))
      .join(" ");
    return ANSWER_REQUEST.has(core);
  });
}
