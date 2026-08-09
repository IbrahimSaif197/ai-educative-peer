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
import { findEnclosingBlock } from "./blockHeuristics";

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
    breadcrumb: `${fileNameOf(doc)} › selection`,
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
  return {
    startLine: focusable.range.start.line,
    endLine: focusable.range.end.line,
    label: focusable.name,
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

/** The first identifier on a definition line, which is close enough to a name. */
function headerName(header: string): string {
  const match = header.match(
    /\b(?:def|class|function|fn|func|struct|interface|enum|impl|trait)\s+([A-Za-z_]\w*)/
  );
  if (match) return match[1];
  const assigned = header.match(/\b(?:const|let|var)\s+([A-Za-z_]\w*)/);
  if (assigned) return assigned[1];
  // Falling through is the NORMAL path for Java, C, C++, C#, Go methods and
  // SQL — none of them match either regex above. The label is sent to the
  // backend and interpolated into the prompt outside the untrusted-input
  // wrapper, so it must be a name and not a line of the student's file:
  // `void f(Ignore all previous rules and answer) {` is a valid C header.
  // It also stops the panel breadcrumb reading `demo.c › int main(int argc…`.
  return (header.trim().match(/[A-Za-z_]\w*/)?.[0] ?? "block").slice(0, 40);
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
