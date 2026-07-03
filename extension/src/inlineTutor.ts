import * as vscode from "vscode";
import { ApiClient, LineFlag } from "./apiClient";
import {
  SUPPORTED_LANGUAGES,
  SUPPORTED_LANGUAGE_IDS,
  isSupportedLanguage,
  supportedLanguageList,
} from "./languages";

import { codeFingerprint as fingerprintCode } from "./pedagogy";

type LineHintCache = Map<string, { hint: string; concept: string }>;

interface FileState {
  flags: LineFlag[];
  scanFingerprint: string;
  lineHints: LineHintCache;
}

function fingerprintLine(uri: string, lineNum: number, text: string): string {
  return `${uri}::${lineNum}::${text.trim()}`;
}

export class InlineTutor {
  private readonly ghostDecoration: vscode.TextEditorDecorationType;
  private readonly flagGutterInfo: vscode.TextEditorDecorationType;
  private readonly flagGutterWarn: vscode.TextEditorDecorationType;
  private readonly diagnostics: vscode.DiagnosticCollection;
  private readonly fileStates = new Map<string, FileState>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly emitter = new vscode.EventEmitter<void>();

  private debounceHandle: NodeJS.Timeout | undefined;
  private scanHandle: NodeJS.Timeout | undefined;
  private pendingLineKey: string | undefined;
  /** Flag counts from the previous scan, per document. */
  private readonly lastFlagCounts = new Map<string, number>();
  /** Code fingerprints we already offered a reflection quiz for. */
  private readonly reflectOffered = new Set<string>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly api: ApiClient
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

  private stateFor(uri: vscode.Uri): FileState {
    const key = uri.toString();
    let s = this.fileStates.get(key);
    if (!s) {
      s = { flags: [], scanFingerprint: "", lineHints: new Map() };
      this.fileStates.set(key, s);
    }
    return s;
  }

  private scheduleLineHint(editor: vscode.TextEditor) {
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
    const state = this.stateFor(doc.uri);
    const key = fingerprintLine(doc.uri.toString(), line, lineText);
    if (!opts.force && state.lineHints.has(key)) {
      this.renderActiveLineIfMatches(doc, line);
      return;
    }
    try {
      const res = await this.api.getLineHint(
        doc.getText(),
        line + 1,
        doc.languageId
      );
      if (res.hint) {
        state.lineHints.set(key, { hint: res.hint, concept: res.concept });
        this.renderActiveLineIfMatches(doc, line);
      }
    } catch {
      /* network errors are non-fatal */
    }
  }

  private renderActiveLineIfMatches(doc: vscode.TextDocument, line: number) {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document !== doc) return;
    if (editor.selection.active.line !== line) return;
    this.renderActiveLineDecoration(editor);
  }

  private renderActiveLineDecoration(editor: vscode.TextEditor) {
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
    const state = this.stateFor(doc.uri);
    const key = fingerprintLine(doc.uri.toString(), line, lineText);
    const cached = state.lineHints.get(key);

    const flag = state.flags.find((f) => line + 1 >= f.line && line + 1 <= f.end_line);

    const contentText = cached?.hint
      ? `💡 ${cached.hint}`
      : flag
      ? `🤔 ${flag.question}`
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
    const state = this.stateFor(doc.uri);
    if (!opts.force && state.scanFingerprint === fp) return;
    state.scanFingerprint = fp;
    try {
      const res = await this.api.scanCode(code, doc.languageId);
      state.flags = res.flags || [];
      this.applyFlagsToDoc(doc, state.flags);
      this.emitter.fire();
      const editor = vscode.window.activeTextEditor;
      if (editor && editor.document === doc) {
        this.renderActiveLineDecoration(editor);
      }
      this.maybeOfferReflection(doc, code, state.flags.length);
    } catch {
      /* scan failures are non-fatal */
    }
  }

  /** After a file goes from flagged to clean, offer a reflection quiz once. */
  private maybeOfferReflection(doc: vscode.TextDocument, code: string, flagCount: number) {
    const key = doc.uri.toString();
    const prev = this.lastFlagCounts.get(key) ?? 0;
    this.lastFlagCounts.set(key, flagCount);
    if (prev === 0 || flagCount > 0) return;
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

  private applyFlagsToDoc(doc: vscode.TextDocument, flags: LineFlag[]) {
    const diags: vscode.Diagnostic[] = [];
    const infoRanges: vscode.Range[] = [];
    const warnRanges: vscode.Range[] = [];
    for (const f of flags) {
      const startLine = Math.max(0, Math.min(doc.lineCount - 1, f.line - 1));
      const endLine = Math.max(startLine, Math.min(doc.lineCount - 1, f.end_line - 1));
      const start = new vscode.Position(startLine, 0);
      const end = new vscode.Position(endLine, doc.lineAt(endLine).text.length);
      const range = new vscode.Range(start, end);
      const severity =
        f.severity === "warning"
          ? vscode.DiagnosticSeverity.Warning
          : vscode.DiagnosticSeverity.Information;
      const diag = new vscode.Diagnostic(range, `🤔 ${f.question}`, severity);
      diag.source = "EduPeer";
      diag.code = f.concept;
      diags.push(diag);
      if (f.severity === "warning") warnRanges.push(range);
      else infoRanges.push(range);
    }
    this.diagnostics.set(doc.uri, diags);
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document === doc) {
        editor.setDecorations(this.flagGutterInfo, infoRanges);
        editor.setDecorations(this.flagGutterWarn, warnRanges);
      }
    }
  }

  private provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (!this.isSupported(doc)) return [];
    const lenses: vscode.CodeLens[] = [];
    const state = this.stateFor(doc.uri);
    const seenLines = new Set<number>();

    for (const flag of state.flags) {
      const line = Math.max(0, Math.min(doc.lineCount - 1, flag.line - 1));
      if (seenLines.has(line)) continue;
      seenLines.add(line);
      const range = new vscode.Range(line, 0, line, 0);
      lenses.push(
        new vscode.CodeLens(range, {
          title: `🤔 ${flag.question}`,
          command: "edupeer.nudgeLine",
          arguments: [doc.uri, line],
        })
      );
    }

    const lensRegex = SUPPORTED_LANGUAGES[doc.languageId]?.lensRegex;
    if (!lensRegex) return lenses;
    for (let i = 0; i < doc.lineCount; i++) {
      if (seenLines.has(i)) continue;
      const text = doc.lineAt(i).text;
      if (lensRegex.test(text)) {
        seenLines.add(i);
        const range = new vscode.Range(i, 0, i, 0);
        lenses.push(
          new vscode.CodeLens(range, {
            title: "💡 Get a hint",
            command: "edupeer.nudgeLine",
            arguments: [doc.uri, i],
          })
        );
      }
    }

    return lenses;
  }

  private provideHover(
    doc: vscode.TextDocument,
    pos: vscode.Position
  ): vscode.Hover | undefined {
    if (!this.isSupported(doc)) return undefined;
    const state = this.stateFor(doc.uri);
    const lineNum = pos.line + 1;
    const flag = state.flags.find((f) => lineNum >= f.line && lineNum <= f.end_line);
    const lineText = doc.lineAt(pos.line).text;
    const key = fingerprintLine(doc.uri.toString(), pos.line, lineText);
    const cached = state.lineHints.get(key);

    if (!flag && !cached) return undefined;
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = true;
    md.appendMarkdown("**EduPeer**\n\n");
    if (cached?.hint) md.appendMarkdown(`💡 ${cached.hint}\n\n`);
    if (flag) md.appendMarkdown(`🤔 ${flag.question}\n\n_concept: ${flag.concept}_\n\n`);
    md.appendMarkdown(
      `[Ask for a deeper nudge](command:edupeer.nudgeLine?${encodeURIComponent(
        JSON.stringify([doc.uri.toString(), pos.line])
      )})`
    );
    return new vscode.Hover(md);
  }
}
