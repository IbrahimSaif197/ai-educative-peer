import * as vscode from "vscode";
import { ApiClient, AuthError, LineFlag, RateLimitError } from "./apiClient";
import { AnnotationStore, ContentChange, LensState } from "./annotationStore";
import {
  SUPPORTED_LANGUAGES,
  SUPPORTED_LANGUAGE_IDS,
  isSupportedLanguage,
  supportedLanguageList,
} from "./languages";
import { localLineHint } from "./localTutor";
import { resolveFocus } from "./focusScope";
import { findBugMarkers } from "./bugMarkers";

import { codeFingerprint as fingerprintCode } from "./pedagogy";

/**
 * The failure classes a student can actually do something about, each with the
 * one sentence that says what to do. Everything that used to be swallowed at
 * the catch site now lands here instead.
 */
export function errorStateFor(err: unknown, apiAvailable: boolean): LensState {
  if (err instanceof RateLimitError) {
    const minutes = Math.max(1, Math.round(err.retryAfterSeconds / 60));
    return {
      kind: "error",
      reason: "rate-limit",
      message: `Hint budget used up, back in ${minutes}m`,
    };
  }
  if (err instanceof AuthError) {
    return { kind: "error", reason: "auth", message: "Sign in to get hints" };
  }
  if (!apiAvailable) {
    return { kind: "error", reason: "offline", message: "Backend unreachable" };
  }
  const message = (err as { message?: string })?.message ?? String(err);
  if (/\(5\d\d\)/.test(message)) {
    return { kind: "error", reason: "llm", message: "The tutor couldn't answer that" };
  }
  return { kind: "error", reason: "unknown", message: "That didn't work" };
}

/** One home for the "working on it" wording, shared by the lens and the hover. */
export const THINKING_LABEL = "⏳ EduPeer is thinking…";

/** What the lens says. `fallback` is the idle title for this line. */
export function lensTitle(state: LensState, fallback: string): string {
  switch (state.kind) {
    case "loading":
      return THINKING_LABEL;
    case "ready":
      return `💡 ${state.hint}`;
    case "empty":
      return "✓ Nothing to flag on this line";
    case "error":
      return state.reason === "auth"
        ? `⚠️ ${state.message} — click to sign in`
        : `⚠️ ${state.message} — click to retry`;
    default:
      return fallback;
  }
}

function fingerprintLine(uri: string, lineNum: number, text: string): string {
  return `${uri}::${lineNum}::${text.trim()}`;
}

function flagEmoji(flag: LineFlag): string {
  return flag.kind === "style" ? "🎨" : "🤔";
}

/** VS Code's content changes reduced to the line arithmetic the store needs. */
function toContentChanges(
  changes: readonly vscode.TextDocumentContentChangeEvent[]
): ContentChange[] {
  return changes.map((c) => ({
    startLine: c.range.start.line,
    endLine: c.range.end.line,
    insertedLineCount: c.text.split("\n").length,
  }));
}

export class InlineTutor {
  private readonly ghostDecoration: vscode.TextEditorDecorationType;
  private readonly flagGutterInfo: vscode.TextEditorDecorationType;
  private readonly flagGutterWarn: vscode.TextEditorDecorationType;
  private readonly diagnostics: vscode.DiagnosticCollection;
  private readonly stores = new Map<string, AnnotationStore>();
  /** Content of the last scan that actually succeeded, per document. */
  private readonly scanFingerprints = new Map<string, string>();
  /** Content of a scan in flight; de-dupes without claiming success. */
  private readonly inFlightFingerprints = new Map<string, string>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly emitter = new vscode.EventEmitter<void>();

  private debounceHandle: NodeJS.Timeout | undefined;
  private scanHandle: NodeJS.Timeout | undefined;
  private pendingLineKey: string | undefined;
  /** Flag counts from the previous scan, per document. */
  private readonly lastFlagCounts = new Map<string, number>();
  /** Code fingerprints we already offered a reflection quiz for. */
  private readonly reflectOffered = new Set<string>();
  /** Epoch ms until which automatic requests stay quiet after a 429. */
  private quietUntil = 0;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly api: ApiClient,
    private readonly onThinkingChange: (thinking: boolean) => void = () => {}
  ) {
    this.ghostDecoration = vscode.window.createTextEditorDecorationType({
      after: {
        margin: "0 0 0 2rem",
        color: new vscode.ThemeColor("editorCodeLens.foreground"),
        fontStyle: "italic",
      },
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });

    this.flagGutterInfo = vscode.window.createTextEditorDecorationType({
      overviewRulerColor: new vscode.ThemeColor("editorInfo.foreground"),
      overviewRulerLane: vscode.OverviewRulerLane.Right,
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor("editor.hoverHighlightBackground"),
    });

    this.flagGutterWarn = vscode.window.createTextEditorDecorationType({
      overviewRulerColor: new vscode.ThemeColor("editorWarning.foreground"),
      overviewRulerLane: vscode.OverviewRulerLane.Right,
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor("editorWarning.background"),
    });

    this.diagnostics = vscode.languages.createDiagnosticCollection("edupeer");
  }

  activate() {
    this.disposables.push(this.ghostDecoration);
    this.disposables.push(this.flagGutterInfo);
    this.disposables.push(this.flagGutterWarn);
    this.disposables.push(this.diagnostics);
    this.disposables.push(this.emitter);

    const selector = SUPPORTED_LANGUAGE_IDS.map((language) => ({ language }));

    this.disposables.push(
      vscode.languages.registerCodeLensProvider(selector, {
        onDidChangeCodeLenses: this.emitter.event,
        provideCodeLenses: (doc) => this.provideCodeLenses(doc),
      })
    );

    this.disposables.push(
      vscode.languages.registerHoverProvider(selector, {
        provideHover: (doc, pos) => this.provideHover(doc, pos),
      })
    );

    // The lightbulb students already reach for should reach the tutor.
    this.disposables.push(
      vscode.languages.registerCodeActionsProvider(
        selector,
        { provideCodeActions: (doc, range) => this.provideCodeActions(doc, range) },
        { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
      )
    );

    this.disposables.push(
      vscode.window.onDidChangeTextEditorSelection((e) => {
        if (!this.isSupported(e.textEditor.document)) return;
        this.scheduleLineHint(e.textEditor);
        this.renderActiveLineDecoration(e.textEditor);
      })
    );

    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (!this.isSupported(e.document)) return;
        this.storeFor(e.document.uri).applyChanges(toContentChanges(e.contentChanges));
        this.applyFlagsToDoc(e.document);
        this.emitter.fire();
        this.scheduleScan(e.document);
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document === e.document) {
          this.scheduleLineHint(editor);
          this.renderActiveLineDecoration(editor);
        }
      })
    );

    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor && this.isSupported(editor.document)) {
          this.scheduleScan(editor.document);
          this.renderActiveLineDecoration(editor);
        }
      })
    );

    this.disposables.push(
      vscode.commands.registerCommand(
        "edupeer.nudgeLine",
        async (uriArg?: vscode.Uri, lineArg?: number) => {
          const editor = vscode.window.activeTextEditor;
          if (!editor || !this.isSupported(editor.document)) {
            vscode.window.showInformationMessage(
              `EduPeer: open a supported file first (${supportedLanguageList()}).`
            );
            return;
          }
          const line =
            typeof lineArg === "number" ? lineArg : editor.selection.active.line;
          // Move the cursor to the target line so the inline hint renders
          // there (the decoration is drawn at the active line).
          if (line >= 0 && line < editor.document.lineCount) {
            const endCol = editor.document.lineAt(line).text.length;
            const pos = new vscode.Position(line, endCol);
            editor.selection = new vscode.Selection(pos, pos);
            editor.revealRange(new vscode.Range(pos, pos));
          }
          await this.fetchLineHint(editor.document, line, { force: true });
          this.renderActiveLineDecoration(editor);
        }
      )
    );

    this.disposables.push(
      vscode.commands.registerCommand(
        "edupeer.dismissLine",
        (uri: vscode.Uri, line: number) => {
          const doc = vscode.window.activeTextEditor?.document;
          if (!doc || doc.uri.toString() !== uri.toString()) return;
          this.storeFor(doc.uri).clearLine(line);
          this.emitter.fire();
          this.renderActiveLineDecoration(vscode.window.activeTextEditor!);
        }
      )
    );

    this.disposables.push(
      vscode.commands.registerCommand(
        "edupeer.deepenLine",
        async (uri: vscode.Uri, line: number) => {
          const doc = vscode.window.activeTextEditor?.document;
          if (!doc || doc.uri.toString() !== uri.toString()) return;
          const { hint, flag } = this.storeFor(doc.uri).annotationsAt(line);
          const question = hint?.hint || flag?.question || "Why is this line a problem?";
          // The real 1→3 ladder lives in the conversation; inline stays a nudge.
          await vscode.commands.executeCommand(
            "edupeer.discussLines",
            doc.uri,
            line,
            line,
            question
          );
        }
      )
    );

    this.disposables.push(
      vscode.commands.registerCommand("edupeer.scanFile", async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !this.isSupported(editor.document)) {
          vscode.window.showInformationMessage(
            `EduPeer: open a supported file first (${supportedLanguageList()}).`
          );
          return;
        }
        await this.runScan(editor.document, { force: true });
      })
    );

    // Per-file caches would otherwise grow for the whole session: one entry
    // per document ever opened, and one line-hint entry per distinct line text
    // ever visited inside it.
    this.disposables.push(
      vscode.workspace.onDidCloseTextDocument((doc) => {
        const key = doc.uri.toString();
        this.stores.delete(key);
        this.scanFingerprints.delete(key);
        this.inFlightFingerprints.delete(key);
        this.lastFlagCounts.delete(key);
        this.diagnostics.delete(doc.uri);
      })
    );

    const editor = vscode.window.activeTextEditor;
    if (editor && this.isSupported(editor.document)) {
      this.scheduleScan(editor.document);
    }
  }

  dispose() {
    for (const d of this.disposables) d.dispose();
    if (this.debounceHandle) clearTimeout(this.debounceHandle);
    if (this.scanHandle) clearTimeout(this.scanHandle);
  }

  private isSupported(doc: vscode.TextDocument): boolean {
    if (!isSupportedLanguage(doc.languageId)) return false;
    return vscode.workspace
      .getConfiguration("edupeer")
      .get<boolean>("inlineHints", true);
  }

  private storeFor(uri: vscode.Uri): AnnotationStore {
    const key = uri.toString();
    let store = this.stores.get(key);
    if (!store) {
      store = new AnnotationStore();
      this.stores.set(key, store);
    }
    return store;
  }

  private get lensMode(): "all" | "flagged" {
    return vscode.workspace
      .getConfiguration("edupeer")
      .get<"all" | "flagged">("lensMode", "all");
  }

  private scheduleLineHint(editor: vscode.TextEditor) {
    if (Date.now() < this.quietUntil) return;
    if (this.debounceHandle) clearTimeout(this.debounceHandle);
    const debounceMs = vscode.workspace
      .getConfiguration("edupeer")
      .get<number>("debounceMs", 1800);
    const doc = editor.document;
    const line = editor.selection.active.line;
    const lineText = doc.lineAt(line).text;
    if (!lineText.trim()) {
      this.renderActiveLineDecoration(editor);
      return;
    }
    const key = fingerprintLine(doc.uri.toString(), line, lineText);
    this.pendingLineKey = key;
    this.debounceHandle = setTimeout(() => {
      if (this.pendingLineKey !== key) return;
      this.fetchLineHint(doc, line).catch(() => {
        /* swallow */
      });
    }, Math.max(600, debounceMs));
  }

  private async fetchLineHint(
    doc: vscode.TextDocument,
    line: number,
    opts: { force?: boolean } = {}
  ) {
    if (line < 0 || line >= doc.lineCount) return;
    const lineText = doc.lineAt(line).text;
    if (!lineText.trim()) return;
    const store = this.storeFor(doc.uri);
    const cached = store.annotationsAt(line).hint;
    // A local rule is a placeholder for a real hint, so it must not block one
    // once the backend is answering again. That is what `local` is for.
    if (!opts.force && cached && !cached.local) {
      this.renderActiveLineIfMatches(doc, line);
      return;
    }

    // Lens state belongs to a hint the student asked for. The debounce path
    // fires on cursor movement, and painting a lens there would put
    // unsolicited text on every line the cursor rests on — including under
    // lensMode "flagged", whose entire purpose is to stop that.
    const showState = (state: LensState) => {
      if (opts.force) this.setLensState(doc, line, state);
    };

    // `line` is captured here and the round trip below takes seconds, during
    // which `applyChanges` runs on every keystroke — sliding entries down,
    // dropping the ones the student edited — and `clearLine` runs on a
    // dismissal. Both bump the store's revision, so a moved revision means
    // this answer is about a line that no longer exists at this index.
    // Dropping it is the same trade the spec already makes for flags: a
    // missing hint comes back on the next ask, a hint on the wrong line
    // teaches the wrong thing.
    const revision = store.revision;
    const isCurrent = () => store.revision === revision;

    // Fired before anything is awaited, so the student sees the click land.
    showState({ kind: "loading" });
    if (opts.force) this.onThinkingChange(true);
    try {
      // The same block the sidebar is showing, so both surfaces agree on
      // what "the code you're working on" means. That includes a live
      // selection: `resolveFocus` ranks one above everything, so a synthetic
      // empty selection here would make the lens resolve the enclosing symbol
      // while the panel resolves the selection — the two disagreeing in
      // exactly the case this comment claims they agree.
      const active = vscode.window.activeTextEditor;
      const at = new vscode.Position(line, 0);
      const selection =
        active?.document === doc &&
        !active.selection.isEmpty &&
        active.selection.active.line === line
          ? active.selection
          : new vscode.Selection(at, at);
      const focus = await resolveFocus(doc, selection);
      const res = await this.api.getLineHint(doc.getText(), line + 1, doc.languageId, {
        start_line: focus.startLine + 1,
        end_line: focus.endLine + 1,
        label: focus.label,
      });
      if (!isCurrent()) return;
      if (res.hint) {
        store.setHint(line, { hint: res.hint, concept: res.concept });
        showState({ kind: "ready", hint: res.hint });
      } else {
        // The lens is about to say there is nothing to flag here, so the hint
        // beside it has to go too — spec A4: the two surfaces never disagree.
        store.clearHint(line);
        showState({ kind: "empty" });
      }
    } catch (err) {
      if (err instanceof RateLimitError) {
        // Back-off is global, not per line, so it is recorded even when the
        // answer itself is stale.
        this.quietUntil = Date.now() + err.retryAfterSeconds * 1000;
      }
      if (!isCurrent()) return;
      // The local rule is still worth showing; the lens says where it came from.
      const local = localLineHint(lineText, doc.languageId);
      if (!this.api.isAvailable && local.hint) {
        store.setHint(line, { ...local, local: true });
        showState({ kind: "ready", hint: local.hint });
      } else {
        showState(errorStateFor(err, this.api.isAvailable));
      }
    } finally {
      if (opts.force) this.onThinkingChange(false);
      if (isCurrent()) this.renderActiveLineIfMatches(doc, line);
    }
  }

  /** Store the state and repaint the lenses immediately. */
  private setLensState(doc: vscode.TextDocument, line: number, state: LensState) {
    this.storeFor(doc.uri).setLensState(line, state);
    this.emitter.fire();
  }

  private renderActiveLineIfMatches(doc: vscode.TextDocument, line: number) {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document !== doc) return;
    if (editor.selection.active.line !== line) return;
    this.renderActiveLineDecoration(editor);
  }

  private renderActiveLineDecoration(editor: vscode.TextEditor) {
    // Decorations are per-editor, so a split view keeps showing the hint that
    // was pinned to a line the student has since rewritten in the other group.
    // The gutter-flag path already loops over visible editors; this one has to
    // as well, or the stale ghost survives until that group regains focus.
    for (const other of vscode.window.visibleTextEditors) {
      if (other !== editor) {
        other.setDecorations(this.ghostDecoration, []);
      }
    }
    const doc = editor.document;
    if (!this.isSupported(doc)) {
      editor.setDecorations(this.ghostDecoration, []);
      return;
    }
    const line = editor.selection.active.line;
    if (line < 0 || line >= doc.lineCount) {
      editor.setDecorations(this.ghostDecoration, []);
      return;
    }
    const lineText = doc.lineAt(line).text;

    // A real hint beats a scan flag beats a local rule — the local rule is
    // the crudest of the three and only earns the line when nothing else has
    // it. `hint.local` is what lets a real hint and a local rule share one
    // map in the store without losing this ordering.
    const { flag, hint } = this.storeFor(doc.uri).annotationsAt(line);
    const contentText =
      hint && !hint.local
        ? `💡 ${hint.hint}`
        : flag
        ? `${flagEmoji(flag)} ${flag.question}`
        : hint?.hint
        ? `💡 ${hint.hint}`
        : "";

    if (!contentText) {
      editor.setDecorations(this.ghostDecoration, []);
      return;
    }

    const range = new vscode.Range(
      new vscode.Position(line, lineText.length),
      new vscode.Position(line, lineText.length)
    );
    editor.setDecorations(this.ghostDecoration, [
      { range, renderOptions: { after: { contentText } } },
    ]);
  }

  private scheduleScan(doc: vscode.TextDocument) {
    const autoScan = vscode.workspace
      .getConfiguration("edupeer")
      .get<boolean>("autoScan", true);
    if (!autoScan) return;
    // Backing off after a 429 matters here: scans fire on every edit, so
    // retrying through a closed budget would keep it closed.
    if (Date.now() < this.quietUntil) return;
    if (this.scanHandle) clearTimeout(this.scanHandle);
    this.scanHandle = setTimeout(() => {
      this.runScan(doc).catch(() => {
        /* swallow */
      });
    }, 3500);
  }

  private async runScan(doc: vscode.TextDocument, opts: { force?: boolean } = {}) {
    const code = doc.getText();
    const fp = fingerprintCode(code);
    const key = doc.uri.toString();
    if (!opts.force && this.scanFingerprints.get(key) === fp) return;
    // `inFlightFingerprints` de-dupes concurrent requests without claiming the
    // scan succeeded. Committing `scanFingerprints` up front meant a failed
    // scan permanently suppressed auto-scan for that content — including
    // after a 429, defeating the back-off window right next to it.
    if (!opts.force && this.inFlightFingerprints.get(key) === fp) return;
    this.inFlightFingerprints.set(key, fp);
    try {
      const res = await this.api.scanCode(code, doc.languageId);
      this.scanFingerprints.set(key, fp);
      const store = this.storeFor(doc.uri);
      store.setFlags(res.flags || []);
      this.applyFlagsToDoc(doc);
      this.emitter.fire();
      const editor = vscode.window.activeTextEditor;
      if (editor && editor.document === doc) {
        this.renderActiveLineDecoration(editor);
      }
      this.maybeOfferReflection(doc, code, store.flags().length);
    } catch (err) {
      if (err instanceof RateLimitError) {
        this.quietUntil = Date.now() + err.retryAfterSeconds * 1000;
      }
      /* scan failures are otherwise non-fatal */
    } finally {
      if (this.inFlightFingerprints.get(key) === fp) {
        this.inFlightFingerprints.delete(key);
      }
    }
  }

  /**
   * Strip the seeded `bug:` markers once the file scans clean.
   *
   * The comment named a bug the student has now fixed, so leaving it there
   * makes the file lie about itself. This is the one place EduPeer writes into
   * the student's code, so it is narrow by construction: only a comment whose
   * body opens with `bug:`, and only on the flagged-to-clean transition. The
   * edit goes through a single `WorkspaceEdit`, so one Ctrl+Z puts it back.
   */
  private async removeFixedBugMarkers(doc: vscode.TextDocument) {
    const enabled = vscode.workspace
      .getConfiguration("edupeer")
      .get<boolean>("removeFixedBugComments", true);
    if (!enabled) return;

    const markers = findBugMarkers(doc.getText().split("\n"), doc.languageId);
    if (!markers.length) return;

    const edit = new vscode.WorkspaceEdit();
    for (const marker of markers) {
      const lastLine = marker.line >= doc.lineCount - 1;
      const range =
        marker.wholeLine && !lastLine
          ? new vscode.Range(marker.line, 0, marker.line + 1, 0)
          : new vscode.Range(marker.line, marker.start, marker.line, marker.end);
      edit.delete(doc.uri, range);
    }
    await vscode.workspace.applyEdit(edit);
  }

  /** After a file goes from flagged to clean, offer a reflection quiz once. */
  private maybeOfferReflection(doc: vscode.TextDocument, code: string, flagCount: number) {
    const key = doc.uri.toString();
    const prev = this.lastFlagCounts.get(key) ?? 0;
    this.lastFlagCounts.set(key, flagCount);
    if (prev === 0 || flagCount > 0) return;
    // Ahead of the reflection gate on purpose: the markers describe code that
    // is already fixed whether or not this fingerprint has been quizzed.
    void this.removeFixedBugMarkers(doc);
    const fp = fingerprintCode(code);
    if (this.reflectOffered.has(fp)) return;
    this.reflectOffered.add(fp);
    void vscode.window
      .showInformationMessage(
        "EduPeer: your file scans clean now. Want a quick reflection quiz on the fix?",
        "Quiz me",
        "Not now"
      )
      .then((choice) => {
        if (choice === "Quiz me") {
          void vscode.commands.executeCommand("edupeer.reflectQuiz");
        }
      });
  }

  /** The editor range a 1-based wire flag covers, clamped to the document. */
  private flagRange(doc: vscode.TextDocument, flag: LineFlag): vscode.Range {
    const startLine = Math.max(0, Math.min(doc.lineCount - 1, flag.line - 1));
    const endLine = Math.max(startLine, Math.min(doc.lineCount - 1, flag.end_line - 1));
    return new vscode.Range(
      new vscode.Position(startLine, 0),
      new vscode.Position(endLine, doc.lineAt(endLine).text.length)
    );
  }

  /** Diagnostics for whatever the store currently believes. */
  private diagnosticsFor(doc: vscode.TextDocument): vscode.Diagnostic[] {
    return this.storeFor(doc.uri).flags().map((f) => {
      const diag = new vscode.Diagnostic(
        this.flagRange(doc, f),
        `${flagEmoji(f)} ${f.question}`,
        f.severity === "warning"
          ? vscode.DiagnosticSeverity.Warning
          : vscode.DiagnosticSeverity.Information
      );
      diag.source = "EduPeer";
      diag.code = f.concept;
      return diag;
    });
  }

  private applyFlagsToDoc(doc: vscode.TextDocument) {
    const store = this.storeFor(doc.uri);
    this.diagnostics.set(doc.uri, this.diagnosticsFor(doc));
    const infoRanges: vscode.Range[] = [];
    const warnRanges: vscode.Range[] = [];
    for (const f of store.flags()) {
      const range = this.flagRange(doc, f);
      (f.severity === "warning" ? warnRanges : infoRanges).push(range);
    }
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document === doc) {
        editor.setDecorations(this.flagGutterInfo, infoRanges);
        editor.setDecorations(this.flagGutterWarn, warnRanges);
      }
    }
  }

  private provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (!this.isSupported(doc)) return [];
    const store = this.storeFor(doc.uri);
    const lenses: vscode.CodeLens[] = [];
    const seenLines = new Set<number>();

    const add = (line: number, idleTitle: string) => {
      if (seenLines.has(line)) return;
      seenLines.add(line);
      const state = store.lensStateAt(line);
      const range = new vscode.Range(line, 0, line, 0);
      lenses.push(
        new vscode.CodeLens(range, {
          title: lensTitle(state, idleTitle),
          command:
            state.kind === "error" && state.reason === "auth"
              ? "edupeer.signIn"
              : "edupeer.nudgeLine",
          arguments: state.kind === "error" && state.reason === "auth" ? [] : [doc.uri, line],
        })
      );
      if (state.kind !== "ready") return;
      // Sibling lenses so each action is separately clickable.
      lenses.push(
        new vscode.CodeLens(range, {
          title: "Go deeper",
          command: "edupeer.deepenLine",
          arguments: [doc.uri, line],
        }),
        new vscode.CodeLens(range, {
          title: "✕",
          command: "edupeer.dismissLine",
          arguments: [doc.uri, line],
        })
      );
    };

    // A flag is an observation about this code and outranks a standing offer.
    for (const flag of store.flags()) {
      add(this.flagRange(doc, flag).start.line, `${flagEmoji(flag)} ${flag.question}`);
    }

    // A line the student nudged must show its state even when it is neither a
    // definition nor a flagged line — Ctrl+Alt+H works anywhere, and without
    // this the loading and error states are invisible on exactly those lines.
    // Ahead of the lensMode check on purpose: the mode governs unsolicited
    // offers, not the answer to a question the student actually asked.
    for (const line of store.activeLensLines()) {
      if (line >= 0 && line < doc.lineCount) add(line, "💡 Ask EduPeer");
    }

    if (this.lensMode === "flagged") return lenses;

    const lensRegex = SUPPORTED_LANGUAGES[doc.languageId]?.lensRegex;
    if (!lensRegex) return lenses;
    for (let i = 0; i < doc.lineCount; i++) {
      if (lensRegex.test(doc.lineAt(i).text)) add(i, "💡 Ask EduPeer");
    }
    return lenses;
  }

  /**
   * Quick Fixes on EduPeer's own diagnostics. They never edit the code — the
   * whole point is that the student writes the fix — so each one just routes
   * the line into a tutor mode.
   */
  private provideCodeActions(
    doc: vscode.TextDocument,
    range: vscode.Range | vscode.Selection
  ): vscode.CodeAction[] {
    if (!this.isSupported(doc)) return [];
    const line = range.start.line;
    const actions: vscode.CodeAction[] = [];

    const nudge = new vscode.CodeAction(
      "EduPeer: nudge me on this line",
      vscode.CodeActionKind.QuickFix
    );
    nudge.command = {
      command: "edupeer.nudgeLine",
      title: "Nudge this line",
      arguments: [doc.uri, line],
    };
    actions.push(nudge);

    const explain = new vscode.CodeAction(
      "EduPeer: explain this line",
      vscode.CodeActionKind.QuickFix
    );
    explain.command = { command: "edupeer.explainSelection", title: "Explain this line" };
    actions.push(explain);

    const { flag } = this.storeFor(doc.uri).annotationsAt(line);
    if (flag) {
      const discuss = new vscode.CodeAction(
        `EduPeer: talk through "${flag.question}"`,
        vscode.CodeActionKind.QuickFix
      );
      discuss.diagnostics = this.diagnostics
        .get(doc.uri)
        ?.filter((d) => d.range.start.line === line);
      discuss.command = {
        command: "edupeer.discussLines",
        title: "Talk it through",
        arguments: [doc.uri, flag.line - 1, flag.end_line - 1, flag.question],
      };
      actions.push(discuss);
    }

    return actions;
  }

  private provideHover(
    doc: vscode.TextDocument,
    pos: vscode.Position
  ): vscode.Hover | undefined {
    if (!this.isSupported(doc)) return undefined;
    const store = this.storeFor(doc.uri);
    const { flag, hint } = store.annotationsAt(pos.line);
    // Spec A4: the hover reflects `loading` and `error` too, so hovering a
    // line mid-request no longer says nothing while the lens says ⏳.
    //
    // The condition only, never the lens's trailing "— click to retry" /
    // "— click to sign in": the hover has nothing to click. Its `isTrusted`
    // allow-list is deliberately just `nudgeLine` and `explainSelection`, and
    // widening it to carry a sign-in link would widen it for the
    // model-authored text appended below as well. The action stays on the lens.
    const state = store.lensStateAt(pos.line);
    const status =
      state.kind === "loading"
        ? THINKING_LABEL
        : state.kind === "error"
        ? `⚠️ ${state.message}`
        : "";

    if (!flag && !hint && !status) return undefined;
    const md = new vscode.MarkdownString(undefined, true);
    // Model-authored text (scan questions, line hints) is appended below, and
    // a blanket-trusted MarkdownString renders ANY command: link in it as
    // clickable. Allow-list only our own two commands so a hostile file that
    // steers the model into emitting a command link cannot run anything else.
    md.isTrusted = { enabledCommands: ["edupeer.nudgeLine", "edupeer.explainSelection"] };
    md.appendMarkdown("**EduPeer**\n\n");
    if (status) md.appendMarkdown(`${status}\n\n`);
    if (hint?.hint) md.appendMarkdown(`💡 ${hint.hint}\n\n`);
    if (flag) md.appendMarkdown(`${flagEmoji(flag)} ${flag.question}\n\n_concept: ${flag.concept}_\n\n`);
    md.appendMarkdown(
      `[Ask for a deeper nudge](command:edupeer.nudgeLine?${encodeURIComponent(
        JSON.stringify([doc.uri.toString(), pos.line])
      )}) · [Explain this line](command:edupeer.explainSelection)`
    );
    return new vscode.Hover(md);
  }
}
