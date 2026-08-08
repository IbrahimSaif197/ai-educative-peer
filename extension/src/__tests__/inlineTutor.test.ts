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

/** Let the 3500 ms scan timer fire and its promise settle. */
async function runScheduledScan() {
  jest.advanceTimersByTime(4000);
  for (let i = 0; i < 12; i++) await Promise.resolve();
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
    const { doc } = activate(api);
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
    const { doc } = activate(api);
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
    const { doc } = activate(api);
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
    const { doc } = activate(api);
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
    const { doc } = activate(api);
    await runScheduledScan();
    const actions = actionProvider().provideCodeActions(doc, new vscode.Range(2, 0, 2, 0));
    expect(actions).toHaveLength(3);
    expect(actions[2].command.command).toBe("edupeer.discussLines");
    jest.useRealTimers();
  });

  it("passes the flag range and question to discussLines", async () => {
    jest.useFakeTimers();
    const api = makeApi({ scanCode: jest.fn(async () => ({ flags: [flag()] })) });
    const { doc } = activate(api);
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
    const { doc } = activate(api);
    await runScheduledScan();
    const hover = hoverProvider().provideHover(doc, new vscode.Position(2, 0));
    expect(hover.contents.value).toContain("What is the last index this reaches?");
    expect(hover.contents.value).toContain("off-by-one");
    jest.useRealTimers();
  });

  it("allow-lists only EduPeer's own two commands", async () => {
    jest.useFakeTimers();
    const api = makeApi({ scanCode: jest.fn(async () => ({ flags: [flag()] })) });
    const { doc } = activate(api);
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
    const { doc } = activate(api);
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
    const { doc } = activate(api);
    await runScheduledScan();
    expect(diagnostics().get(doc.uri)).toHaveLength(2);
  });

  it("maps warning flags to Warning and info flags to Information", async () => {
    const api = makeApi({
      scanCode: jest.fn(async () => ({
        flags: [flag({ severity: "warning" }), flag({ line: 4, severity: "info" })],
      })),
    });
    const { doc } = activate(api);
    await runScheduledScan();
    const diags = diagnostics().get(doc.uri);
    expect(diags[0].severity).toBe(vscode.DiagnosticSeverity.Warning);
    expect(diags[1].severity).toBe(vscode.DiagnosticSeverity.Information);
  });

  it("labels the diagnostic source and carries the concept as its code", async () => {
    const api = makeApi({ scanCode: jest.fn(async () => ({ flags: [flag()] })) });
    const { doc } = activate(api);
    await runScheduledScan();
    const diag = diagnostics().get(doc.uri)[0];
    expect(diag.source).toBe("EduPeer");
    expect(diag.code).toBe("off-by-one");
  });

  it("does not rescan unchanged code", async () => {
    const api = makeApi({ scanCode: jest.fn(async () => ({ flags: [] })) });
    const { tutor, doc } = activate(api);
    await runScheduledScan();
    mock.__state.listeners.textDocument.forEach((fn: any) =>
      fn({ document: doc, contentChanges: [] })
    );
    await runScheduledScan();
    expect(api.scanCode).toHaveBeenCalledTimes(1);
  });

  it("rescans when the command forces it", async () => {
    const api = makeApi({ scanCode: jest.fn(async () => ({ flags: [] })) });
    activate(api);
    await runScheduledScan();
    await mock.__runCommand("edupeer.scanFile");
    expect(api.scanCode).toHaveBeenCalledTimes(2);
  });

  it("skips the automatic scan when autoScan is off", async () => {
    mock.__state.configuration.autoScan = false;
    const api = makeApi();
    activate(api);
    await runScheduledScan();
    expect(api.scanCode).not.toHaveBeenCalled();
  });

  it("survives a scan failure without throwing", async () => {
    const api = makeApi({ scanCode: jest.fn(async () => { throw new Error("boom"); }) });
    activate(api);
    await expect(runScheduledScan()).resolves.toBeUndefined();
  });

  it("goes quiet for the Retry-After window after a 429", async () => {
    const api = makeApi({
      scanCode: jest.fn(async () => { throw new RateLimitError(60); }),
    });
    const { doc } = activate(api);
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
    activate(api);
    await runScheduledScan();
    flags = [];
    // The fingerprint is unchanged in this fixture, so force the rescan the
    // way `EduPeer: Scan File for Issues` does.
    await mock.__runCommand("edupeer.scanFile");
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining("scans clean now"),
      "Quiz me",
      "Not now"
    );
  });

  it("does not offer a quiz for a file that was never flagged", async () => {
    const api = makeApi({ scanCode: jest.fn(async () => ({ flags: [] })) });
    activate(api);
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
    expect(api.getLineHint).toHaveBeenCalledWith(PY, 3, "python");
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

  function setup(api: any) {
    vscode.__reset();
    vscode.__state.configuration = { inlineHints: true, lensMode: "all", autoScan: false };
    const doc = vscode.__makeDocument(SOURCE, "python", "/tmp/demo.py");
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
    await Promise.resolve();

    expect(lensTitles(doc)).toContain("⏳ EduPeer is thinking…");
    expect(thinking[0]).toBe(true);

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
});
