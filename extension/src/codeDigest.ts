/**
 * What leaves the machine, and nothing else.
 *
 * The tutor needs the student's imports and the block they are working on. It
 * does not need the other four hundred lines, and until this module existed
 * every request carried them: six call sites posted `doc.getText()`.
 *
 * A digest is a handful of line ranges lifted out of the file, plus the
 * absolute line numbers they came from. The numbers are the whole point —
 * `hinting_engine` cites real editor lines back to the student, and a digest
 * renumbered from 1 sends them to code that has nothing to do with the hint.
 *
 * Pure module: raw lines in, a digest out. Line numbers arrive 0-based, the
 * way the editor counts, and leave 1-based, the way the wire counts. That
 * conversion happens here and in `annotationStore`, nowhere else.
 */

import type { LineSpan } from "./annotationStore";
import { SUPPORTED_LANGUAGES } from "./languages";

/** Total lines a digest may carry. Matches `MAX_CODE_LINES_SENT` server-side. */
export const MAX_DIGEST_LINES = 120;

/** Lines kept either side of the focus block: a decorator, or the comment above it. */
export const FOCUS_MARGIN_LINES = 3;

/** Header lines kept, at most. Past this it is not a header, it is the file. */
export const HEADER_BAND_MAX_LINES = 30;

/** Definition lines kept, at most, nearest the block first. */
export const SIGNATURE_BAND_MAX_LINES = 20;

/** Enclosing headers kept: the class, its class, and one more. */
export const SCOPE_BAND_MAX_LINES = 3;

/** 1-based, absolute, inclusive — the coordinates the backend numbers in. */
export interface CodeBand {
  start: number;
  end: number;
}

export interface CodeDigest {
  /** The selected lines, joined. Never the whole file. */
  code: string;
  /** Which absolute lines `code` came from, ascending and disjoint. */
  bands: CodeBand[];
  /** Lines in the real file, so an elision can say how much is missing. */
  totalLines: number;
}

/** Ascending contiguous runs over a set of 1-based line numbers. */
export function toBands(lineNumbers: Iterable<number>): CodeBand[] {
  const sorted = [...new Set(lineNumbers)].sort((a, b) => a - b);
  const bands: CodeBand[] = [];
  for (const n of sorted) {
    const last = bands[bands.length - 1];
    if (last && n === last.end + 1) {
      last.end = n;
      continue;
    }
    bands.push({ start: n, end: n });
  }
  return bands;
}

export function bandLineCount(bands: CodeBand[]): number {
  return bands.reduce((total, b) => total + (b.end - b.start + 1), 0);
}

/**
 * Add 1-based lines `from`..`to` to `chosen`, stopping at the budget.
 *
 * Chosen lines are collected as a set rather than as bands so that overlapping
 * bands — a focus block inside its own enclosing class, an import line that is
 * also a signature — cost one line, not two, and the budget arithmetic cannot
 * drift from what is actually sent.
 */
function take(
  chosen: Set<number>,
  from: number,
  to: number,
  totalLines: number,
  budget: number
): void {
  const first = Math.max(1, from);
  const last = Math.min(totalLines, to);
  for (let n = first; n <= last; n++) {
    if (chosen.size >= budget && !chosen.has(n)) return;
    chosen.add(n);
  }
}

/**
 * The file's header: imports, includes, and the module-level constants under
 * them, up to the first line that is neither.
 *
 * Comments continue the header but do not extend it — a file whose imports
 * are followed by forty lines of comment should not spend its header budget
 * on the comment. Blank lines are similar, but only until the first constant
 * is claimed: imports are often broken into groups by a blank line, so one
 * should not end the header early. Once a constant has been taken, though, a
 * blank line is the signal that the constants block is over and the file's
 * ordinary body begins — without that signal, `TAX = 0.2` and the forty
 * unrelated assignments that happen to follow it are shaped identically to
 * the scanner, and the header would swallow the whole file one plausible
 * line at a time.
 */
function headerEnd(lines: string[], languageId: string): number {
  const language = SUPPORTED_LANGUAGES[languageId];
  if (!language) return 0;
  let last = 0;
  let sawImport = false;
  let constantTaken = false;
  const limit = Math.min(lines.length, HEADER_BAND_MAX_LINES);
  for (let i = 0; i < limit; i++) {
    const text = lines[i];
    if (!text.trim()) {
      if (constantTaken) break;
      continue;
    }
    if (text.trim().startsWith(language.lineComment)) continue;
    if (language.importRegex.test(text)) {
      last = i + 1; // 1-based
      sawImport = true;
      continue;
    }
    // A module-level constant under the imports is context worth having;
    // anything indented, or any definition, means the header is over.
    if (sawImport && !language.lensRegex.test(text) && !/^\s/.test(text)) {
      last = i + 1;
      constantTaken = true;
      continue;
    }
    break;
  }
  return last;
}

/** Leading whitespace width, tabs counted as four columns. Mirrors blockHeuristics. */
function indentOf(line: string): number {
  const expanded = line.replace(/\t/g, "    ");
  return expanded.length - expanded.trimStart().length;
}

/**
 * The headers of the blocks the focus sits inside, outermost last.
 *
 * Walked by decreasing indentation rather than by parsing: a line above the
 * block, matching the language's definition pattern, and indented less than
 * anything already collected, is enclosing it. Good enough for a `class` in
 * Python and an outer `class`/`impl` in the brace languages, which is what
 * this band is for.
 */
function scopeHeaderLines(
  lines: string[],
  languageId: string,
  focusStart: number
): number[] {
  const language = SUPPORTED_LANGUAGES[languageId];
  if (!language) return [];
  const found: number[] = [];
  let minIndent = indentOf(lines[focusStart] ?? "");
  for (let i = focusStart - 1; i >= 0 && found.length < SCOPE_BAND_MAX_LINES; i--) {
    const text = lines[i];
    if (!text.trim()) continue;
    const indent = indentOf(text);
    if (indent >= minIndent) continue;
    minIndent = indent;
    if (language.lensRegex.test(text)) found.push(i + 1); // 1-based
    if (indent === 0) break;
  }
  return found;
}

/**
 * Definition lines, nearest the block first.
 *
 * Indentation is not filtered on: a Java or C# method lives inside its class
 * and would be missed by a top-level-only rule, and those are exactly the
 * signatures worth having. The focus block's own header is skipped: its full
 * body already ships in the focus band, so counting it here would spend one
 * of the twenty slots on a line the digest sends anyway.
 */
function signatureLines(
  lines: string[],
  languageId: string,
  focusStart: number
): number[] {
  const language = SUPPORTED_LANGUAGES[languageId];
  if (!language) return [];
  const all: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (i === focusStart) continue;
    if (language.lensRegex.test(lines[i])) all.push(i + 1);
  }
  return all
    .sort((a, b) => Math.abs(a - focusStart - 1) - Math.abs(b - focusStart - 1))
    .slice(0, SIGNATURE_BAND_MAX_LINES);
}

export function buildDigest(
  lines: string[],
  languageId: string,
  focus: LineSpan
): CodeDigest {
  const totalLines = lines.length;
  if (totalLines === 0) return { code: "", bands: [], totalLines: 0 };

  const chosen = new Set<number>();
  // 0-based focus in, 1-based out.
  take(
    chosen,
    focus.start + 1 - FOCUS_MARGIN_LINES,
    focus.end + 1 + FOCUS_MARGIN_LINES,
    totalLines,
    MAX_DIGEST_LINES
  );
  take(chosen, 1, headerEnd(lines, languageId), totalLines, MAX_DIGEST_LINES);
  for (const n of scopeHeaderLines(lines, languageId, focus.start)) {
    take(chosen, n, n, totalLines, MAX_DIGEST_LINES);
  }
  for (const n of signatureLines(lines, languageId, focus.start)) {
    take(chosen, n, n, totalLines, MAX_DIGEST_LINES);
  }

  const bands = toBands(chosen);
  const code = bands
    .flatMap((b) => lines.slice(b.start - 1, b.end))
    .join("\n");
  return { code, bands, totalLines };
}
