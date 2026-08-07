import * as vscode from "vscode";
import { activate, deactivate } from "../extension";

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

  it("says there is nothing to trace in an empty file", async () => {
    const doc = mock.__makeDocument("   \n", "python");
    mock.window.activeTextEditor = mock.__makeEditor(doc);
    await activate(makeContext());
    await mock.__runCommand("edupeer.traceCode");
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining("nothing here to trace")
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
