import * as vscode from "vscode";
import { activate, deactivate } from "../extension";
import { EduPeerSidebarProvider } from "../sidebarProvider";

const mock = vscode as any;

const EXPECTED_COMMANDS = [
  "edupeer.activate",
  "edupeer.analyseSelection",
  "edupeer.reflectQuiz",
  "edupeer.explainError",
  "edupeer.explainSelection",
  "edupeer.predictOutput",
  "edupeer.traceCode",
  "edupeer.discussLines",
  "edupeer.resetSession",
  "edupeer.showProgress",
  "edupeer.setGoal",
  "edupeer.signIn",
  "edupeer.signOut",
  // Registered by InlineTutor, which activate() constructs.
  "edupeer.nudgeLine",
  "edupeer.scanFile",
  "edupeer.deepenLine",
  "edupeer.dismissLine",
];

const PY = "def add(a, b):\n    return a - b\n";

function makeContext() {
  const secrets = new Map<string, string>();
  const globals = new Map<string, any>();
  return {
    subscriptions: [] as any[],
    extensionUri: mock.Uri.file("/ext"),
    secrets: {
      get: async (key: string) => secrets.get(key),
      store: async (key: string, value: string) => void secrets.set(key, value),
      delete: async (key: string) => void secrets.delete(key),
    },
    globalState: {
      get: (key: string, fallback?: any) => (globals.has(key) ? globals.get(key) : fallback),
      update: async (key: string, value: any) => void globals.set(key, value),
    },
  } as any;
}

/**
 * activate() calls api.health() and, when healthy, /progress. Fail every
 * request by default so no test depends on network shape; individual tests
 * override it.
 */
function stubFetch(impl?: (url: string) => any) {
  const fn = jest.fn(async (url: string) => {
    const target = String(url);
    // A configured backend always returns a web API key here. Answering without
    // one is a misconfiguration the client now refuses outright, so tests that
    // are not about auth get a valid key rather than an empty one.
    if (target.endsWith("/auth/config")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ apiKey: "test-web-key", authDomain: "t.firebaseapp.com" }),
      };
    }
    if (impl) return impl(target);
    throw new Error("ECONNREFUSED");
  });
  (global as any).fetch = fn;
  return fn;
}

/** Let activate()'s awaited health check and its follow-ups settle. */
async function settle(times = 12) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

describe("activate", () => {
  beforeEach(() => {
    mock.__reset();
    stubFetch();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    delete (global as any).fetch;
  });

  it("registers every contributed command", async () => {
    await activate(makeContext());
    for (const id of EXPECTED_COMMANDS) {
      expect(mock.__state.commands.has(id)).toBe(true);
    }
  });

  it("registers a uri handler for the sign-in callback", async () => {
    await activate(makeContext());
    // Without this the sign-in page can only hand tokens back by POSTing to
    // loopback, which browsers now put behind a permission prompt.
    expect(mock.__state.uriHandler).toBeDefined();
  });

  it("ignores uri callbacks on other paths without throwing", async () => {
    await activate(makeContext());
    // Any application on the machine can invoke the handler, so an unexpected
    // link must be inert rather than an error the student sees.
    expect(() =>
      mock.__state.uriHandler!.handleUri({ path: "/somewhere-else", query: "payload=x" })
    ).not.toThrow();
    expect(() =>
      mock.__state.uriHandler!.handleUri({ path: "/callback", query: "" })
    ).not.toThrow();
  });

  it("registers no commands beyond the expected set", async () => {
    await activate(makeContext());
    expect([...mock.__state.commands.keys()].sort()).toEqual([...EXPECTED_COMMANDS].sort());
  });

  it("registers the sidebar webview provider", async () => {
    await activate(makeContext());
    expect(mock.__state.webviewViewProviders.has("edupeer.sidebar")).toBe(true);
  });

  it("keeps the webview alive when hidden", async () => {
    await activate(makeContext());
    const entry = mock.__state.webviewViewProviders.get("edupeer.sidebar");
    expect(entry.options.webviewOptions.retainContextWhenHidden).toBe(true);
  });

  it("creates a status bar item bound to the panel command", async () => {
    await activate(makeContext());
    expect(mock.__state.statusBarItems).toHaveLength(1);
    expect(mock.__state.statusBarItems[0].command).toBe("edupeer.activate");
  });

  it("puts everything it creates into the subscriptions", async () => {
    const context = makeContext();
    await activate(context);
    expect(context.subscriptions.length).toBeGreaterThan(EXPECTED_COMMANDS.length);
  });

  it("warns when the backend cannot be reached and a tutored file is open", async () => {
    mock.window.activeTextEditor = mock.__makeEditor(
      mock.__makeDocument("x = 1", "python", "file:///a.py")
    );
    await activate(makeContext());
    await settle();
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining("not reachable")
    );
  });

  it("names the configured backend url in the warning", async () => {
    mock.window.activeTextEditor = mock.__makeEditor(
      mock.__makeDocument("x = 1", "python", "file:///a.py")
    );
    mock.__state.configuration.backendUrl = "http://example.test:9000";
    await activate(makeContext());
    await settle();
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining("http://example.test:9000")
    );
  });

  it("stays quiet in a window with no tutored file open", async () => {
    // activate() runs on startup in every window; interrupting a window that
    // has nothing to do with EduPeer is pure noise.
    await activate(makeContext());
    await settle();
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
  });

  it("warns later, once the student opens a tutored file", async () => {
    await activate(makeContext());
    await settle();
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();

    mock.window.activeTextEditor = mock.__makeEditor(
      mock.__makeDocument("x = 1", "python", "file:///a.py")
    );
    for (const fn of mock.__state.listeners.activeEditor) fn(mock.window.activeTextEditor);
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining("not reachable")
    );
  });

  it("warns at most once per session", async () => {
    mock.window.activeTextEditor = mock.__makeEditor(
      mock.__makeDocument("x = 1", "python", "file:///a.py")
    );
    await activate(makeContext());
    await settle();
    for (const fn of mock.__state.listeners.activeEditor) fn(mock.window.activeTextEditor);
    expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
  });

  it("does not warn when the backend answers", async () => {
    stubFetch((url) => {
      if (url.endsWith("/health")) return { ok: true, status: 200 };
      return {
        ok: true,
        status: 200,
        json: async () => ({ streak_days: 4, review_due: false }),
      };
    });
    await activate(makeContext());
    await settle();
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
  });

  it("hides the status bar when no supported file is open", async () => {
    await activate(makeContext());
    expect(mock.__state.statusBarItems[0].hide).toHaveBeenCalled();
  });

  it("shows the status bar for a supported file", async () => {
    const doc = mock.__makeDocument(PY, "python");
    mock.window.activeTextEditor = mock.__makeEditor(doc);
    await activate(makeContext());
    expect(mock.__state.statusBarItems[0].show).toHaveBeenCalled();
  });

  it("deactivate is a no-op", () => {
    expect(() => deactivate()).not.toThrow();
  });
});

describe("commands", () => {
  beforeEach(async () => {
    mock.__reset();
    stubFetch();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    delete (global as any).fetch;
  });

  it("opens the sidebar container", async () => {
    await activate(makeContext());
    await mock.__runCommand("edupeer.activate");
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "workbench.view.extension.edupeer-sidebar"
    );
  });

  it("tells the student to open a file before analysing a selection", async () => {
    await activate(makeContext());
    mock.window.activeTextEditor = undefined;
    await mock.__runCommand("edupeer.analyseSelection");
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining("open a file and select code first")
    );
  });

  it("tells the student to select something before analysing", async () => {
    const doc = mock.__makeDocument("", "python");
    mock.window.activeTextEditor = mock.__makeEditor(doc);
    await activate(makeContext());
    await mock.__runCommand("edupeer.analyseSelection");
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining("no code is selected")
    );
  });

  it("tells the student to select code before predicting output", async () => {
    const doc = mock.__makeDocument("", "python");
    mock.window.activeTextEditor = mock.__makeEditor(doc);
    await activate(makeContext());
    await mock.__runCommand("edupeer.predictOutput");
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining("select the code whose output")
    );
  });

  it("tells the student to open a file before tracing", async () => {
    await activate(makeContext());
    mock.window.activeTextEditor = undefined;
    await mock.__runCommand("edupeer.traceCode");
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining("open a file first")
    );
  });

  it("asks for a selection rather than tracing whatever the cursor sits in", async () => {
    const doc = mock.__makeDocument("   \n", "python");
    mock.window.activeTextEditor = mock.__makeEditor(doc);
    await activate(makeContext());
    await mock.__runCommand("edupeer.traceCode");
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining("select the code you want to trace")
    );
  });

  it("asks for the error text when nothing is selected", async () => {
    const doc = mock.__makeDocument("", "python");
    mock.window.activeTextEditor = mock.__makeEditor(doc);
    await activate(makeContext());
    await mock.__runCommand("edupeer.explainError");
    expect(vscode.window.showInputBox).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: expect.stringContaining("error message") })
    );
  });

  it("does nothing when the error prompt is dismissed", async () => {
    const doc = mock.__makeDocument("", "python");
    mock.window.activeTextEditor = mock.__makeEditor(doc);
    await activate(makeContext());
    (vscode.commands.executeCommand as jest.Mock).mockClear();
    await mock.__runCommand("edupeer.explainError");
    expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith(
      "workbench.view.extension.edupeer-sidebar"
    );
  });

  it("prompts for a goal and reports the mapped concepts", async () => {
    mock.__state.inputBoxAnswers.push("get better at recursion");
    stubFetch((url) => {
      if (url.endsWith("/health")) return { ok: true, status: 200 };
      if (url.endsWith("/goal")) {
        return { ok: true, status: 200, json: async () => ({ concepts: ["recursion"] }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });
    await activate(makeContext());
    await mock.__runCommand("edupeer.setGoal");
    await settle();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining("recursion")
    );
  });

  it("does nothing when the goal prompt is dismissed", async () => {
    await activate(makeContext());
    (vscode.window.showInformationMessage as jest.Mock).mockClear();
    await mock.__runCommand("edupeer.setGoal");
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it("queues the goal when the backend is unreachable", async () => {
    mock.__state.inputBoxAnswers.push("learn loops");
    const context = makeContext();
    await activate(context);
    await mock.__runCommand("edupeer.setGoal");
    await settle();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining("will sync later")
    );
    expect(context.globalState.get("edupeer.offlineQueue")).toHaveLength(1);
  });

  it("opens a webview panel for the progress dashboard", async () => {
    stubFetch((url) => {
      if (url.endsWith("/health")) return { ok: true, status: 200 };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          badges: [],
          total_interactions: 3,
          sessions: 1,
          streak_days: 2,
          languages_used: [],
          goal: null,
          concept_struggles: [],
          concept_strengths: [],
          session_summaries: [],
          review_due: false,
        }),
      };
    });
    await activate(makeContext());
    await mock.__runCommand("edupeer.showProgress");
    await settle();
    expect(mock.__state.webviewPanels).toHaveLength(1);
    expect(mock.__state.webviewPanels[0].webview.html).toContain("Your progress");
  });

  it("creates the progress panel with scripts disabled", async () => {
    stubFetch((url) => {
      if (url.endsWith("/health")) return { ok: true, status: 200 };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          badges: [], total_interactions: 0, sessions: 0, streak_days: 0,
          languages_used: [], goal: null, concept_struggles: [],
          concept_strengths: [], session_summaries: [], review_due: false,
        }),
      };
    });
    await activate(makeContext());
    await mock.__runCommand("edupeer.showProgress");
    await settle();
    expect(mock.__state.webviewPanels[0].options.enableScripts).toBeUndefined();
  });

  it("reports a failure to load progress", async () => {
    await activate(makeContext());
    await mock.__runCommand("edupeer.showProgress");
    await settle();
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining("could not load progress")
    );
  });

  it("pulls the flagged lines into the panel for discussLines", async () => {
    await activate(makeContext());
    (vscode.commands.executeCommand as jest.Mock).mockClear();
    await mock.__runCommand(
      "edupeer.discussLines",
      mock.Uri.file("/tmp/x.py"),
      0,
      1,
      "What stops this loop?"
    );
    await settle();
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      "workbench.view.extension.edupeer-sidebar"
    );
  });
});

describe("configuration changes", () => {
  beforeEach(() => {
    mock.__reset();
    stubFetch();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    delete (global as any).fetch;
  });

  it("subscribes to configuration changes", async () => {
    await activate(makeContext());
    expect(mock.__state.listeners.configuration).toHaveLength(1);
  });

  it("re-reads the backend url when it changes", async () => {
    await activate(makeContext());
    mock.__state.configuration.backendUrl = "http://changed.test:1234";
    const fetchMock = stubFetch();
    mock.__state.listeners.configuration.forEach((fn: any) =>
      fn({ affectsConfiguration: (key: string) => key === "edupeer.backendUrl" })
    );
    jest.advanceTimersByTime(31_000);
    await settle();
    const urls = fetchMock.mock.calls.map((c: any[]) => String(c[0]));
    expect(urls.some((u) => u.startsWith("http://changed.test:1234"))).toBe(true);
  });

  it("ignores changes to other settings", async () => {
    await activate(makeContext());
    expect(() =>
      mock.__state.listeners.configuration.forEach((fn: any) =>
        fn({ affectsConfiguration: () => false })
      )
    ).not.toThrow();
  });

  it("retries the health check on a timer while offline", async () => {
    const fetchMock = stubFetch();
    await activate(makeContext());
    const before = fetchMock.mock.calls.length;
    jest.advanceTimersByTime(31_000);
    await settle();
    expect(fetchMock.mock.calls.length).toBeGreaterThan(before);
  });
});

describe("the commands that reach for the file send a block instead", () => {
  /**
   * Long enough that a block-scoped digest can be proven to exclude most of
   * it. Mirrors the fixture `inlineTutor.test.ts` and `sidebarProvider.test.ts`
   * use for the same proof (Task 13): `import math` is the header; `_spacer`
   * is a one-line definition placed right after it purely so `codeDigest`'s
   * header band stops there. `deep` lands exactly on line 200 (0-based 199),
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

  let provider: any;

  /** Open a document as the active editor, cursor at the top. */
  function openDocument(text: string, languageId = "python") {
    const doc = mock.__makeDocument(text, languageId);
    mock.window.activeTextEditor = mock.__makeEditor(doc, 0, 0);
    // `discussLines` re-opens the document by uri instead of reading the
    // active editor; the mock's default stub ignores whatever uri it is
    // asked for, so it is pointed at this same document for the one call
    // these tests make.
    mock.workspace.openTextDocument.mockResolvedValueOnce(doc);
    return doc;
  }

  /** Move the active editor's cursor to `line` (0-based), an empty selection. */
  function placeCursorOn(doc: any, line: number) {
    mock.window.activeTextEditor = mock.__makeEditor(doc, line);
  }

  /** Select lines `startLine`-`endLine` (0-based, inclusive) in the active editor. */
  function selectLines(doc: any, startLine: number, endLine: number) {
    const editor = mock.__makeEditor(doc, startLine, 0);
    editor.selection = new vscode.Selection(
      new vscode.Position(startLine, 0),
      new vscode.Position(endLine, doc.lineAt(endLine).text.length)
    );
    mock.window.activeTextEditor = editor;
  }

  beforeEach(async () => {
    mock.__reset();
    stubFetch();
    jest.useFakeTimers();
    // predictOutput/traceCode/discussLines call straight through to the real
    // provider otherwise, which would exercise the whole ask/stream machinery
    // sidebarProvider.test.ts already covers. Spying on the prototype lets
    // `activate()` build its usual real instance while these three calls stay
    // inspectable, the way `provider.startPrediction.mock.calls` needs.
    provider = {
      startPrediction: jest
        .spyOn(EduPeerSidebarProvider.prototype, "startPrediction")
        .mockImplementation(() => {}),
      startTrace: jest
        .spyOn(EduPeerSidebarProvider.prototype, "startTrace")
        .mockResolvedValue(undefined),
      askExternal: jest
        .spyOn(EduPeerSidebarProvider.prototype, "askExternal")
        .mockResolvedValue(undefined),
    };
    await activate(makeContext());
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    delete (global as any).fetch;
    provider.startPrediction.mockRestore();
    provider.startTrace.mockRestore();
    provider.askExternal.mockRestore();
  });

  it("predictOutput sends the block around the selection", async () => {
    const doc = openDocument(LONG_PYTHON_FILE, "python");
    selectLines(doc, 199, 200);
    await mock.__runCommand("edupeer.predictOutput");
    const [, code] = provider.startPrediction.mock.calls[0];
    expect(code).not.toContain("line_10 = 10");
    expect(code).toContain("def deep(n):");
  });

  it("traceCode refuses to trace when nothing is selected", async () => {
    // The snippet is the exercise, and it travels whole — a desk-check over a
    // digest's elided bands would have holes in it. So this is the one command
    // whose payload `buildDigest` cannot bound, and requiring a selection is
    // what keeps that bound under the student's own hand: nothing leaves for a
    // trace they did not ask for by selecting it.
    const doc = openDocument(LONG_PYTHON_FILE, "python");
    placeCursorOn(doc, 200);
    await mock.__runCommand("edupeer.traceCode");
    expect(provider.startTrace).not.toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining("select the code you want to trace")
    );
  });

  it("traceCode traces the selection and sends the block as context", async () => {
    const doc = openDocument(LONG_PYTHON_FILE, "python");
    selectLines(doc, 199, 200);
    await mock.__runCommand("edupeer.traceCode");
    const [snippet, code] = provider.startTrace.mock.calls[0];
    expect(snippet).toContain("def deep(n):");
    // The context still narrows to the block. It reaches the wire only through
    // the trace follow-up, which digests it, so it is capped there.
    expect(code).not.toContain("line_10 = 10");
    expect(code).toContain("def deep(n):");
  });

  it("discussLines sends the block, not the file", async () => {
    const doc = openDocument(LONG_PYTHON_FILE, "python");
    await mock.__runCommand("edupeer.discussLines", doc.uri, 199, 200, "Off by one?");
    const [, code] = provider.askExternal.mock.calls[0];
    expect(code).not.toContain("line_10 = 10");
  });
});
