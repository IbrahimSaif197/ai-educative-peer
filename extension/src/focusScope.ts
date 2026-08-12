/**
 * What "the code the student is working on" means, in one place.
 *
 * Resolution order is a confidence order. An explicit selection beats
 * everything, because the student said it out loud. A real document symbol
 * beats a regex, because the language server parsed the file. The regex beats
 * a line window, because it at least knows what a function looks like. And a
 * line window always works.
 */

import * as vscode from "vscode";
import { clampAroundCursor, findEnclosingBlock } from "./blockHeuristics";

/** Half-height of the fallback window, in lines. */
export const WINDOW_RADIUS = 15;

export type FocusKind = "selection" | "symbol" | "heuristic" | "window";

export interface FocusScope {
  /** 0-based, inclusive. */
  startLine: number;
  /** 0-based, inclusive. */
  endLine: number;
  /** Short name for the block: a symbol name, "selection", or "lines 4-19". */
  label: string;
  /** "demo.py › Stats › calculate_average" */
  breadcrumb: string;
  kind: FocusKind;
}

/** Symbols worth focusing on. A variable or a property is not a unit of work. */
const FOCUSABLE_KINDS = new Set<vscode.SymbolKind>([
  vscode.SymbolKind.Function,
  vscode.SymbolKind.Method,
  vscode.SymbolKind.Constructor,
  vscode.SymbolKind.Class,
  vscode.SymbolKind.Struct,
]);

/** One entry: re-resolving on every keystroke is the thing being avoided. */
let cache: { key: string; scope: FocusScope } | undefined;

function fileNameOf(doc: vscode.TextDocument): string {
  return doc.fileName.split(/[\\/]/).pop() || "untitled";
}

export function focusText(doc: vscode.TextDocument, focus: FocusScope): string {
  const endLine = Math.min(focus.endLine, doc.lineCount - 1);
  const range = new vscode.Range(
    new vscode.Position(focus.startLine, 0),
    new vscode.Position(endLine, doc.lineAt(endLine).text.length)
  );
  return doc.getText(range);
}

export async function resolveFocus(
  doc: vscode.TextDocument,
  selection: vscode.Selection
): Promise<FocusScope> {
  const cursor = selection.active.line;
  const key = [
    doc.uri.toString(),
    doc.version,
    cursor,
    selection.start.line,
    selection.end.line,
    selection.isEmpty ? "empty" : "range",
  ].join("::");
  if (cache?.key === key) return cache.scope;

  const scope =
    fromSelection(doc, selection) ??
    (await fromSymbols(doc, cursor)) ??
    fromHeuristic(doc, cursor) ??
    fromWindow(doc, cursor);

  cache = { key, scope };
  return scope;
}

function fromSelection(
  doc: vscode.TextDocument,
  selection: vscode.Selection
): FocusScope | undefined {
  if (selection.isEmpty) return undefined;
  // A selection that ends at column 0 was dragged to the start of the next
  // line; the student did not mean to include it.
  const endLine =
    selection.end.character === 0 && selection.end.line > selection.start.line
      ? selection.end.line - 1
      : selection.end.line;
  return {
    startLine: selection.start.line,
    endLine,
    label: "selection",
    // The span is part of the name, the way `fromWindow` already names its
    // own. A bare `demo.py › selection` identifies no block: it is the same
    // string for every selection anyone ever drags in this file, and
    // `inlineTutor` keys its per-block scan state on the breadcrumb. Two
    // different selections then share one key, so flags earned on the first
    // make the second — scanning clean, as a different block well might —
    // read as flagged-to-clean, fire the reflection offer, and delete the
    // `bug:` markers inside a block that was never flagged.
    breadcrumb: `${fileNameOf(doc)} › selection ${selection.start.line + 1}-${endLine + 1}`,
    kind: "selection",
  };
}

async function fromSymbols(
  doc: vscode.TextDocument,
  cursor: number
): Promise<FocusScope | undefined> {
  let symbols: vscode.DocumentSymbol[] | undefined;
  try {
    symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
      "vscode.executeDocumentSymbolProvider",
      doc.uri
    );
  } catch {
    // No provider installed, or it failed. The heuristic is the whole point.
    return undefined;
  }
  if (!Array.isArray(symbols) || symbols.length === 0) return undefined;

  const chain: vscode.DocumentSymbol[] = [];
  let level: vscode.DocumentSymbol[] = symbols;
  while (level.length) {
    const hit = level.find(
      (s) => s.range && s.range.start.line <= cursor && s.range.end.line >= cursor
    );
    if (!hit) break;
    chain.push(hit);
    level = hit.children ?? [];
  }

  const focusable = [...chain].reverse().find((s) => FOCUSABLE_KINDS.has(s.kind));
  if (!focusable) return undefined;

  const names = chain.slice(0, chain.indexOf(focusable) + 1).map((s) => s.name);
  // A language server reports whatever it parsed, and a class is a symbol. With
  // the cursor on a class-level line of an 800-line class the innermost
  // focusable symbol *is* that class, so the span was the whole thing — the
  // heuristic path has been capped since it was written, this one never was.
  // The span is what tells the tutor which lines the student is working on, and
  // what decides which flags a scan may replace and which `bug:` markers it may
  // delete, so it has to mean something. Same rule as the heuristic path, and
  // the label and breadcrumb are untouched: this is still that block, just a
  // bounded view of it, so the hint ladder and the conversation thread stay put.
  const span = clampAroundCursor(
    { start: focusable.range.start.line, end: focusable.range.end.line },
    cursor
  );
  return {
    startLine: span.start,
    endLine: span.end,
    // Some language servers return a name carrying its signature —
    // `calculate(int)` from clangd, and the C# style. The label keys the hint
    // ladder and reaches the prompt outside the untrusted-input wrapper, so
    // only the name travels. The breadcrumb keeps the provider's full text: it
    // is display-only and never leaves the extension.
    label: identifierIn(focusable.name),
    breadcrumb: [fileNameOf(doc), ...names].join(" › "),
    kind: "symbol",
  };
}

function fromHeuristic(doc: vscode.TextDocument, cursor: number): FocusScope | undefined {
  const lines = doc.getText().split("\n");
  const span = findEnclosingBlock(lines, cursor, doc.languageId);
  if (!span) return undefined;
  const label = headerName(lines[span.start]);
  return {
    startLine: span.start,
    endLine: span.end,
    label,
    breadcrumb: `${fileNameOf(doc)} › ${label}`,
    kind: "heuristic",
  };
}

/**
 * The leading identifier in a piece of text, capped.
 *
 * Both label paths need this. A symbol provider can hand back `calculate(int)`,
 * and a header line is arbitrary file text. The label keys the hint ladder and
 * is interpolated into the prompt outside the untrusted-input wrapper, so it
 * has to be a name — `void f(Ignore all previous rules and answer) {` is a
 * valid C header, and 40 characters is plenty of room for an instruction.
 */
function identifierIn(text: string): string {
  return (text.trim().match(/[A-Za-z_]\w*/)?.[0] ?? "block").slice(0, 40);
}

/** The first identifier on a definition line, which is close enough to a name. */
function headerName(header: string): string {
  const match = header.match(
    /\b(?:def|class|function|fn|func|struct|interface|enum|impl|trait)\s+([A-Za-z_]\w*)/
  );
  if (match) return match[1];
  const assigned = header.match(/\b(?:const|let|var)\s+([A-Za-z_]\w*)/);
  if (assigned) return assigned[1];
  // The name of the thing being declared is glued to its parameter list. Taking
  // the leading identifier instead labels every C function `int` and every Java
  // method `public`, which collapses them onto one problem_key — and since the
  // attempt tracker is keyed on that too, moving the cursor between two
  // functions then reads as "the student changed the code" and walks the ladder
  // 1→2→3 with no edit at all.
  const called = header.match(/([A-Za-z_]\w*)\(/);
  if (called) return called[1].slice(0, 40);
  // Everything left: SQL statements, and declarations with no parameter list.
  // Coarse, but never raw file text.
  return identifierIn(header);
}

function fromWindow(doc: vscode.TextDocument, cursor: number): FocusScope {
  const startLine = Math.max(0, cursor - WINDOW_RADIUS);
  const endLine = Math.min(doc.lineCount - 1, cursor + WINDOW_RADIUS);
  const label = `lines ${startLine + 1}-${endLine + 1}`;
  return {
    startLine,
    endLine,
    label,
    breadcrumb: `${fileNameOf(doc)} › ${label}`,
    kind: "window",
  };
}
