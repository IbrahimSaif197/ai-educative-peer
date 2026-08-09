/**
 * Finding the seeded `bug:` marker comments in a file.
 *
 * The demos ship deliberate bugs with a comment naming each one. Once the file
 * scans clean those comments describe a bug the student has already fixed, so
 * EduPeer strips them.
 *
 * Deliberately narrow, because this deletes from the student's own file: only a
 * comment whose body *starts* with `bug:` counts. `// Off-by-one style bug:
 * index 4 does not exist` is prose about a bug, not a marker, and survives.
 *
 * Pure module: raw lines in, spans out.
 */

import { SUPPORTED_LANGUAGES, LanguageInfo } from "./languages";

export interface BugMarker {
  /** 0-based line. */
  line: number;
  /** First character to delete, including the whitespace before the comment. */
  start: number;
  /** One past the last character to delete. */
  end: number;
  /** The comment is the whole line, so the line itself should go. */
  wholeLine: boolean;
}

/** A comment body that opens with `bug:`, however it is spaced or cased. */
const MARKER = /^\s*bug\s*:/i;

/**
 * Index of `token` in `line` while outside any string literal, or -1.
 *
 * Without this, `print("# bug: not a comment")` would lose half its string.
 * Python's triple quotes are not modelled — a marker inside a one-line
 * docstring is not a case worth the parser.
 */
function indexOutsideStrings(line: string, token: string, from = 0): number {
  let quote: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (i >= from && line.startsWith(token, i)) return i;
  }
  return -1;
}

/** Where the deletion starts: after the code, before the comment's whitespace. */
function spanStart(line: string, tokenIndex: number): number {
  return line.slice(0, tokenIndex).trimEnd().length;
}

function markerOn(line: string, language: LanguageInfo): Omit<BugMarker, "line"> | undefined {
  if (language.blockComment) {
    const [open, close] = language.blockComment;
    const openIndex = indexOutsideStrings(line, open);
    if (openIndex !== -1) {
      const closeIndex = line.indexOf(close, openIndex + open.length);
      if (closeIndex !== -1) {
        const body = line.slice(openIndex + open.length, closeIndex);
        if (MARKER.test(body)) {
          const end = closeIndex + close.length;
          return {
            start: spanStart(line, openIndex),
            end,
            wholeLine:
              line.slice(0, openIndex).trim() === "" && line.slice(end).trim() === "",
          };
        }
      }
    }
  }

  const tokenIndex = indexOutsideStrings(line, language.lineComment);
  if (tokenIndex === -1) return undefined;
  const body = line.slice(tokenIndex + language.lineComment.length);
  if (!MARKER.test(body)) return undefined;
  return {
    start: spanStart(line, tokenIndex),
    end: line.length,
    wholeLine: line.slice(0, tokenIndex).trim() === "",
  };
}

/** Every `bug:` marker in the file, in document order. */
export function findBugMarkers(lines: string[], languageId: string): BugMarker[] {
  const language = SUPPORTED_LANGUAGES[languageId];
  if (!language) return [];
  const markers: BugMarker[] = [];
  for (let i = 0; i < lines.length; i++) {
    const found = markerOn(lines[i], language);
    if (found) markers.push({ ...found, line: i });
  }
  return markers;
}
