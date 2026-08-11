/**
 * The one place a `TextDocument` becomes bytes bound for the wire.
 *
 * `digestFields` in `apiClient` is where a digest becomes a payload, and it
 * says itself that it is not the security-relevant chokepoint: by the time a
 * `CodeDigest` reaches it, the choice of what to send has already been made.
 * The choice is made here — strip the seeded `bug:` markers, split into lines,
 * take the digest — and it was made in three places, verbatim, until this
 * module existed. `auditRegressions` had to compensate with a line-level
 * regex over source text, which is not a data-flow proof and cannot be one.
 *
 * `codeDigest` stays free of `vscode` on purpose: it is a pure module, raw
 * lines in and a digest out, and every one of its tests is a fixture array.
 * This is the thin `vscode`-aware shell around it.
 */

import type * as vscode from "vscode";
import { stripBugMarkers } from "./bugMarkers";
import { buildDigest, type CodeDigest } from "./codeDigest";

/**
 * The digest for `focus` inside `doc`.
 *
 * @param focus 0-based, inclusive — the block the student is working on.
 * @param cursorLine 0-based. Pass it whenever the request is *about* a line
 *   rather than about the block: the digest is built around the block, and in
 *   a block longer than the budget the two do not have to overlap. Omitted
 *   where there is no cursor behind the request (the panel's conversation).
 * @param languageId defaults to the document's own. The panel overrides it
 *   with the last *supported* language it saw, because that is the language
 *   its request will claim on the wire — a digest parsed as one language and
 *   announced as another is worse than either.
 */
export function digestFor(
  doc: vscode.TextDocument,
  focus: { startLine: number; endLine: number },
  cursorLine?: number,
  languageId: string = doc.languageId
): CodeDigest {
  const lines = stripBugMarkers(doc.getText(), languageId).split("\n");
  return buildDigest(
    lines,
    languageId,
    { start: focus.startLine, end: focus.endLine },
    cursorLine
  );
}
