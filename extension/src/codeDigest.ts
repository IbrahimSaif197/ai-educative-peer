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

/** Total lines a digest may carry. Matches `MAX_CODE_LINES_SENT` server-side. */
export const MAX_DIGEST_LINES = 120;

/** Lines kept either side of the focus block: a decorator, or the comment above it. */
export const FOCUS_MARGIN_LINES = 3;

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

  const bands = toBands(chosen);
  const code = bands
    .flatMap((b) => lines.slice(b.start - 1, b.end))
    .join("\n");
  return { code, bands, totalLines };
}
