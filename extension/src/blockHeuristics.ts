/**
 * Finding the block of code around the cursor without asking the editor.
 *
 * `focusScope` prefers a real document symbol provider, but a student who has
 * not installed a language extension does not have one — and that student is
 * exactly the beginner this product is for. So this path is the tested default
 * rather than an afterthought.
 *
 * Pure module: raw lines in, a span out.
 */

import type { LineSpan } from "./annotationStore";
import { SUPPORTED_LANGUAGES } from "./languages";

/** No focus block may exceed this; past it the "focus" stops meaning anything. */
export const MAX_FOCUS_LINES = 200;

export type BlockStyle = "indent" | "brace" | "statement";

const STYLES: Record<string, BlockStyle> = {
  python: "indent",
  sql: "statement",
  javascript: "brace",
  typescript: "brace",
  java: "brace",
  c: "brace",
  cpp: "brace",
  csharp: "brace",
  go: "brace",
  rust: "brace",
};

export function blockStyleFor(languageId: string): BlockStyle {
  return STYLES[languageId] ?? "brace";
}

/** Leading whitespace width, with tabs counted as four columns. */
function indentOf(line: string): number {
  const expanded = line.replace(/\t/g, "    ");
  return expanded.length - expanded.trimStart().length;
}

function clamp(span: LineSpan): LineSpan {
  if (span.end - span.start + 1 <= MAX_FOCUS_LINES) return span;
  return { start: span.start, end: span.start + MAX_FOCUS_LINES - 1 };
}

/**
 * The block containing `cursorLine`, or null when there isn't one — a
 * top-level statement, an unsupported language, a cursor past the end.
 * Returning null rather than guessing lets the caller fall back to a plain
 * line window, which is honest about knowing less.
 */
export function findEnclosingBlock(
  lines: string[],
  cursorLine: number,
  languageId: string
): LineSpan | null {
  if (cursorLine < 0 || cursorLine >= lines.length) return null;
  const language = SUPPORTED_LANGUAGES[languageId];
  if (!language) return null;

  const style = blockStyleFor(languageId);
  if (style === "statement") return clamp(sqlStatement(lines, cursorLine));

  const header = findHeader(lines, cursorLine, language.lensRegex);
  if (header === null) return null;

  const span =
    style === "indent"
      ? { start: header, end: indentBlockEnd(lines, header) }
      : { start: header, end: braceBlockEnd(lines, header) };

  // A header above the cursor whose block already closed is not enclosing it:
  // `area(2);` after `function area(r) { … }` is top-level code, not the body.
  if (cursorLine < span.start || cursorLine > span.end) return null;

  return clamp(span);
}

/**
 * The nearest definition line at or above the cursor. A header further
 * indented than the cursor belongs to a sibling block that has already
 * closed, so it is skipped.
 */
function findHeader(lines: string[], cursorLine: number, lensRegex: RegExp): number | null {
  const cursorIndent = indentOf(lines[cursorLine]);
  for (let i = cursorLine; i >= 0; i--) {
    if (!lensRegex.test(lines[i])) continue;
    if (i === cursorLine) return i;
    if (indentOf(lines[i]) < cursorIndent || indentOf(lines[i]) === 0) return i;
  }
  return null;
}

/** Last line still indented under `header`, trailing blank lines excluded. */
function indentBlockEnd(lines: string[], header: number): number {
  const base = indentOf(lines[header]);
  let end = header;
  for (let i = header + 1; i < lines.length; i++) {
    const text = lines[i];
    if (!text.trim()) continue; // a blank line does not end a block
    if (indentOf(text) <= base) break;
    end = i;
  }
  return end;
}

/**
 * Last line of the braced body opened at or just after `header`.
 *
 * Deliberately naive: braces inside strings and comments are counted. A
 * heuristic that is right on ordinary student code and occasionally long is
 * the correct trade against carrying a parser per language.
 */
function braceBlockEnd(lines: string[], header: number): number {
  let depth = 0;
  let opened = false;
  for (let i = header; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === "{") {
        depth++;
        opened = true;
      } else if (ch === "}") {
        depth--;
      }
    }
    if (opened && depth <= 0) return i;
    // A header with no brace within three lines is a declaration, not a body.
    if (!opened && i - header >= 3) return header;
  }
  return opened ? lines.length - 1 : header;
}

/** From just after the previous `;` to the next one, inclusive. */
function sqlStatement(lines: string[], cursorLine: number): LineSpan {
  let start = cursorLine;
  while (start > 0 && !lines[start - 1].includes(";")) start--;
  while (start < cursorLine && !lines[start].trim()) start++;

  let end = cursorLine;
  while (end < lines.length - 1 && !lines[end].includes(";")) end++;

  return { start, end };
}
