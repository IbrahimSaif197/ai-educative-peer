/**
 * Pure helpers for the pedagogy loop: explain-first gating, tutor modes and
 * the canned questions each mode sends when the student just clicks a button.
 */

export type TutorMode =
  | "hint"
  | "reflect"
  | "translate"
  | "worked-example"
  | "explain-error"
  | "explain-concept"
  | "predict-output"
  | "review-exercise"
  | "subgoal-label"
  | "trace-check"
  | "answer";

/**
 * The top of the hint ladder. Rungs 1-3 are the Socratic ladder; rung 4 *is*
 * the worked example, reached by asking again at rung 3.
 *
 * The counterpart of `MAX_HINT_LEVEL` in `backend/models.py`. Two languages
 * cannot share one declaration, so the pair is kept in step by hand: change
 * one and change the other. Everything client-side that renders or clamps a
 * depth reads this rather than a literal — a bare `3` in the status bar is
 * what left it saying "hint 3/3" beside a panel showing four filled rungs.
 */
export const MAX_HINT_LEVEL = 4;

export const EXPLAIN_FIRST_PROMPT =
  "Before I give you a hint — in your own words, what do you think this code is doing? " +
  "Explaining first helps it stick. (You can skip this.)";

export const DEFAULT_MODE_QUESTIONS: Partial<Record<TutorMode, string>> = {
  reflect: "I think I fixed it. Quiz me on why the fix works.",
  "worked-example":
    "I'm still stuck. Please show me a worked example of this concept on a different problem.",
};

/** Cheap stable fingerprint used to decide "have we seen this code before?". */
export function codeFingerprint(code: string): string {
  let h = 0;
  for (let i = 0; i < code.length; i++) {
    h = (h * 31 + code.charCodeAt(i)) | 0;
  }
  return `${code.length}:${h}`;
}

export function frameExplainedQuestion(explanation: string, question: string): string {
  return `My understanding of the code: ${explanation.trim()}\n\nMy question: ${question.trim()}`;
}

export function frameTranslation(translation: string): string {
  return `Here is my translation of your pseudocode:\n\n${translation.trim()}`;
}

const ERROR_TEXT_PATTERNS: RegExp[] = [
  /Traceback \(most recent call last\)/,
  /^\s*File ".+", line \d+/m,
  /^\s+at .+ \(.+:\d+:\d+\)/m,
  /^\s+at .+\(.+\.java:\d+\)/m,
  /Exception in thread/,
  /Segmentation fault/i,
  /^[\w./\\-]+:\d+(:\d+)?:\s*(fatal )?error[: ]/im,
  /error [A-Z]+\d+:/,
  /\b\w+(Error|Exception):/,
];

/** Heuristic: does this pasted text look like an error message or stack trace? */
export function looksLikeErrorText(text: string): boolean {
  return ERROR_TEXT_PATTERNS.some((re) => re.test(text));
}

export function framePrediction(snippet: string, prediction: string): string {
  return (
    `Here is the code I am predicting the behaviour of:\n\n${snippet.trim()}\n\n` +
    `My prediction: ${prediction.trim()}`
  );
}

export function frameConstructExplanation(selection: string): string {
  return `Please explain what this construct does:\n\n${selection.trim()}`;
}

/**
 * A student's answer to a spaced-review exercise, marked against the exercise
 * rather than whatever file happens to be open.
 *
 * The review prompt asks them to "write the code themselves and predict its
 * behaviour", so without this their answer was submitted as a brand-new
 * Socratic question about an unrelated file — a dead end at the exact moment
 * retrieval practice was supposed to happen.
 */
export function frameReviewAnswer(exercise: string, answer: string): string {
  return (
    `Here is the review exercise you set me:\n\n${exercise.trim()}\n\n` +
    `My answer:\n\n${answer.trim()}\n\n` +
    `Where does my answer fall short?`
  );
}

/**
 * Turn a filled-in desk-check grid into a compact text table for the tutor.
 * `rows[step][variable]` holds whatever the student typed; blanks become "?"
 * so the model can see which cells they could not work out.
 */
export function frameTraceTable(
  snippet: string,
  variables: string[],
  rows: string[][]
): string {
  const header = ["step", ...variables].join(" | ");
  const body = rows
    .map((row, index) =>
      [
        String(index + 1),
        ...variables.map((_, column) => (row?.[column] ?? "").trim() || "?"),
      ].join(" | ")
    )
    .join("\n");
  return (
    `Here is my hand-trace of this code:\n\n${snippet.trim()}\n\n` +
    `${header}\n${body}\n\n` +
    `Where does my trace go wrong?`
  );
}

export function frameSubgoalLabels(labels: string): string {
  return (
    `Here is what I think each step of your example accomplishes:\n\n${labels.trim()}`
  );
}

export function formatExceptionQuestion(
  description: string,
  frameName: string,
  location: string,
  variables: Array<{ name: string; value: string }>
): string {
  const vars = variables
    .slice(0, 15)
    .map((v) => `  ${v.name} = ${v.value}`)
    .join("\n");
  return (
    `My program stopped on an exception: ${description}\n` +
    `It stopped in ${frameName} (${location}).\n` +
    (vars ? `Variables in scope at that moment:\n${vars}\n` : "") +
    `Help me understand what this exception means and how to read it.`
  );
}

export function formatTestFailureQuestion(testLabel: string, message: string): string {
  return (
    `My test "${testLabel}" failed with:\n\n${message.trim()}\n\n` +
    `Help me work out why my code doesn't satisfy it.`
  );
}

/** Fill in the canned question for button-triggered modes. */
export function questionForMode(mode: TutorMode, rawInput: string): string {
  const input = (rawInput || "").trim();
  if (mode === "translate") {
    return input ? frameTranslation(input) : "";
  }
  if (mode === "subgoal-label") {
    return input ? frameSubgoalLabels(input) : "";
  }
  if (!input) {
    return DEFAULT_MODE_QUESTIONS[mode] ?? "";
  }
  return input;
}
