/**
 * A rule-based Socratic tutor that runs entirely in the extension.
 *
 * When the backend is unreachable EduPeer used to go completely silent. These
 * rules keep it teaching — never as well as the model, but a real question
 * beats a dead panel, and a demo without wifi still works.
 *
 * Every rule is a pattern over one line plus a question that points at the
 * concept without giving the fix, matching the tone of the LLM prompts.
 * Pure module: no vscode imports.
 */

export interface LocalRule {
  /** Matches the line the student is on. */
  pattern: RegExp;
  /** A Socratic question, kept under ~14 words like the LLM line hints. */
  question: string;
  concept: string;
}

/** Rules that hold in every language EduPeer tutors. */
const SHARED_RULES: LocalRule[] = [
  {
    pattern: /\bwhile\s*\(?\s*(true|True|1)\s*\)?/,
    question: "What inside this loop will ever make it stop?",
    concept: "while-loop",
  },
  {
    pattern: /==\s*(null|None|nil|undefined)\b/,
    question: "Is comparing to nothing the same as having nothing?",
    concept: "comparison",
  },
  {
    pattern: /\[\s*-?\d+\s*\]/,
    question: "Is that index inside the range this holds?",
    concept: "indexing",
  },
  {
    pattern: /\bTODO\b|\bFIXME\b/,
    question: "What is still missing here, in your own words?",
    concept: "general",
  },
  {
    pattern: /\breturn\s*$/,
    question: "What should this hand back to whoever called it?",
    concept: "return-value",
  },
];

const LANGUAGE_RULES: Record<string, LocalRule[]> = {
  python: [
    {
      pattern: /\bif\s+[A-Za-z_]\w*\s*=\s*[^=]/,
      question: "Is that comparing two values, or assigning one?",
      concept: "comparison",
    },
    {
      pattern: /\bdef\s+\w+\s*\([^)]*=\s*(\[\]|\{\})/,
      question: "What happens to that default the second time you call this?",
      concept: "mutability",
    },
    {
      pattern: /\brange\s*\(\s*len\s*\(/,
      question: "Do you need the positions, or the items themselves?",
      concept: "iterators",
    },
    {
      pattern: /\bfor\b.*\brange\s*\([^,)]*\)\s*:/,
      question: "Which values does range include, and which does it stop before?",
      concept: "off-by-one",
    },
    {
      pattern: /\bexcept\s*:/,
      question: "Which errors do you actually mean to catch here?",
      concept: "exceptions",
    },
    {
      pattern: /\bopen\s*\(/,
      question: "Where does this file get closed again?",
      concept: "file-io",
    },
    {
      pattern: /\bint\s*\(\s*input\s*\(/,
      question: "What happens if they type something that isn't a number?",
      concept: "type-error",
    },
    {
      pattern: /\+\s*(str|int)\s*\(/,
      question: "Which types are you joining, and do they match?",
      concept: "type-error",
    },
  ],
  javascript: [
    {
      pattern: /[^=!<>]==[^=]/,
      question: "What does loose equality do to the types here?",
      concept: "equality",
    },
    {
      pattern: /\bvar\s+\w+/,
      question: "What scope does var give this, compared with let?",
      concept: "let-const-var",
    },
    {
      pattern: /\.then\s*\(/,
      question: "What does this hand back before the promise settles?",
      concept: "promises",
    },
    {
      pattern: /\bawait\b/,
      question: "Is the function holding this marked async?",
      concept: "async-await",
    },
    {
      pattern: /\bfor\s*\(\s*(let|var|const)?\s*\w+\s*=\s*0\s*;[^;]*<=\s*\w+\.length/,
      question: "What is the last valid index of that array?",
      concept: "off-by-one",
    },
    {
      pattern: /\bparseInt\s*\(/,
      question: "Which base is this parsing in, and did you say so?",
      concept: "type-error",
    },
  ],
  typescript: [
    {
      pattern: /:\s*any\b/,
      question: "What do you lose when you tell it any?",
      concept: "any-vs-unknown",
    },
    {
      pattern: /[^=!<>]==[^=]/,
      question: "What does loose equality do to the types here?",
      concept: "equality",
    },
    {
      pattern: /\bas\s+\w+/,
      question: "Are you certain of that type, or hoping?",
      concept: "type-annotations",
    },
    {
      pattern: /\bawait\b/,
      question: "Is the function holding this marked async?",
      concept: "async-await",
    },
  ],
  java: [
    {
      pattern: /\bif\s*\(\s*\w+\s*==\s*"/,
      question: "Does == compare the text, or where it lives?",
      concept: "string-comparison",
    },
    {
      pattern: /\b\w+\s*\/\s*\w+/,
      question: "What happens to the remainder when both sides are ints?",
      concept: "integer-division",
    },
    {
      pattern: /\bnew\s+\w+\s*\[\s*\w+\s*\]/,
      question: "What are the first and last valid indexes of that array?",
      concept: "arrays",
    },
    {
      pattern: /\.\w+\s*\(/,
      question: "Could the thing on the left be null right now?",
      concept: "null-pointer",
    },
  ],
  csharp: [
    {
      pattern: /\bif\s*\(\s*\w+\s*==\s*"/,
      question: "Which comparison do you want for text here?",
      concept: "string-comparison",
    },
    {
      pattern: /\b\w+\s*\/\s*\w+/,
      question: "What happens to the remainder when both sides are ints?",
      concept: "integer-division",
    },
    {
      pattern: /\.\w+\s*\(/,
      question: "Could the thing on the left be null right now?",
      concept: "null-reference",
    },
  ],
  c: [
    {
      pattern: /\bmalloc\s*\(|\bcalloc\s*\(/,
      question: "Who frees this memory, and when?",
      concept: "memory-allocation",
    },
    {
      pattern: /\bscanf\s*\(/,
      question: "Did every argument here get an address?",
      concept: "printf-scanf",
    },
    {
      pattern: /\bgets\s*\(|\bstrcpy\s*\(/,
      question: "What stops this writing past the end of the buffer?",
      concept: "null-terminator",
    },
    {
      pattern: /\bchar\s+\w+\s*\[\s*\d+\s*\]/,
      question: "Is there room for the terminating zero as well?",
      concept: "null-terminator",
    },
    {
      pattern: /\*\s*\w+\s*=/,
      question: "Does that pointer definitely point somewhere valid?",
      concept: "pointers",
    },
  ],
  cpp: [
    {
      pattern: /\bnew\s+\w+/,
      question: "Where is the matching delete for this?",
      concept: "memory-allocation",
    },
    {
      pattern: /\bvector\s*<[^>]*>\s*\w+\s*;/,
      question: "How many elements does it hold right after this line?",
      concept: "vectors",
    },
    {
      pattern: /\.at\s*\(|\[\s*\w+\s*\]/,
      question: "What happens if that index is past the end?",
      concept: "vectors",
    },
    {
      pattern: /\bvoid\s+\w+\s*\([^)]*\b\w+\s+\w+\s*\)/,
      question: "Does the caller see changes made to that parameter?",
      concept: "pass-by-reference",
    },
  ],
  go: [
    {
      pattern: /:=/,
      question: "What type does Go infer for this, and is that what you want?",
      concept: "zero-values",
    },
    {
      pattern: /\berr\s*!=\s*nil/,
      question: "What should happen to the rest of the work on error?",
      concept: "error-handling",
    },
    {
      pattern: /\bgo\s+\w+\s*\(/,
      question: "What makes the caller wait for this goroutine?",
      concept: "goroutines",
    },
    {
      pattern: /\bappend\s*\(/,
      question: "Which slice ends up holding the result?",
      concept: "slices",
    },
  ],
  rust: [
    {
      pattern: /\.unwrap\s*\(\s*\)|\.expect\s*\(/,
      question: "What do you want to happen when there is no value?",
      concept: "option",
    },
    {
      pattern: /\bclone\s*\(\s*\)/,
      question: "Do you need your own copy, or just to borrow it?",
      concept: "borrowing",
    },
    {
      pattern: /&mut\s+\w+/,
      question: "How many mutable borrows are alive right here?",
      concept: "borrowing",
    },
    {
      pattern: /\blet\s+\w+\s*=/,
      question: "Does this binding need to change later?",
      concept: "mutability",
    },
  ],
  sql: [
    {
      pattern: /\bSELECT\s+\*/i,
      question: "Which columns do you actually need back?",
      concept: "select",
    },
    {
      pattern: /\bJOIN\b(?![\s\S]*\bON\b)/i,
      question: "Which columns connect these two tables?",
      concept: "joins",
    },
    {
      pattern: /=\s*NULL/i,
      question: "Does anything equal NULL, even NULL itself?",
      concept: "null-handling",
    },
    {
      pattern: /\bGROUP\s+BY\b/i,
      question: "Is every non-aggregated column in this grouping?",
      concept: "group-by",
    },
    {
      pattern: /\b(DELETE|UPDATE)\b(?![\s\S]*\bWHERE\b)/i,
      question: "How many rows does this touch without a WHERE?",
      concept: "insert-update-delete",
    },
  ],
};

/** The first rule matching this line, or undefined. */
export function matchLocalRule(line: string, languageId: string): LocalRule | undefined {
  const text = line ?? "";
  if (!text.trim()) return undefined;
  const rules = [...(LANGUAGE_RULES[languageId] ?? []), ...SHARED_RULES];
  return rules.find((rule) => rule.pattern.test(text));
}

/** A local nudge for one line, or "" when no rule fits. */
export function localLineHint(
  line: string,
  languageId: string
): { hint: string; concept: string } {
  const rule = matchLocalRule(line, languageId);
  return rule ? { hint: rule.question, concept: rule.concept } : { hint: "", concept: "general" };
}

/** How many rules a language contributes; used by tests and diagnostics. */
export function localRuleCount(languageId: string): number {
  return (LANGUAGE_RULES[languageId] ?? []).length + SHARED_RULES.length;
}

const OFFLINE_PREFIX = "EduPeer is offline, so here is a general nudge rather than a real hint.";

const OFFLINE_GENERIC = [
  "Read the failing line out loud. Which part are you least sure about?",
  "What did you expect this to produce, and what did it actually produce?",
  "Which single line would you check first if you had to guess?",
  "What is the smallest input that still shows the problem?",
];

/**
 * A whole-file offline reply for the sidebar: the best matching rule in the
 * file, or a generic metacognitive prompt when nothing matches.
 *
 * `seed` picks the generic prompt deterministically, so the same question does
 * not repeat back-to-back and tests stay predictable.
 */
export function offlineTutorReply(code: string, languageId: string, seed = 0): string {
  const lines = (code ?? "").split("\n");
  for (const line of lines) {
    const rule = matchLocalRule(line, languageId);
    if (rule) {
      return `${OFFLINE_PREFIX}\n\n${rule.question}`;
    }
  }
  const generic = OFFLINE_GENERIC[Math.abs(seed) % OFFLINE_GENERIC.length];
  return `${OFFLINE_PREFIX}\n\n${generic}`;
}
