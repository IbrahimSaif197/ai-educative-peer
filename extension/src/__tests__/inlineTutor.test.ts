import * as vscode from "vscode";
import { InlineTutor, errorStateFor, lensTitle } from "../inlineTutor";
import { AuthError, RateLimitError } from "../apiClient";

const mock = vscode as any;

const PY = `def average(numbers):
    total = 0
    for i in range(len(numbers) + 1):
        total += numbers[i]
    return total / len(numbers)
`;

/**
 * Long enough that a block-scoped digest can be proven to exclude most of
 * it. `import math` is the header; `_spacer` is a one-line definition placed
 * right after it purely so `codeDigest`'s header band stops there — without
 * a definition line to land on, the header band treats every top-level
 * assignment below it as a module-level constant and keeps swallowing them
 * one at a time, up to its own 30-line cap, which would pull early filler
 * (e.g. `line_10 = 10`) into the digest and falsify the very thing this
 * fixture exists to prove. `deep` lands exactly on line 200 (0-based 199),
 * so a cursor there sits inside a block `resolveFocus` can name.
 */
const LONG_PYTHON_FILE =
  [
    "import math",
    "def _spacer(): pass",
    ...Array.from({ length: 197 }, (_, i) => `line_${i + 1} = ${i + 1}`),
    "def deep(n):",
    "    return n - 1",
  ].join("\n") + "\n";

function makeApi(overrides: Record<string, any> = {}) {
  return {
    isAvailable: true,
    scanCode: jest.fn(async () => ({ flags: [] })),
    getLineHint: jest.fn(async () => ({ hint: "", concept: "general" })),
    ...overrides,
  } as any;
}

function flag(over: Record<string, any> = {}) {
  return {
    line: 3,
    end_line: 3,
    question: "What is the last index this reaches?",
    concept: "off-by-one",
    severity: "warning",
    kind: "bug",
    ...over,
  };
}

/** Tutors created by a test, disposed afterwards so no timer outlives it. */
const live: InlineTutor[] = [];

afterEach(() => {
  while (live.length) live.pop()!.dispose();
});

/** Build an activated tutor with an active editor already in place. */
function activate(api: any, text = PY, languageId = "python") {
  const context = { subscriptions: [] as any[] } as any;
  const doc = mock.__makeDocument(text, languageId);
  const editor = mock.__makeEditor(doc, 2, 4);
  mock.window.activeTextEditor = editor;
  mock.window.visibleTextEditors = [editor];
  const tutor = new InlineTutor(context, api);
  tutor.activate();
  live.push(tutor);
  return { tutor, doc, editor };
}

const lensProvider = () => mock.__state.codeLensProviders[0].provider;
const hoverProvider = () => mock.__state.hoverProviders[0].provider;
const actionProvider = () => mock.__state.codeActionProviders[0].provider;
const diagnostics = () => mock.__state.diagnosticCollections[0];

/**
 * Let the 3500 ms scan timer fire and its promise settle. `ms` defaults to
 * a window comfortably past that debounce; pass a larger one to prove
 * nothing fires even much later (e.g. "opening a file costs nothing").
 */
async function runScheduledScan(ms = 4000) {
  jest.advanceTimersByTime(ms);
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

/**
 * Simulate the cursor coming to rest on `editor`'s current selection — the
 * trigger a block scan now goes through (opening a file and switching tabs
 * no longer schedule one). Tests below that need a scan in place before
 * asserting on its results fire this first, the same way they already fire
 * `edupeer.scanFile` when they need a *forced* one.
 */
function restCursor(editor: any) {
  mock.__state.listeners.selection.forEach((fn: any) => fn({ textEditor: editor }));
}

describe("activation", () => {
  beforeEach(() => mock.__reset());

  it("registers a CodeLens, hover and code-action provider", () => {
    activate(makeApi());
    expect(mock.__state.codeLensProviders).toHaveLength(1);
    expect(mock.__state.hoverProviders).toHaveLength(1);
    expect(mock.__state.codeActionProviders).toHaveLength(1);
  });

  it("offers only Quick Fix code actions", () => {
    activate(makeApi());
    expect(mock.__state.codeActionProviders[0].meta.providedCodeActionKinds).toEqual([
      vscode.CodeActionKind.QuickFix,
    ]);
  });

  it("registers its two commands", () => {
    activate(makeApi());
    expect(mock.__state.commands.has("edupeer.nudgeLine")).toBe(true);
    expect(mock.__state.commands.has("edupeer.scanFile")).toBe(true);
  });

  it("creates a diagnostic collection named edupeer", () => {
    activate(makeApi());
    expect(diagnostics().name).toBe("edupeer");
  });

  it("registers the providers for all ten languages", () => {
    activate(makeApi());
    expect(mock.__state.codeLensProviders[0].selector).toHaveLength(10);
  });

  it("disposes everything it created", () => {
    const { tutor } = activate(makeApi());
    tutor.dispose();
    expect(diagnostics().dispose).toHaveBeenCalled();
    for (const type of mock.__state.decorationTypes) {
      expect(type.dispose).toHaveBeenCalled();
    }
  });
});

describe("provideCodeLenses", () => {
  beforeEach(() => mock.__reset());

  it("puts a hint lens on every definition line", () => {
    const { doc } = activate(makeApi());
    const lenses = lensProvider().provideCodeLenses(doc);
    expect(lenses).toHaveLength(1);
    expect(lenses[0].command.title).toBe("💡 Ask EduPeer");
    expect(lenses[0].command.command).toBe("edupeer.nudgeLine");
  });

  it("passes the uri and line as command arguments", () => {
    const { doc } = activate(makeApi());
    const lens = lensProvider().provideCodeLenses(doc)[0];
    expect(lens.command.arguments[1]).toBe(0);
  });

  it("returns nothing when inline hints are switched off", () => {
    mock.__state.configuration.inlineHints = false;
    const { doc } = activate(makeApi());
    expect(lensProvider().provideCodeLenses(doc)).toEqual([]);
  });

  it("returns nothing for an unsupported language", () => {
    const { doc } = activate(makeApi(), "# notes", "markdown");
    expect(lensProvider().provideCodeLenses(doc)).toEqual([]);
  });

  it("shows a scan flag as its own lens", async () => {
    jest.useFakeTimers();
    const api = makeApi({ scanCode: jest.fn(async () => ({ flags: [flag()] })) });
    const { doc, editor } = activate(api);
    restCursor(editor);
    await runScheduledScan();
    const lenses = lensProvider().provideCodeLenses(doc);
    const titles = lenses.map((l: any) => l.command.title);
    expect(titles).toContain("🤔 What is the last index this reaches?");
    jest.useRealTimers();
  });

  it("uses the palette emoji for a style flag", async () => {
    jest.useFakeTimers();
    const api = makeApi({
      scanCode: jest.fn(async () => ({ flags: [flag({ kind: "style", severity: "info" })] })),
    });
    const { doc, editor } = activate(api);
    restCursor(editor);
    await runScheduledScan();
    const titles = lensProvider().provideCodeLenses(doc).map((l: any) => l.command.title);
    expect(titles.some((t: string) => t.startsWith("🎨"))).toBe(true);
    jest.useRealTimers();
  });

  it("never puts two lenses on the same line", async () => {
    jest.useFakeTimers();
    const api = makeApi({
      // Line 1 is the `def`, which would also match the definition regex.
      scanCode: jest.fn(async () => ({ flags: [flag({ line: 1, end_line: 1 })] })),
    });
    const { doc, editor } = activate(api);
    restCursor(editor);
    await runScheduledScan();
    const lines = lensProvider().provideCodeLenses(doc).map((l: any) => l.range.start.line);
    expect(new Set(lines).size).toBe(lines.length);
    jest.useRealTimers();
  });

  it("clamps a flag line past the end of the document", async () => {
    jest.useFakeTimers();
    const api = makeApi({
      scanCode: jest.fn(async () => ({ flags: [flag({ line: 999, end_line: 999 })] })),
    });
    const { doc, editor } = activate(api);
    restCursor(editor);
    await runScheduledScan();
    const lines = lensProvider().provideCodeLenses(doc).map((l: any) => l.range.start.line);
    expect(Math.max(...lines)).toBeLessThan(doc.lineCount);
    jest.useRealTimers();
  });
});

describe("provideCodeActions", () => {
  beforeEach(() => mock.__reset());

  it("always offers a nudge and an explanation", () => {
    const { doc } = activate(makeApi());
    const actions = actionProvider().provideCodeActions(doc, new vscode.Range(1, 0, 1, 0));
    expect(actions).toHaveLength(2);
    expect(actions[0].command.command).toBe("edupeer.nudgeLine");
    expect(actions[1].command.command).toBe("edupeer.explainSelection");
  });

  it("offers a third action on a flagged line", async () => {
    jest.useFakeTimers();
    const api = makeApi({ scanCode: jest.fn(async () => ({ flags: [flag()] })) });
    const { doc, editor } = activate(api);
    restCursor(editor);
    await runScheduledScan();
    const actions = actionProvider().provideCodeActions(doc, new vscode.Range(2, 0, 2, 0));
    expect(actions).toHaveLength(3);
    expect(actions[2].command.command).toBe("edupeer.discussLines");
    jest.useRealTimers();
  });

  it("passes the flag range and question to discussLines", async () => {
    jest.useFakeTimers();
    const api = makeApi({ scanCode: jest.fn(async () => ({ flags: [flag()] })) });
    const { doc, editor } = activate(api);
    restCursor(editor);
    await runScheduledScan();
    const actions = actionProvider().provideCodeActions(doc, new vscode.Range(2, 0, 2, 0));
    const args = actions[2].command.arguments;
    expect(args[1]).toBe(2);
    expect(args[2]).toBe(2);
    expect(args[3]).toBe("What is the last index this reaches?");
    jest.useRealTimers();
  });

  it("never returns an action that edits the code", () => {
    const { doc } = activate(makeApi());
    const actions = actionProvider().provideCodeActions(doc, new vscode.Range(1, 0, 1, 0));
    for (const action of actions) {
      expect(action.edit).toBeUndefined();
      expect(action.command).toBeDefined();
    }
  });

  it("returns nothing for an unsupported language", () => {
    const { doc } = activate(makeApi(), "# notes", "markdown");
    expect(actionProvider().provideCodeActions(doc, new vscode.Range(0, 0, 0, 0))).toEqual([]);
  });
});

describe("provideHover", () => {
  beforeEach(() => mock.__reset());

  it("returns nothing when there is no hint and no flag", () => {
    const { doc } = activate(makeApi());
    expect(hoverProvider().provideHover(doc, new vscode.Position(1, 0))).toBeUndefined();
  });

  it("shows the flag question and its concept", async () => {
    jest.useFakeTimers();
    const api = makeApi({ scanCode: jest.fn(async () => ({ flags: [flag()] })) });
    const { doc, editor } = activate(api);
    restCursor(editor);
    await runScheduledScan();
    const hover = hoverProvider().provideHover(doc, new vscode.Position(2, 0));
    expect(hover.contents.value).toContain("What is the last index this reaches?");
    expect(hover.contents.value).toContain("off-by-one");
    jest.useRealTimers();
  });

  it("allow-lists only EduPeer's own two commands", async () => {
    jest.useFakeTimers();
    const api = makeApi({ scanCode: jest.fn(async () => ({ flags: [flag()] })) });
    const { doc, editor } = activate(api);
    restCursor(editor);
    await runScheduledScan();
    const hover = hoverProvider().provideHover(doc, new vscode.Position(2, 0));
    expect(hover.contents.isTrusted).toEqual({
      enabledCommands: ["edupeer.nudgeLine", "edupeer.explainSelection"],
    });
    jest.useRealTimers();
  });

  it("never blanket-trusts the markdown", async () => {
    jest.useFakeTimers();
    const api = makeApi({ scanCode: jest.fn(async () => ({ flags: [flag()] })) });
    const { doc, editor } = activate(api);
    restCursor(editor);
    await runScheduledScan();
    const hover = hoverProvider().provideHover(doc, new vscode.Position(2, 0));
    expect(hover.contents.isTrusted).not.toBe(true);
    jest.useRealTimers();
  });

  it("returns nothing for an unsupported language", () => {
    const { doc } = activate(makeApi(), "# notes", "markdown");
    expect(hoverProvider().provideHover(doc, new vscode.Position(0, 0))).toBeUndefined();
  });
});

describe("scanning and diagnostics", () => {
  beforeEach(() => {
    mock.__reset();
    jest.useFakeTimers();
  });
  afterEach(() => jest.useRealTimers());

  it("publishes one diagnostic per flag", async () => {
    const api = makeApi({ scanCode: jest.fn(async () => ({ flags: [flag(), flag({ line: 4 })] })) });
    const { doc, editor } = activate(api);
    restCursor(editor);
    await runScheduledScan();
    expect(diagnostics().get(doc.uri)).toHaveLength(2);
  });

  it("maps warning flags to Warning and info flags to Information", async () => {
    const api = makeApi({
      scanCode: jest.fn(async () => ({
        flags: [flag({ severity: "warning" }), flag({ line: 4, severity: "info" })],
      })),
    });
    const { doc, editor } = activate(api);
    restCursor(editor);
    await runScheduledScan();
    const diags = diagnostics().get(doc.uri);
    expect(diags[0].severity).toBe(vscode.DiagnosticSeverity.Warning);
    expect(diags[1].severity).toBe(vscode.DiagnosticSeverity.Information);
  });

  it("labels the diagnostic source and carries the concept as its code", async () => {
    const api = makeApi({ scanCode: jest.fn(async () => ({ flags: [flag()] })) });
    const { doc, editor } = activate(api);
    restCursor(editor);
    await runScheduledScan();
    const diag = diagnostics().get(doc.uri)[0];
    expect(diag.source).toBe("EduPeer");
    expect(diag.code).toBe("off-by-one");
  });

  it("does not rescan unchanged code", async () => {
    const api = makeApi({ scanCode: jest.fn(async () => ({ flags: [] })) });
    const { doc, editor } = activate(api);
    // A real first scan has to land (and cache its fingerprint) before the
    // no-op edit below can prove anything about *not* repeating it.
    restCursor(editor);
    await runScheduledScan();
    mock.__state.listeners.textDocument.forEach((fn: any) =>
      fn({ document: doc, contentChanges: [] })
    );
    await runScheduledScan();
    expect(api.scanCode).toHaveBeenCalledTimes(1);
  });

  it("rescans when the command forces it", async () => {
    const api = makeApi({ scanCode: jest.fn(async () => ({ flags: [] })) });
    const { editor } = activate(api);
    restCursor(editor);
    await runScheduledScan();
    await mock.__runCommand("edupeer.scanFile");
    expect(api.scanCode).toHaveBeenCalledTimes(2);
  });

  it("skips the automatic scan when autoScan is off", async () => {
    mock.__state.configuration.autoScan = false;
    const api = makeApi();
    const { editor } = activate(api);
    // Without a trigger that would otherwise schedule a scan, "nothing
    // happened" would be true whether or not this setting works at all.
    restCursor(editor);
    await runScheduledScan();
    expect(api.scanCode).not.toHaveBeenCalled();
  });

  it("survives a scan failure without throwing", async () => {
    const api = makeApi({ scanCode: jest.fn(async () => { throw new Error("boom"); }) });
    const { editor } = activate(api);
    restCursor(editor);
    await expect(runScheduledScan()).resolves.toBeUndefined();
    // The rejection this test guards against would otherwise show up as an
    // unhandled promise rejection, not a failed assertion — so pin that the
    // scan this failure came from actually ran.
    expect(api.scanCode).toHaveBeenCalled();
  });

  it("goes quiet for the Retry-After window after a 429", async () => {
    const api = makeApi({
      scanCode: jest.fn(async () => { throw new RateLimitError(60); }),
    });
    const { doc, editor } = activate(api);
    restCursor(editor);
    await runScheduledScan();
    expect(api.scanCode).toHaveBeenCalledTimes(1);
    // A further edit inside the window must not schedule another scan.
    mock.__state.listeners.textDocument.forEach((fn: any) =>
      fn({ document: doc, contentChanges: [] })
    );
    await runScheduledScan();
    expect(api.scanCode).toHaveBeenCalledTimes(1);
  });

  it("tells the student when a flagged file becomes clean", async () => {
    let flags = [flag()];
    const api = makeApi({ scanCode: jest.fn(async () => ({ flags })) });
    const { editor } = activate(api);
    restCursor(editor);
    await runScheduledScan();
    flags = [];
    // The fingerprint is unchanged in this fixture, so force the rescan the
    // way `EduPeer: Scan This Block` does.
    await mock.__runCommand("edupeer.scanFile");
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining("scans clean now"),
      "Quiz me",
      "Not now"
    );
  });

  it("does not offer a quiz for a file that was never flagged", async () => {
    const api = makeApi({ scanCode: jest.fn(async () => ({ flags: [] })) });
    const { editor } = activate(api);
    restCursor(editor);
    await runScheduledScan();
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });
});

describe("line hints", () => {
  beforeEach(() => {
    mock.__reset();
    jest.useFakeTimers();
  });
  afterEach(() => jest.useRealTimers());

  it("asks the backend for the cursor line and renders it", async () => {
    const api = makeApi({
      getLineHint: jest.fn(async () => ({ hint: "Check the bound", concept: "off-by-one" })),
    });
    const { editor } = activate(api);
    await mock.__runCommand("edupeer.nudgeLine", editor.document.uri, 2);
    // Line 2 (0-based) sits inside `average`'s body (lines 0-4), so the
    // heuristic resolves the whole function as the focus block.
    const [digest, line, language, focus] = api.getLineHint.mock.calls[0];
    expect(digest.code).toBe(PY);
    expect(line).toBe(3);
    expect(language).toBe("python");
    expect(focus).toEqual({ start_line: 1, end_line: 5, label: "average" });
    const call = editor.setDecorations.mock.calls.at(-1);
    expect(call[1][0].renderOptions.after.contentText).toBe("💡 Check the bound");
  });

  it("falls back to a local rule when the backend is unreachable", async () => {
    const api = makeApi({
      isAvailable: false,
      getLineHint: jest.fn(async () => { throw new Error("ECONNREFUSED"); }),
    });
    const { editor } = activate(api);
    await mock.__runCommand("edupeer.nudgeLine", editor.document.uri, 2);
    const call = editor.setDecorations.mock.calls.at(-1);
    // Line 3 is `for i in range(len(numbers) + 1):`, which the Python rule
    // table answers with the positions-versus-items question.
    expect(call[1][0].renderOptions.after.contentText).toBe(
      "💡 Do you need the positions, or the items themselves?"
    );
  });

  it("keeps trying for a real hint after a local rule was cached, once the backend answers again", async () => {
    const getLineHint = jest
      .fn()
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValueOnce({ hint: "Check the bound", concept: "off-by-one" });
    const api = makeApi({ isAvailable: false, getLineHint });
    const { editor } = activate(api);

    // First ask: offline, falls back to the local rule (cached with `local: true`).
    await mock.__runCommand("edupeer.nudgeLine", editor.document.uri, 2);
    let call = editor.setDecorations.mock.calls.at(-1);
    expect(call[1][0].renderOptions.after.contentText).toBe(
      "💡 Do you need the positions, or the items themselves?"
    );

    // Backend comes back. The debounce path (unforced) must not be blocked by
    // the cached local rule — a placeholder must not outrank the real thing
    // it was standing in for.
    api.isAvailable = true;
    for (const listener of mock.__state.listeners.selection) {
      listener({ textEditor: editor });
    }
    await runScheduledScan();

    expect(getLineHint).toHaveBeenCalledTimes(2);
    call = editor.setDecorations.mock.calls.at(-1);
    expect(call[1][0].renderOptions.after.contentText).toBe("💡 Check the bound");
  });

  it("does not fall back to a local rule merely for being throttled", async () => {
    // Being rate-limited is not the same as being offline: the backend is
    // still reachable, so the student gets a retryable wait message (via the
    // lens's error state) rather than a downgraded local-rule guess.
    const api = makeApi({
      getLineHint: jest.fn(async () => { throw new RateLimitError(30); }),
    });
    const { doc, editor } = activate(api);
    await mock.__runCommand("edupeer.nudgeLine", editor.document.uri, 2);
    const call = editor.setDecorations.mock.calls.at(-1);
    expect(call[1]).toEqual([]);
    // A 429 must read as a 429, not merely as "some error": nothing here
    // distinguished this from a plain 500 until the lens said the wait time.
    const titles = lensProvider().provideCodeLenses(doc).map((l: any) => l.command.title);
    expect(titles).toContain("⚠️ Hint budget used up, back in 1m — click to retry");
  });

  it("shows nothing when the backend errors but is still reachable", async () => {
    const api = makeApi({
      getLineHint: jest.fn(async () => { throw new Error("500"); }),
    });
    const { editor } = activate(api);
    await mock.__runCommand("edupeer.nudgeLine", editor.document.uri, 2);
    const call = editor.setDecorations.mock.calls.at(-1);
    expect(call[1]).toEqual([]);
  });

  it("tells the student to open a supported file first", async () => {
    mock.__reset();
    const context = { subscriptions: [] as any[] } as any;
    const tutor = new InlineTutor(context, makeApi());
    tutor.activate();
    mock.window.activeTextEditor = undefined;
    await mock.__runCommand("edupeer.nudgeLine");
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining("open a supported file first")
    );
  });
});

describe("lensTitle", () => {
  it("shows the offer while idle", () => {
    expect(lensTitle({ kind: "idle" }, "💡 Ask EduPeer")).toBe("💡 Ask EduPeer");
  });

  it("shows that it is working the moment it is clicked", () => {
    expect(lensTitle({ kind: "loading" }, "💡 Ask EduPeer")).toBe("⏳ EduPeer is thinking…");
  });

  it("shows the hint once it arrives", () => {
    expect(lensTitle({ kind: "ready", hint: "what if n is empty?" }, "💡 Ask EduPeer")).toBe(
      "💡 what if n is empty?"
    );
  });

  it("says so when there is nothing to say", () => {
    expect(lensTitle({ kind: "empty" }, "💡 Ask EduPeer")).toBe(
      "✓ Nothing to flag on this line"
    );
  });

  it("offers a retry on failure", () => {
    expect(
      lensTitle({ kind: "error", reason: "llm", message: "The tutor couldn't answer that" }, "x")
    ).toBe("⚠️ The tutor couldn't answer that — click to retry");
  });

  it("sends an unauthenticated student to sign in, not to retry", () => {
    expect(
      lensTitle({ kind: "error", reason: "auth", message: "Sign in to get hints" }, "x")
    ).toBe("⚠️ Sign in to get hints — click to sign in");
  });
});

describe("errorStateFor", () => {
  it("names a broken sign-in", () => {
    const state = errorStateFor(new AuthError("no token", 401), true);
    expect(state).toMatchObject({ kind: "error", reason: "auth" });
  });

  it("names throttling and says how long", () => {
    const state = errorStateFor(new RateLimitError(120), true);
    expect(state).toMatchObject({ kind: "error", reason: "rate-limit" });
    expect(state.kind === "error" && state.message).toContain("2m");
  });

  it("names an unreachable backend before it names anything else", () => {
    const state = errorStateFor(new Error("fetch failed"), false);
    expect(state).toMatchObject({ kind: "error", reason: "offline" });
  });

  it("names an LLM failure from the backend's 502", () => {
    const state = errorStateFor(new Error("line-hint failed (502)"), true);
    expect(state).toMatchObject({ kind: "error", reason: "llm" });
  });

  it("still produces a state for something it has never seen", () => {
    const state = errorStateFor(new Error("kaboom"), true);
    expect(state).toMatchObject({ kind: "error", reason: "unknown" });
    expect(state.kind === "error" && state.message.length).toBeGreaterThan(0);
  });
});

describe("InlineTutor — the lens is the feedback channel", () => {
  const vscode = require("vscode");

  const SOURCE = ["def f(n):", "    return 1 / n", "", "def g():", "    return f(0)"].join("\n");

  /**
   * `path` is a parameter because `resolveFocus` memoises on
   * uri + version + cursor and is never reset between tests (see focusScope.ts),
   * so a test that needs its own answer has to ask under its own uri.
   */
  function setup(api: any, path = "/tmp/demo.py") {
    vscode.__reset();
    vscode.__state.configuration = { inlineHints: true, lensMode: "all", autoScan: false };
    const doc = vscode.__makeDocument(SOURCE, "python", path);
    const editor = vscode.__makeEditor(doc, 1, 0);
    vscode.window.activeTextEditor = editor;
    vscode.window.visibleTextEditors = [editor];
    const thinking: boolean[] = [];
    const tutor = new (require("../inlineTutor").InlineTutor)(
      { subscriptions: [] },
      api,
      (value: boolean) => thinking.push(value)
    );
    tutor.activate();
    // Disposed by the file's top-level afterEach, like every other tutor this
    // file creates — otherwise a debounce timer scheduled by a textDocument
    // edit (see "clears the hint...") outlives the test that started it.
    live.push(tutor);
    return { tutor, doc, editor, thinking };
  }

  function lensTitles(doc: any) {
    const { provider } = vscode.__state.codeLensProviders[0];
    return provider.provideCodeLenses(doc).map((lens: any) => lens.command.title);
  }

  it("flips the lens to loading before the request resolves", async () => {
    let release: (value: any) => void = () => {};
    const api = {
      isAvailable: true,
      getLineHint: jest.fn(() => new Promise((resolve) => (release = resolve))),
    };
    const { doc, thinking } = setup(api);

    const pending = vscode.__runCommand("edupeer.nudgeLine", doc.uri, 1);

    // Zero ticks: the lens must have flipped before anything was awaited.
    // Flushing first would let a `showState` moved after `await resolveFocus`
    // pass just as easily, which is the regression this test exists to catch.
    expect(lensTitles(doc)).toContain("⏳ EduPeer is thinking…");
    expect(thinking[0]).toBe(true);

    // fetchLineHint now awaits resolveFocus() before calling getLineHint,
    // which adds a few more microtask hops (it awaits the document-symbol
    // provider) — flush enough ticks that getLineHint has actually been
    // invoked and `release` rebound to its real resolver before calling it.
    for (let i = 0; i < 10; i++) await Promise.resolve();

    release({ hint: "what is n here?", concept: "division" });
    await pending;

    expect(lensTitles(doc)).toContain("💡 what is n here?");
    expect(thinking[thinking.length - 1]).toBe(false);
  });

  it("shows a retryable error instead of nothing when the call fails", async () => {
    const api = {
      isAvailable: true,
      getLineHint: jest.fn().mockRejectedValue(new Error("line-hint failed (502)")),
    };
    const { doc } = setup(api);

    await vscode.__runCommand("edupeer.nudgeLine", doc.uri, 1);

    expect(lensTitles(doc)).toContain("⚠️ The tutor couldn't answer that — click to retry");
  });

  it("shows the empty state when the model has nothing to say", async () => {
    const api = {
      isAvailable: true,
      getLineHint: jest.fn().mockResolvedValue({ hint: "", concept: "general" }),
    };
    const { doc } = setup(api);

    await vscode.__runCommand("edupeer.nudgeLine", doc.uri, 1);

    expect(lensTitles(doc)).toContain("✓ Nothing to flag on this line");
  });

  it("offers rather than accuses on definition lines", () => {
    const { doc } = setup({ isAvailable: true, getLineHint: jest.fn() });

    const titles = lensTitles(doc);
    expect(titles).toContain("💡 Ask EduPeer");
    expect(titles.join(" ")).not.toContain("Get a hint");
  });

  it("hides the offer lenses when lensMode is flagged", () => {
    const { doc } = setup({ isAvailable: true, getLineHint: jest.fn() });
    vscode.__state.configuration.lensMode = "flagged";

    expect(lensTitles(doc)).toEqual([]);
  });

  it("shows the state on a nudged line even when lensMode hides the offers", async () => {
    const api = {
      isAvailable: true,
      getLineHint: jest.fn().mockResolvedValue({ hint: "what is n here?", concept: "division" }),
    };
    const { doc } = setup(api);
    vscode.__state.configuration.lensMode = "flagged";

    await vscode.__runCommand("edupeer.nudgeLine", doc.uri, 1);

    // Line 1 is neither a definition nor flagged. The student asked anyway.
    expect(lensTitles(doc)).toContain("💡 what is n here?");
  });

  it("does not paint a lens for an unsolicited hint, but still updates the ghost text", async () => {
    jest.useFakeTimers();
    const api = {
      isAvailable: true,
      getLineHint: jest.fn().mockResolvedValue({ hint: "what is n here?", concept: "division" }),
    };
    const { doc, editor } = setup(api);
    vscode.__state.configuration.lensMode = "flagged";

    // Resting the cursor (no click, no keybinding) drives the debounce path,
    // not `nudgeLine` — this must never paint text the student didn't ask for.
    for (const listener of vscode.__state.listeners.selection) {
      listener({ textEditor: editor });
    }
    jest.advanceTimersByTime(4000);
    for (let i = 0; i < 12; i++) await Promise.resolve();

    expect(lensTitles(doc)).toEqual([]);
    const call = editor.setDecorations.mock.calls.at(-1);
    expect(call[1][0].renderOptions.after.contentText).toBe("💡 what is n here?");
    jest.useRealTimers();
  });

  it("clears the hint when the student edits that line", async () => {
    const api = {
      isAvailable: true,
      getLineHint: jest.fn().mockResolvedValue({ hint: "what is n here?", concept: "division" }),
    };
    const { doc } = setup(api);
    await vscode.__runCommand("edupeer.nudgeLine", doc.uri, 1);
    expect(lensTitles(doc)).toContain("💡 what is n here?");

    for (const listener of vscode.__state.listeners.textDocument) {
      listener({
        document: doc,
        contentChanges: [{ range: new vscode.Range(1, 4, 1, 18), text: "return 0" }],
      });
    }

    expect(lensTitles(doc).join(" ")).not.toContain("what is n here?");
  });

  it("clears the hint when dismissed", async () => {
    const api = {
      isAvailable: true,
      getLineHint: jest.fn().mockResolvedValue({ hint: "what is n here?", concept: "division" }),
    };
    const { doc, editor } = setup(api);
    await vscode.__runCommand("edupeer.nudgeLine", doc.uri, 1);
    expect(lensTitles(doc)).toContain("💡 what is n here?");
    expect(editor.setDecorations.mock.calls.at(-1)[1]).not.toEqual([]);

    await vscode.__runCommand("edupeer.dismissLine", doc.uri, 1);

    expect(lensTitles(doc).join(" ")).not.toContain("what is n here?");
    expect(editor.setDecorations.mock.calls.at(-1)[1]).toEqual([]);
  });

  it("hands off to the conversation when the student goes deeper", async () => {
    const api = {
      isAvailable: true,
      getLineHint: jest.fn().mockResolvedValue({ hint: "what is n here?", concept: "division" }),
    };
    const { doc } = setup(api);
    await vscode.__runCommand("edupeer.nudgeLine", doc.uri, 1);

    await vscode.__runCommand("edupeer.deepenLine", doc.uri, 1);

    // Pins the 0-based line convention: `line` flows straight through to
    // discussLines, not the 1-based wire form.
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "edupeer.discussLines",
      doc.uri,
      1,
      1,
      "what is n here?"
    );
  });

  it("clears the ghost text when the model has nothing to say after all", async () => {
    const getLineHint = jest
      .fn()
      .mockResolvedValueOnce({ hint: "what is n here?", concept: "division" })
      .mockResolvedValueOnce({ hint: "", concept: "general" });
    const { doc, editor } = setup({ isAvailable: true, getLineHint }, "/tmp/empty-ghost/demo.py");

    await vscode.__runCommand("edupeer.nudgeLine", doc.uri, 1);
    expect(editor.setDecorations.mock.calls.at(-1)[1][0].renderOptions.after.contentText).toBe(
      "💡 what is n here?"
    );

    await vscode.__runCommand("edupeer.nudgeLine", doc.uri, 1);

    // Spec A4: a lens reading "nothing to flag" beside ghost text still
    // describing the line is the two surfaces disagreeing.
    expect(lensTitles(doc)).toContain("✓ Nothing to flag on this line");
    expect(editor.setDecorations.mock.calls.at(-1)[1]).toEqual([]);
  });

  it("says the tutor is thinking in the hover, not just in the lens", async () => {
    let release: (value: any) => void = () => {};
    const api = {
      isAvailable: true,
      getLineHint: jest.fn(() => new Promise((resolve) => (release = resolve))),
    };
    const { doc } = setup(api, "/tmp/hover-loading/demo.py");

    const pending = vscode.__runCommand("edupeer.nudgeLine", doc.uri, 1);
    for (let i = 0; i < 10; i++) await Promise.resolve();

    expect(hoverProvider().provideHover(doc, new vscode.Position(1, 0)).contents.value).toContain(
      "⏳ EduPeer is thinking…"
    );

    release({ hint: "what is n here?", concept: "division" });
    await pending;

    expect(hoverProvider().provideHover(doc, new vscode.Position(1, 0)).contents.value).toContain(
      "💡 what is n here?"
    );
  });

  it("reports a failure in the hover instead of returning nothing", async () => {
    const api = {
      isAvailable: true,
      getLineHint: jest.fn().mockRejectedValue(new Error("line-hint failed (502)")),
    };
    const { doc } = setup(api, "/tmp/hover-error/demo.py");

    await vscode.__runCommand("edupeer.nudgeLine", doc.uri, 1);

    const value = hoverProvider().provideHover(doc, new vscode.Position(1, 0)).contents.value;
    expect(value).toContain("⚠️ The tutor couldn't answer that");
    // The lens's trailing action clause does not belong here: the hover has
    // nothing to click.
    expect(value).not.toContain("click to retry");
  });

  it("never offers the hover a sign-in click it cannot deliver", async () => {
    const api = {
      isAvailable: true,
      getLineHint: jest.fn().mockRejectedValue(new AuthError("no token", 401)),
    };
    const { doc } = setup(api, "/tmp/hover-auth/demo.py");

    await vscode.__runCommand("edupeer.nudgeLine", doc.uri, 1);

    const hover = hoverProvider().provideHover(doc, new vscode.Position(1, 0));
    expect(hover.contents.value).toContain("⚠️ Sign in to get hints");
    expect(hover.contents.value).not.toContain("click to sign in");
    // Widening the allow-list to make that clause true would widen it for the
    // model-authored text appended below it as well.
    expect(hover.contents.isTrusted).toEqual({
      enabledCommands: ["edupeer.nudgeLine", "edupeer.explainSelection"],
    });
    // The lens is where the action lives, and it is unchanged.
    expect(lensTitles(doc)).toContain("⚠️ Sign in to get hints — click to sign in");
  });

  it("asks about the student's live selection, the same block the panel resolves", async () => {
    jest.useFakeTimers();
    const api = {
      isAvailable: true,
      getLineHint: jest.fn().mockResolvedValue({ hint: "h", concept: "general" }),
    };
    const { editor } = setup(api, "/tmp/live-selection/demo.py");
    // Lines 3-4 dragged out, cursor at the end of line 4. Without this the
    // lens resolves `def g():` by the heuristic while the sidebar, which sees
    // the same selection, resolves the selection.
    editor.selection = new vscode.Selection(new vscode.Position(3, 0), new vscode.Position(4, 15));

    for (const listener of vscode.__state.listeners.selection) {
      listener({ textEditor: editor });
    }
    jest.advanceTimersByTime(2000);
    for (let i = 0; i < 12; i++) await Promise.resolve();

    expect(api.getLineHint).toHaveBeenCalledWith(
      expect.objectContaining({ code: expect.any(String) }),
      5,
      "python",
      { start_line: 4, end_line: 5, label: "selection" }
    );
    jest.useRealTimers();
  });

  /**
   * `fetchLineHint` captures its line, then awaits `resolveFocus` and the API
   * for several seconds. `applyChanges` runs on every keystroke in between and
   * moves or destroys the very entries the answer is about, so writing back at
   * the captured index puts a hint on code it was never about.
   */
  describe("InlineTutor — a stale line hint never writes back", () => {
    /** An API whose replies are released by the test, one resolver per call. */
    function pendingApi() {
      const releases: Array<(value: any) => void> = [];
      const api = {
        isAvailable: true,
        getLineHint: jest.fn(
          () => new Promise((resolve) => releases.push(resolve as (value: any) => void))
        ),
      };
      return { api, releases };
    }

    /** Enough hops for `resolveFocus` to settle and `getLineHint` to be called. */
    async function flush() {
      for (let i = 0; i < 10; i++) await Promise.resolve();
    }

    function edit(doc: any, contentChanges: any[]) {
      for (const listener of vscode.__state.listeners.textDocument) {
        listener({ document: doc, contentChanges });
      }
    }

    it("drops a hint whose line moved under it while the request was in flight", async () => {
      const { api, releases } = pendingApi();
      const { doc, editor } = setup(api, "/tmp/stale-shift/demo.py");

      const pending = vscode.__runCommand("edupeer.nudgeLine", doc.uri, 4);
      await flush();

      // The student presses Enter at the top of the file. `applyChanges`
      // correctly slides the loading state down to line 5; line 4 now belongs
      // to code the tutor was never asked about.
      edit(doc, [{ range: new vscode.Range(0, 0, 0, 0), text: "\n" }]);

      releases[0]({ hint: "what does f(0) return?", concept: "division" });
      await pending;

      expect(lensTitles(doc).join(" ")).not.toContain("what does f(0) return?");
      expect(editor.setDecorations.mock.calls.at(-1)[1]).toEqual([]);
    });

    it("does not resurrect an annotation the student's own edit dropped", async () => {
      const { api, releases } = pendingApi();
      const { doc, editor } = setup(api, "/tmp/stale-edit/demo.py");

      const pending = vscode.__runCommand("edupeer.nudgeLine", doc.uri, 1);
      await flush();

      // The student fixes the line while the tutor is still thinking about it.
      // `applyChanges` drops the flag, the hint and the state — and the reply
      // must not put any of them back.
      edit(doc, [{ range: new vscode.Range(1, 4, 1, 18), text: "return 0" }]);
      expect(lensTitles(doc)).not.toContain("⏳ EduPeer is thinking…");

      releases[0]({ hint: "what is n here?", concept: "division" });
      await pending;

      expect(lensTitles(doc).join(" ")).not.toContain("what is n here?");
      expect(editor.setDecorations.mock.calls.at(-1)[1]).toEqual([]);
    });

    it("never strands a ⏳ lens that nothing will ever resolve", async () => {
      const { api, releases } = pendingApi();
      const { doc } = setup(api, "/tmp/stale-below/demo.py");

      const pending = vscode.__runCommand("edupeer.nudgeLine", doc.uri, 1);
      await flush();
      expect(lensTitles(doc)).toContain("⏳ EduPeer is thinking…");

      // An edit BELOW the line. `applyChanges` correctly leaves the loading
      // state exactly where it was — but the revision guard is store-wide, so
      // the answer it is waiting for is dropped all the same. The lens has to
      // go with it, or it waits forever while the status bar spinner clears.
      edit(doc, [{ range: new vscode.Range(3, 0, 3, 0), text: "\n" }]);

      releases[0]({ hint: "what is n here?", concept: "division" });
      await pending;

      expect(lensTitles(doc)).not.toContain("⏳ EduPeer is thinking…");
      expect(lensTitles(doc).join(" ")).not.toContain("what is n here?");
    });

    it("does not undo a dismissal with an unforced reply that was already in flight", async () => {
      jest.useFakeTimers();
      const { api, releases } = pendingApi();
      const { doc, editor } = setup(api, "/tmp/stale-dismiss/demo.py");

      // The click...
      const forced = vscode.__runCommand("edupeer.nudgeLine", doc.uri, 1);
      await flush();

      // ...and the cursor resting on the same line, which drives the unforced
      // debounce path as well. Nothing is cached yet, so it asks too.
      for (const listener of vscode.__state.listeners.selection) {
        listener({ textEditor: editor });
      }
      jest.advanceTimersByTime(2000);
      await flush();
      expect(api.getLineHint).toHaveBeenCalledTimes(2);

      releases[0]({ hint: "what is n here?", concept: "division" });
      await forced;
      expect(lensTitles(doc)).toContain("💡 what is n here?");

      // ✕ — `clearLine` wipes the hint and the lens state.
      await vscode.__runCommand("edupeer.dismissLine", doc.uri, 1);
      expect(editor.setDecorations.mock.calls.at(-1)[1]).toEqual([]);

      releases[1]({ hint: "what is n here?", concept: "division" });
      await flush();

      expect(editor.setDecorations.mock.calls.at(-1)[1]).toEqual([]);
      expect(hoverProvider().provideHover(doc, new vscode.Position(1, 0))).toBeUndefined();
      jest.useRealTimers();
    });
  });

  describe("InlineTutor — line hints carry the focus block", () => {
    it("sends the enclosing block's 1-based span with the line hint", async () => {
      const api = {
        isAvailable: true,
        getLineHint: jest.fn().mockResolvedValue({ hint: "h", concept: "division" }),
      };
      const { doc } = setup(api);
      vscode.commands.executeCommand.mockResolvedValue(undefined); // heuristic path

      await vscode.__runCommand("edupeer.nudgeLine", doc.uri, 1);

      const [digest, line, language, focus] = api.getLineHint.mock.calls[0];
      expect(digest.code).toBe(doc.getText());
      expect(line).toBe(2);
      expect(language).toBe("python");
      expect(focus).toEqual({ start_line: 1, end_line: 2, label: "f" });
    });
  });
});

describe("InlineTutor — stripping fixed bug markers", () => {
  const MARKED = [
    "def average(numbers):",
    "    total = 0",
    "    for i in range(1, len(numbers)):   # bug: off-by-one, skips the first item",
    "    return total / len(numbers)",
  ].join("\n");

  const CODE_ON_MARKED_LINE = "    for i in range(1, len(numbers)):";

  const tutors: any[] = [];
  afterEach(() => {
    while (tutors.length) tutors.pop().dispose();
  });

  function setupMarked(api: any, config: Record<string, any> = {}, source = MARKED) {
    mock.__reset();
    mock.__state.configuration = {
      inlineHints: true,
      lensMode: "all",
      autoScan: false,
      ...config,
    };
    const doc = mock.__makeDocument(source, "python", "/tmp/marked.py");
    const editor = mock.__makeEditor(doc, 2, 0);
    mock.window.activeTextEditor = editor;
    mock.window.visibleTextEditors = [editor];
    const tutor = new InlineTutor({ subscriptions: [] } as any, api);
    tutor.activate();
    tutors.push(tutor);
    return { tutor, doc };
  }

  /** One scan that flags, then one that comes back clean. */
  function flaggedThenClean() {
    return jest
      .fn()
      .mockResolvedValueOnce({ flags: [flag({ line: 3, end_line: 3 })] })
      .mockResolvedValueOnce({ flags: [] });
  }

  it("removes the marker once the file scans clean, keeping the code", async () => {
    const { doc } = setupMarked(makeApi({ scanCode: flaggedThenClean() }));

    await mock.__runCommand("edupeer.scanFile");
    await mock.__runCommand("edupeer.scanFile");

    expect(mock.workspace.applyEdit).toHaveBeenCalledTimes(1);
    const [edit] = mock.__state.appliedEdits;
    expect(edit.deletions).toHaveLength(1);
    const { range, uri } = edit.deletions[0];
    expect(uri).toBe(String(doc.uri));
    expect(range.start.line).toBe(2);
    expect(range.start.character).toBe(CODE_ON_MARKED_LINE.length);
    expect(range.end.character).toBe(MARKED.split("\n")[2].length);
  });

  it("does nothing while the file is still flagged", async () => {
    setupMarked(makeApi({ scanCode: jest.fn(async () => ({ flags: [flag()] })) }));

    await mock.__runCommand("edupeer.scanFile");
    await mock.__runCommand("edupeer.scanFile");

    expect(mock.workspace.applyEdit).not.toHaveBeenCalled();
  });

  it("does nothing when the setting is off", async () => {
    setupMarked(makeApi({ scanCode: flaggedThenClean() }), {
      removeFixedBugComments: false,
    });

    await mock.__runCommand("edupeer.scanFile");
    await mock.__runCommand("edupeer.scanFile");

    expect(mock.workspace.applyEdit).not.toHaveBeenCalled();
  });

  it("does nothing when the file has no marker", async () => {
    setupMarked(
      makeApi({ scanCode: flaggedThenClean() }),
      {},
      "def average(numbers):\n    return sum(numbers) / len(numbers)\n"
    );

    await mock.__runCommand("edupeer.scanFile");
    await mock.__runCommand("edupeer.scanFile");

    expect(mock.workspace.applyEdit).not.toHaveBeenCalled();
  });

  it("leaves prose that merely mentions a bug alone", async () => {
    setupMarked(
      makeApi({ scanCode: flaggedThenClean() }),
      {},
      "def f():\n    # Off-by-one style bug: index 4 does not exist\n    return 1\n"
    );

    await mock.__runCommand("edupeer.scanFile");
    await mock.__runCommand("edupeer.scanFile");

    expect(mock.workspace.applyEdit).not.toHaveBeenCalled();
  });

  it("runs ahead of the reflection gate, not behind it", async () => {
    // The reflection quiz is offered once per fingerprint. Stripping must not
    // inherit that gate: the marker describes fixed code either way.
    const scanCode = jest
      .fn()
      .mockResolvedValueOnce({ flags: [flag({ line: 3, end_line: 3 })] })
      .mockResolvedValueOnce({ flags: [] })
      .mockResolvedValueOnce({ flags: [flag({ line: 3, end_line: 3 })] })
      .mockResolvedValueOnce({ flags: [] });
    setupMarked(makeApi({ scanCode }));

    for (let i = 0; i < 4; i++) await mock.__runCommand("edupeer.scanFile");

    expect(mock.workspace.applyEdit).toHaveBeenCalledTimes(2);
    expect(mock.window.showInformationMessage).toHaveBeenCalledTimes(1);
  });

  it("announces the clean scan exactly once per transition", async () => {
    const api = makeApi({ scanCode: flaggedThenClean() });
    const { tutor } = setupMarked(api);
    let announced = 0;
    tutor.onDidScanClean(() => announced++);

    await mock.__runCommand("edupeer.scanFile");
    expect(announced).toBe(0); // still flagged

    await mock.__runCommand("edupeer.scanFile");
    expect(announced).toBe(1);
  });
});

describe("InlineTutor — the seeded marker never reaches the tutor", () => {
  const MARKED = [
    "def add(a, b):",
    "    return a + b          # bug: subtracts instead of adds",
  ].join("\n");

  const tutors: any[] = [];
  afterEach(() => {
    while (tutors.length) tutors.pop().dispose();
  });

  function setup(api: any, source = MARKED) {
    mock.__reset();
    mock.__state.configuration = { inlineHints: true, lensMode: "all", autoScan: false };
    const doc = mock.__makeDocument(source, "python", "/tmp/seeded.py");
    const editor = mock.__makeEditor(doc, 1, 0);
    mock.window.activeTextEditor = editor;
    mock.window.visibleTextEditors = [editor];
    const tutor = new InlineTutor({ subscriptions: [] } as any, api);
    tutor.activate();
    tutors.push(tutor);
    return { tutor, doc };
  }

  it("keeps the marker out of the scan request but leaves the buffer alone", async () => {
    const api = makeApi();
    const { doc } = setup(api);

    await mock.__runCommand("edupeer.scanFile");

    const sent = api.scanCode.mock.calls[0][0];
    expect(sent.code).not.toContain("bug:");
    expect(sent.code).toContain("return a + b");
    // Line numbers come back 1-based against this text, so blanking a marker
    // must never change how many lines there are.
    expect(sent.code.split("\n")).toHaveLength(doc.getText().split("\n").length);
    expect(doc.getText()).toContain("# bug: subtracts instead of adds");
  });

  it("keeps the marker out of the line-hint request", async () => {
    const api = makeApi();
    const { doc } = setup(api);

    await mock.__runCommand("edupeer.nudgeLine", doc.uri, 1);

    const sent = api.getLineHint.mock.calls[0][0];
    expect(sent.code).not.toContain("bug:");
    expect(sent.code).toContain("return a + b");
  });

  it("lets a fixed file scan clean instead of the marker keeping it flagged", async () => {
    // Stands in for the real reviewer, which reads the comment and believes
    // it. While the marker was on the wire this file could never scan clean,
    // and the removal that needed a clean scan could therefore never fire.
    const scanCode = jest.fn(async (digest: { code: string }) => ({
      flags:
        digest.code.includes("bug:") || digest.code.includes("a - b")
          ? [flag({ line: 2, end_line: 2 })]
          : [],
    }));
    const api = makeApi({ scanCode });
    const { doc } = setup(api, MARKED.replace("a + b", "a - b"));

    await mock.__runCommand("edupeer.scanFile");
    expect(mock.workspace.applyEdit).not.toHaveBeenCalled(); // genuinely buggy

    doc.__setText(MARKED); // the student fixes the operator
    await mock.__runCommand("edupeer.scanFile");

    expect(mock.workspace.applyEdit).toHaveBeenCalledTimes(1);
  });
});

describe("the inline surface works on one block", () => {
  let api: any;

  beforeEach(() => {
    mock.__reset();
    jest.useFakeTimers();
    api = makeApi();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  /** Open a document as the active editor and stand up a tutor for it. */
  function openDocument(text: string, languageId = "python") {
    const doc = mock.__makeDocument(text, languageId);
    const editor = mock.__makeEditor(doc, 0, 0);
    mock.window.activeTextEditor = editor;
    mock.window.visibleTextEditors = [editor];
    const newTutor = new InlineTutor({ subscriptions: [] } as any, api);
    newTutor.activate();
    live.push(newTutor);
    return doc;
  }

  /** Move the active editor's cursor to `line` (0-based), an empty selection. */
  function placeCursorOn(doc: any, line: number) {
    const editor =
      mock.window.visibleTextEditors.find((e: any) => e.document === doc) ??
      mock.window.activeTextEditor;
    const pos = new vscode.Position(line, 0);
    editor.selection = new vscode.Selection(pos, pos);
  }

  /**
   * Trigger the same (unforced) scan path a resting cursor does, and let it
   * settle. Re-fires the selection hook — the trigger a resting cursor now
   * goes through — rather than `edupeer.scanFile`, which always forces and
   * would bypass the very fingerprint de-dupe these tests are checking.
   */
  async function runScanNow() {
    const editor = mock.window.activeTextEditor;
    mock.__state.listeners.selection.forEach((fn: any) => fn({ textEditor: editor }));
    await runScheduledScan();
  }

  it("sends a digest to the scan, not the file", async () => {
    const doc = openDocument(LONG_PYTHON_FILE, "python");
    placeCursorOn(doc, 199);
    await runScanNow();
    const [digest] = api.scanCode.mock.calls[0];
    expect(digest.code).not.toContain("line_10 = 10");
    expect(digest.code).toContain("import math");
    expect(digest.bands.length).toBeGreaterThan(1);
  });

  it("tells the scan which block it is reviewing", async () => {
    const doc = openDocument(LONG_PYTHON_FILE, "python");
    placeCursorOn(doc, 199);
    await runScanNow();
    const [, , focus] = api.scanCode.mock.calls[0];
    expect(focus.start_line).toBeLessThanOrEqual(200);
    expect(focus.end_line).toBeGreaterThanOrEqual(200);
  });

  it("drops a flag the backend returned outside the block", async () => {
    // Defence in depth: the model should not have been able to see line 3.
    api.scanCode.mockResolvedValue({
      flags: [{ line: 3, end_line: 3, question: "Why?", concept: "general",
                severity: "info", kind: "bug" }],
    });
    const doc = openDocument(LONG_PYTHON_FILE, "python");
    placeCursorOn(doc, 199);
    await runScanNow();
    // `applyFlagsToDoc` publishes the store's flags as diagnostics after every
    // successful scan, so this is an existing seam onto the store — no
    // dedicated test-only accessor needed.
    expect(diagnostics().get(doc.uri)).toEqual([]);
  });

  it("keeps a flag exactly on the block's boundary and drops one just outside it", async () => {
    // Focus for line 200 (1-based) is {start_line: 200, end_line: 201} (see
    // the "tells the scan which block it is reviewing" test above). A flag
    // one line before or after that is out of the digest entirely and must
    // be dropped; a flag exactly on either edge is still within the block
    // that was scanned and must survive. Line 3's fixture already pins the
    // "obviously outside" case — this pins the off-by-one at both edges.
    api.scanCode.mockResolvedValue({
      flags: [
        { line: 199, end_line: 199, question: "just before", concept: "general",
          severity: "info", kind: "bug" },
        { line: 202, end_line: 202, question: "just after", concept: "general",
          severity: "info", kind: "bug" },
        { line: 200, end_line: 200, question: "on start", concept: "general",
          severity: "info", kind: "bug" },
        { line: 201, end_line: 201, question: "on end", concept: "general",
          severity: "info", kind: "bug" },
      ],
    });
    const doc = openDocument(LONG_PYTHON_FILE, "python");
    placeCursorOn(doc, 199);
    await runScanNow();
    const questions = diagnostics()
      .get(doc.uri)
      .map((d: any) => d.message);
    expect(questions.some((q: string) => q.includes("just before"))).toBe(false);
    expect(questions.some((q: string) => q.includes("just after"))).toBe(false);
    expect(questions.some((q: string) => q.includes("on start"))).toBe(true);
    expect(questions.some((q: string) => q.includes("on end"))).toBe(true);
  });

  it("sends a digest to the line hint too", async () => {
    const doc = openDocument(LONG_PYTHON_FILE, "python");
    placeCursorOn(doc, 199);
    await mock.__runCommand("edupeer.nudgeLine");
    const [digest, line] = api.getLineHint.mock.calls[0];
    expect(line).toBe(200);
    expect(digest.totalLines).toBe(LONG_PYTHON_FILE.split("\n").length);
    expect(digest.code).not.toContain("line_10 = 10");
  });

  it("scans a block once per version of its own text", async () => {
    const doc = openDocument(LONG_PYTHON_FILE, "python");
    placeCursorOn(doc, 199);
    await runScanNow();
    placeCursorOn(doc, 200);
    await runScanNow();
    expect(api.scanCode).toHaveBeenCalledTimes(1);
  });

  it("scans a second block on its own fingerprint", async () => {
    const doc = openDocument(LONG_PYTHON_FILE, "python");
    placeCursorOn(doc, 199);
    await runScanNow();
    placeCursorOn(doc, 20);
    await runScanNow();
    expect(api.scanCode).toHaveBeenCalledTimes(2);
  });

  it("does not repaint a stale editor when the active tab changes mid-scan", async () => {
    // `runScan` captures `editor` before two awaits (`resolveFocus`, then
    // `scanCode`). If it trusted that reference at the end, switching tabs
    // while the scan is in flight would make it paint ghost text onto an
    // editor that is no longer active, and — because
    // `renderActiveLineDecoration` clears the decoration on every *other*
    // visible editor — wipe it from the tab the student is actually looking
    // at as a side effect.
    let resolveScan: (value: any) => void = () => {};
    api.scanCode = jest.fn(() => new Promise((resolve) => (resolveScan = resolve)));
    const doc = openDocument(LONG_PYTHON_FILE, "python");
    placeCursorOn(doc, 199);
    const originalEditor = mock.window.activeTextEditor;

    await runScanNow();
    // Past `resolveFocus` and into the (still-pending) `scanCode` call.
    expect(api.scanCode).toHaveBeenCalledTimes(1);
    const originalCallsBeforeSwitch = originalEditor.setDecorations.mock.calls.length;

    // The student switches to a different file while the scan is still running.
    const otherDoc = mock.__makeDocument("x = 1\n", "python", "/tmp/other.py");
    const otherEditor = mock.__makeEditor(otherDoc, 0, 0);
    mock.window.activeTextEditor = otherEditor;
    mock.window.visibleTextEditors = [otherEditor];

    resolveScan({ flags: [] });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // The scan was for the tab the student has since left: it must not
    // repaint that now-inactive editor, and it must not touch the one now
    // on screen (which it would, to clear it, if it still held the stale
    // reference and treated the new editor as "some other visible editor").
    expect(originalEditor.setDecorations.mock.calls.length).toBe(originalCallsBeforeSwitch);
    expect(otherEditor.setDecorations).not.toHaveBeenCalled();
  });
});

describe("the tutor waits until the student is working on something", () => {
  let api: any;

  beforeEach(() => {
    mock.__reset();
    jest.useFakeTimers();
    api = makeApi();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  /** Open a document as the active editor and stand up an activated tutor for it. */
  function openDocument(text: string, languageId = "python") {
    const doc = mock.__makeDocument(text, languageId);
    const editor = mock.__makeEditor(doc, 0, 0);
    mock.window.activeTextEditor = editor;
    mock.window.visibleTextEditors = [editor];
    const newTutor = new InlineTutor({ subscriptions: [] } as any, api);
    newTutor.activate();
    live.push(newTutor);
    return doc;
  }

  /** Move the active editor's cursor to `line` (0-based), an empty selection. */
  function placeCursorOn(doc: any, line: number) {
    const editor = mock.window.activeTextEditor;
    const pos = new vscode.Position(line, 0);
    editor.selection = new vscode.Selection(pos, pos);
  }

  it("scans nothing when the extension activates", async () => {
    openDocument(LONG_PYTHON_FILE, "python");
    await runScheduledScan();
    expect(api.scanCode).not.toHaveBeenCalled();
  });

  it("scans nothing when the student switches tabs", async () => {
    const doc = openDocument(LONG_PYTHON_FILE, "python");
    // Let anything activation itself scheduled settle first, so the
    // assertion below is about the tab-switch listener in isolation.
    await runScheduledScan();
    api.scanCode.mockClear();

    // Move to a block that has never been scanned. Re-checking the same,
    // already-cached block would pass regardless of whether the tab-switch
    // listener schedules anything, because `runScan`'s fingerprint guard
    // would suppress the redundant request either way — this has to be a
    // block whose absence of a request is actually informative.
    placeCursorOn(doc, 199);
    const editor = mock.window.activeTextEditor;
    mock.__state.listeners.activeEditor.forEach((fn: any) => fn(editor));
    await runScheduledScan();

    expect(api.scanCode).not.toHaveBeenCalled();
  });

  it("scans the block the cursor comes to rest in", async () => {
    const doc = openDocument(LONG_PYTHON_FILE, "python");
    await runScheduledScan();
    api.scanCode.mockClear();

    placeCursorOn(doc, 199);
    const editor = mock.window.activeTextEditor;
    mock.__state.listeners.selection.forEach((fn: any) => fn({ textEditor: editor }));
    await runScheduledScan();

    expect(api.scanCode).toHaveBeenCalledTimes(1);
  });

  it("scans the block an edit lands in", async () => {
    const doc = openDocument(LONG_PYTHON_FILE, "python");
    await runScheduledScan();
    api.scanCode.mockClear();

    placeCursorOn(doc, 199);
    mock.__state.listeners.textDocument.forEach((fn: any) =>
      fn({ document: doc, contentChanges: [] })
    );
    await runScheduledScan();

    expect(api.scanCode).toHaveBeenCalledTimes(1);
  });

  it("opening a file and reading it costs nothing", async () => {
    openDocument(LONG_PYTHON_FILE, "python");
    await runScheduledScan(10000);
    expect(api.scanCode).not.toHaveBeenCalled();
    expect(api.getLineHint).not.toHaveBeenCalled();
  });

  it("collapses a fast scroll through many blocks into one scan, not one per stop", async () => {
    // A student scrolling fast rests the cursor briefly on several blocks in
    // a row, each stop well inside the 3500 ms scan debounce. `scheduleScan`
    // holds one timer per tutor instance and cancels-and-reschedules on every
    // call, so each rest replaces the previous stop's pending scan rather
    // than queuing one alongside it.
    const doc = openDocument(LONG_PYTHON_FILE, "python");
    await runScheduledScan();
    api.scanCode.mockClear();

    const editor = mock.window.activeTextEditor;
    for (const line of [20, 60, 100, 140, 199]) {
      placeCursorOn(doc, line);
      mock.__state.listeners.selection.forEach((fn: any) => fn({ textEditor: editor }));
      // Advanced by less than the 3500 ms debounce, so nothing fires yet —
      // the same rapid-fire shape a held-down arrow key produces too.
      jest.advanceTimersByTime(500);
    }
    await runScheduledScan();

    expect(api.scanCode).toHaveBeenCalledTimes(1);
  });
});
