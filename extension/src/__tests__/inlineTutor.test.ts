import * as vscode from "vscode";
import { InlineTutor } from "../inlineTutor";
import { RateLimitError } from "../apiClient";

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
    expect(lenses[0].command.title).toBe("💡 Get a hint");
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
    mock.__state.listeners.textDocument.forEach((fn: any) => fn({ document: doc }));
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
    mock.__state.listeners.textDocument.forEach((fn: any) => fn({ document: doc }));
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

  it("falls back to a local rule when throttled", async () => {
    const api = makeApi({
      getLineHint: jest.fn(async () => { throw new RateLimitError(30); }),
    });
    const { editor } = activate(api);
    await mock.__runCommand("edupeer.nudgeLine", editor.document.uri, 2);
    const call = editor.setDecorations.mock.calls.at(-1);
    expect(call[1][0].renderOptions.after.contentText).toContain("💡");
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
