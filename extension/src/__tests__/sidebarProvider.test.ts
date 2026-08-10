import * as vscode from "vscode";
import { EduPeerSidebarProvider } from "../sidebarProvider";
import { AuthError, RateLimitError } from "../apiClient";
import { formatTestFailureQuestion } from "../pedagogy";

const mock = vscode as any;

const CODE = "def average(n):\n    return sum(n) / len(n)\n";

interface Harness {
  provider: EduPeerSidebarProvider;
  /** Everything the provider posted to the webview, in order. */
  posted: any[];
  /** Deliver a message from the webview to the provider. */
  send: (msg: any) => Promise<void>;
  api: any;
  state: Map<string, any>;
  html: string;
}

function makeApi(overrides: Record<string, any> = {}) {
  return {
    isAvailable: true,
    isAuthHealthy: true,
    streamHint: jest.fn(async (_req: any, _onEvent: any) => ({
      hint: "What does len(n) return when n is empty?",
      hint_level: 1,
      concept_tags: ["functions"],
    })),
    getHint: jest.fn(async () => ({
      hint: "fallback hint",
      hint_level: 1,
      concept_tags: [],
    })),
    getTrace: jest.fn(async () => ({ variables: [], steps: 0, prompt: "" })),
    getReview: jest.fn(async () => ({ due: false, concepts: [], exercise: "" })),
    resetSession: jest.fn(async () => "you practised loops"),
    ...overrides,
  };
}

async function build(
  apiOverrides: Record<string, any> = {},
  code = CODE,
  languageId = "python"
): Promise<Harness> {
  const posted: any[] = [];
  const state = new Map<string, any>();
  let receive: ((msg: any) => Promise<void>) | undefined;

  const api = makeApi(apiOverrides);
  const context = {
    globalState: {
      get: (key: string, fallback: any) => (state.has(key) ? state.get(key) : fallback),
      update: async (key: string, value: any) => void state.set(key, value),
    },
  } as any;
  const firebase = { getBadges: jest.fn(async () => ["First Question"]) } as any;
  const auth = {
    getSession: () => ({ uid: "u1", isAnonymous: true, refreshToken: "r" }),
    onDidChange: jest.fn(),
  } as any;
  const queue = { enqueue: jest.fn(async () => undefined) } as any;

  const doc = mock.__makeDocument(code, languageId, "/tmp/demo.py");
  mock.window.activeTextEditor = mock.__makeEditor(doc);

  const provider = new EduPeerSidebarProvider(
    mock.Uri.file("/ext"),
    context,
    api as any,
    firebase,
    auth,
    queue
  );

  const view = {
    webview: {
      options: {},
      html: "",
      cspSource: "vscode-webview:",
      asWebviewUri: (u: any) => u,
      postMessage: (msg: any) => {
        posted.push(msg);
        return Promise.resolve(true);
      },
      onDidReceiveMessage: (fn: any) => {
        receive = fn;
        return { dispose: jest.fn() };
      },
    },
    show: jest.fn(),
    onDidDispose: jest.fn(() => ({ dispose: jest.fn() })),
  } as any;

  provider.resolveWebviewView(view);
  const send = async (msg: any) => {
    await receive!(msg);
  };
  await send({ type: "ready" });
  posted.length = 0; // drop the startup burst; tests assert on what follows

  return { provider, posted, send, api, state, html: view.webview.html };
}

/**
 * A provider wired to a single document, without spending the first
 * `sendFocus` resolve on a "ready" burst — these tests call `sendFocus` and
 * `handleAsk` directly and need that first call to be the one under test.
 * A distinct path per call keeps `resolveFocus`'s memo cache (keyed on
 * uri+version+cursor, see focusScope.ts) from ever answering with another
 * test's document.
 */
async function setupProvider(
  source: string = CODE,
  cursorLine = 0,
  path = "/tmp/focus/demo.py",
  languageId = "python"
): Promise<{ provider: EduPeerSidebarProvider; posted: any[]; api: any; doc: any; html: string }> {
  const posted: any[] = [];
  const state = new Map<string, any>();
  const api = makeApi();
  const context = {
    globalState: {
      get: (key: string, fallback: any) => (state.has(key) ? state.get(key) : fallback),
      update: async (key: string, value: any) => void state.set(key, value),
    },
  } as any;
  const firebase = { getBadges: jest.fn(async () => []) } as any;
  const auth = {
    getSession: () => ({ uid: "u1", isAnonymous: true, refreshToken: "r" }),
    onDidChange: jest.fn(),
  } as any;
  const queue = { enqueue: jest.fn(async () => undefined) } as any;

  const doc = mock.__makeDocument(source, languageId, path);
  mock.window.activeTextEditor = mock.__makeEditor(doc, cursorLine);
  // No document symbol provider in this harness: resolveFocus must fall
  // through to the heuristic path rather than hang on a real provider.
  mock.commands.executeCommand.mockResolvedValue(undefined);

  const provider = new EduPeerSidebarProvider(
    mock.Uri.file("/ext"),
    context,
    api as any,
    firebase,
    auth,
    queue
  );

  const view = {
    webview: {
      options: {},
      html: "",
      cspSource: "vscode-webview:",
      asWebviewUri: (u: any) => u,
      postMessage: (msg: any) => {
        posted.push(msg);
        return Promise.resolve(true);
      },
      onDidReceiveMessage: () => ({ dispose: jest.fn() }),
    },
    show: jest.fn(),
    onDidDispose: jest.fn(() => ({ dispose: jest.fn() })),
  } as any;

  provider.resolveWebviewView(view);

  return { provider, posted, api, doc, html: view.webview.html };
}

const latest = (posted: any[], type: string) =>
  [...posted].reverse().find((m) => m.type === type);

const hintRequest = (api: any) => api.streamHint.mock.calls.at(-1)[0];

/** Ask a question, skipping the explain-first gate that guards a new file. */
async function askPastTheGate(h: Harness, question = "why does it crash?", extra: any = {}) {
  await h.send({ type: "askHint", question, code: CODE, mode: "hint", ...extra });
  if (latest(h.posted, "explainFirst")) {
    await h.send({ type: "explainSkip" });
  }
}

describe("startup", () => {
  beforeEach(() => mock.__reset());

  it("starts with an empty transcript, and restores the file, badges, auth and offline state", async () => {
    const posted: any[] = [];
    // A leftover value under the old persistence key. The transcript now
    // lives in an in-memory map keyed like the hint ladder, not here, so a
    // fresh provider must never resurrect it.
    const state = new Map<string, any>([["edupeer.chatHistory", [{ role: "tutor", text: "hi" }]]]);
    let receive: any;
    const context = {
      globalState: {
        get: (key: string, fallback: any) => (state.has(key) ? state.get(key) : fallback),
        update: async (key: string, value: any) => void state.set(key, value),
      },
    } as any;
    const doc = mock.__makeDocument(CODE);
    mock.window.activeTextEditor = mock.__makeEditor(doc);
    const provider = new EduPeerSidebarProvider(
      mock.Uri.file("/ext"),
      context,
      makeApi() as any,
      { getBadges: jest.fn(async () => []) } as any,
      { getSession: () => undefined, onDidChange: jest.fn() } as any,
      undefined
    );
    provider.resolveWebviewView({
      webview: {
        options: {},
        html: "",
        cspSource: "x:",
        asWebviewUri: (u: any) => u,
        postMessage: (m: any) => {
          posted.push(m);
          return Promise.resolve(true);
        },
        onDidReceiveMessage: (fn: any) => ((receive = fn), { dispose: jest.fn() }),
      },
      show: jest.fn(),
      onDidDispose: jest.fn(() => ({ dispose: jest.fn() })),
    } as any);
    await receive({ type: "ready" });

    expect(latest(posted, "restoreChat").messages).toEqual([]);
    expect(latest(posted, "focus").language).toBe("Python");
    expect(latest(posted, "badges")).toBeDefined();
    expect(latest(posted, "authState").signedIn).toBe(false);
    expect(latest(posted, "offline").value).toBe(false);
  });

  // The webview's placeholder (Task 12) reads `signedIn` at the moment
  // "restoreChat" arrives with no stored messages, defaulting to signed-out
  // until "authState" says otherwise. `sendBadges` sits between the two posts
  // below and makes a real network call in production, so if "restoreChat"
  // led, a signed-in student with no history would see "sign in" for as long
  // as that call takes — not a same-tick flicker. `authState` must lead.
  it("posts auth state before the restored chat, so a reload never tells a signed-in student to sign in", async () => {
    const h = await build();
    await h.send({ type: "ready" });

    const authIndex = h.posted.findIndex((m) => m.type === "authState");
    const restoreIndex = h.posted.findIndex((m) => m.type === "restoreChat");
    expect(authIndex).toBeGreaterThanOrEqual(0);
    expect(restoreIndex).toBeGreaterThanOrEqual(0);
    expect(authIndex).toBeLessThan(restoreIndex);
  });

  it("labels an anonymous session as not signed in", async () => {
    const h = await build();
    h.provider.reveal();
    await h.send({ type: "ready" });
    expect(latest(h.posted, "authState").label).toBe("Not signed in");
  });

  /**
   * Final review, Minor 7: on the first "ready" the thread key is still "",
   * so `postThread("")` minted a permanent phantom entry in `threads` and
   * posted an empty `restoreChat` that `sendFocus` superseded a moment later.
   */
  it("mints no phantom thread for the empty startup key", async () => {
    const h = await build();
    expect(h.provider["threads"].has("")).toBe(false);
  });

  it("posts the transcript once at startup, not twice", async () => {
    const posted: any[] = [];
    let receive: any;
    const doc = mock.__makeDocument(CODE, "python", "/tmp/startup-once/demo.py");
    mock.window.activeTextEditor = mock.__makeEditor(doc);
    const provider = new EduPeerSidebarProvider(
      mock.Uri.file("/ext"),
      { globalState: { get: (_k: string, f: any) => f, update: async () => undefined } } as any,
      makeApi() as any,
      { getBadges: jest.fn(async () => []) } as any,
      { getSession: () => undefined, onDidChange: jest.fn() } as any,
      undefined
    );
    provider.resolveWebviewView({
      webview: {
        options: {},
        html: "",
        cspSource: "x:",
        asWebviewUri: (u: any) => u,
        postMessage: (m: any) => {
          posted.push(m);
          return Promise.resolve(true);
        },
        onDidReceiveMessage: (fn: any) => ((receive = fn), { dispose: jest.fn() }),
      },
      show: jest.fn(),
      onDidDispose: jest.fn(() => ({ dispose: jest.fn() })),
    } as any);

    await receive({ type: "ready" });

    // The one that survives is `sendFocus`'s, for the block actually in focus.
    expect(posted.filter((m) => m.type === "restoreChat")).toHaveLength(1);
  });

  it("surfaces the review button only when one is due", async () => {
    const h = await build({
      getReview: jest.fn(async () => ({ due: true, concepts: ["loops"], exercise: "" })),
    });
    await h.send({ type: "ready" });
    expect(latest(h.posted, "reviewDue").concepts).toEqual(["loops"]);
  });
});

describe("the explain-first gate", () => {
  beforeEach(() => mock.__reset());

  it("intercepts the first question about a file", async () => {
    const h = await build();
    await h.send({ type: "askHint", question: "help", code: CODE, mode: "hint" });
    expect(latest(h.posted, "explainFirst")).toBeDefined();
    expect(h.api.streamHint).not.toHaveBeenCalled();
  });

  it("proceeds when the student skips it", async () => {
    const h = await build();
    await h.send({ type: "askHint", question: "help", code: CODE, mode: "hint" });
    await h.send({ type: "explainSkip" });
    expect(h.api.streamHint).toHaveBeenCalledTimes(1);
    expect(hintRequest(h.api).question).toBe("help");
  });

  it("folds the student's explanation into the question", async () => {
    const h = await build();
    await h.send({ type: "askHint", question: "help", code: CODE, mode: "hint" });
    await h.send({ type: "explainAnswer", explanation: "it averages a list" });
    expect(hintRequest(h.api).question).toContain("it averages a list");
    expect(hintRequest(h.api).question).toContain("help");
  });

  it("treats a blank explanation as a skip", async () => {
    const h = await build();
    await h.send({ type: "askHint", question: "help", code: CODE, mode: "hint" });
    await h.send({ type: "explainAnswer", explanation: "   " });
    expect(hintRequest(h.api).question).toBe("help");
  });

  it("does not fire twice for the same code", async () => {
    const h = await build();
    await askPastTheGate(h);
    h.posted.length = 0;
    await h.send({ type: "askHint", question: "again", code: CODE, mode: "hint" });
    expect(latest(h.posted, "explainFirst")).toBeUndefined();
  });

  it("does not gate non-hint modes", async () => {
    const h = await build();
    await h.send({ type: "askHint", question: "", code: CODE, mode: "reflect" });
    expect(latest(h.posted, "explainFirst")).toBeUndefined();
    expect(h.api.streamHint).toHaveBeenCalledTimes(1);
  });
});

describe("the attempt gate", () => {
  beforeEach(() => mock.__reset());

  it("escalates the first ask", async () => {
    const h = await build();
    await askPastTheGate(h);
    expect(hintRequest(h.api).escalate).toBe(true);
  });

  it("refuses to escalate when nothing changed", async () => {
    // "idk" is on the give-up list (see attemptTracker.ts), so it does not
    // count as answering — this test is about the code being untouched, not
    // about what was typed.
    const h = await build();
    await askPastTheGate(h);
    await h.send({ type: "askHint", question: "idk", code: CODE, mode: "hint" });
    expect(hintRequest(h.api).escalate).toBe(false);
  });

  it("tells the student why they got the same depth", async () => {
    const h = await build();
    await askPastTheGate(h);
    h.posted.length = 0;
    await h.send({ type: "askHint", question: "idk", code: CODE, mode: "hint" });
    const gate = h.posted.find((m) => m.type === "hint" && m.mode === "attempt-gate");
    // They typed something, so the card no longer opens by telling them they
    // typed nothing — it asks for the one thing that unlocks the next hint.
    expect(gate.hint).toContain("Tell me what you tried");
    expect(gate.hint).not.toContain("haven't changed anything");
    expect(gate.hint_level).toBe(0);
  });

  it("escalates again once the code changes", async () => {
    const h = await build();
    await askPastTheGate(h);
    await h.send({
      type: "askHint",
      question: "now?",
      code: CODE.replace("sum(n)", "total(n)"),
      mode: "hint",
    });
    expect(hintRequest(h.api).escalate).toBe(true);
  });

  it("sends a diff of what changed", async () => {
    const h = await build();
    await askPastTheGate(h);
    // The attempt tracker now compares the focus block `sendFocus` last
    // resolved, not the webview's postMessage `code` field, so simulating an
    // edit means mutating the tracked editor and forcing a resolve — the way
    // a real edit plus the debounced document-change listener would in
    // production — not just sending a different `code` alongside the ask.
    // Same path as `build()`'s document — this is simulating an edit to the
    // same open file, and `lastDocumentKey` (what the attempt tracker keys
    // on) is uri-based, so a different path would make this look like an
    // unrelated, never-seen-before problem instead of an edit to this one.
    // But resolveFocus memoises on uri+version+cursor (see focusScope.ts),
    // and the mock always stamps version 1, so reusing the exact same cursor
    // too would hand back `build()`'s already-cached, pre-edit scope instead
    // of resolving the edited text. Line 1 is still inside `average`'s body,
    // so the resolved block is unchanged — only the cache key is.
    const edited = mock.__makeDocument(
      CODE.replace("sum(n)", "total(n)"),
      "python",
      "/tmp/demo.py"
    );
    mock.window.activeTextEditor = mock.__makeEditor(edited, 1);
    await h.send({ type: "refreshCode" });
    // The explain-first gate already had its turn for this file (via
    // `askPastTheGate` above), so this second ask goes straight through —
    // `explainSkip` below is a harmless no-op, kept only in case that ever
    // changes.
    await h.send({
      type: "askHint",
      question: "now?",
      code: CODE.replace("sum(n)", "total(n)"),
      mode: "hint",
    });
    await h.send({ type: "explainSkip" });
    const summary = hintRequest(h.api).edit_summary;
    expect(summary).toContain("- ");
    expect(summary).toContain("+ ");
    expect(summary).toContain("total(n)");
  });

  it("sends no diff when nothing changed", async () => {
    const h = await build();
    await askPastTheGate(h);
    // "idk", not "still stuck": the latter is an attempt, which takes the
    // `answered` branch — and that branch also carries an empty edit_summary,
    // so this test passed either way and asserted nothing about the path in
    // its own name.
    await h.send({ type: "askHint", question: "idk", code: CODE, mode: "hint" });
    expect(hintRequest(h.api).edit_summary).toBe("");
    expect(hintRequest(h.api).escalate).toBe(false);
  });

  it("never gates a non-hint mode", async () => {
    const h = await build();
    await askPastTheGate(h);
    await h.send({ type: "askHint", question: "", code: CODE, mode: "reflect" });
    expect(hintRequest(h.api).escalate).toBe(true);
  });

  it("forgets the attempt record on reset", async () => {
    const h = await build();
    await askPastTheGate(h);
    await h.send({ type: "reset" });
    await askPastTheGate(h, "fresh start");
    expect(hintRequest(h.api).escalate).toBe(true);
  });
});

describe("mode routing", () => {
  beforeEach(() => mock.__reset());

  it("detects a pasted stack trace and switches to explain-error", async () => {
    const h = await build();
    await h.send({
      type: "askHint",
      question: "Traceback (most recent call last):\n  File \"a.py\", line 3\nZeroDivisionError: x",
      code: CODE,
      mode: "hint",
    });
    expect(hintRequest(h.api).mode).toBe("explain-error");
  });

  it("does not gate a detected error, since it is no longer hint mode", async () => {
    const h = await build();
    await h.send({
      type: "askHint",
      question: "ZeroDivisionError: division by zero",
      code: CODE,
      mode: "hint",
    });
    expect(latest(h.posted, "explainFirst")).toBeUndefined();
  });

  it("sends the language of the active file", async () => {
    const h = await build({}, "let x = 1;\n", "javascript");
    await askPastTheGate(h);
    expect(hintRequest(h.api).language).toBe("javascript");
  });

  it("caps the history it forwards", async () => {
    const h = await build();
    for (let i = 0; i < 8; i++) {
      await h.send({ type: "askHint", question: `q${i}`, code: CODE, mode: "reflect" });
    }
    expect(hintRequest(h.api).history.length).toBeLessThanOrEqual(6);
  });

  it("ignores an empty question", async () => {
    const h = await build();
    await h.send({ type: "askHint", question: "   ", code: CODE, mode: "hint" });
    expect(h.api.streamHint).not.toHaveBeenCalled();
  });
});

describe("failure handling", () => {
  beforeEach(() => mock.__reset());

  it("falls back to the plain hint call when streaming breaks", async () => {
    const h = await build({
      streamHint: jest.fn(async () => {
        throw new Error("stream ended without a done event");
      }),
    });
    await askPastTheGate(h);
    expect(h.api.getHint).toHaveBeenCalledTimes(1);
    expect(latest(h.posted, "hint").hint).toBe("fallback hint");
  });

  it("does not retry through an exhausted budget", async () => {
    const h = await build({
      streamHint: jest.fn(async () => {
        throw new RateLimitError(30);
      }),
    });
    await askPastTheGate(h);
    expect(h.api.getHint).not.toHaveBeenCalled();
  });

  it("explains a 429 instead of showing an error", async () => {
    const h = await build({
      streamHint: jest.fn(async () => {
        throw new RateLimitError(30);
      }),
    });
    await askPastTheGate(h);
    const reply = latest(h.posted, "hint");
    expect(reply.mode).toBe("rate-limited");
    expect(reply.hint_level).toBe(0);
    expect(latest(h.posted, "error")).toBeUndefined();
  });

  it("answers locally when the backend is unreachable", async () => {
    const h = await build({
      isAvailable: false,
      streamHint: jest.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
      getHint: jest.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    });
    await askPastTheGate(h);
    const reply = latest(h.posted, "hint");
    expect(reply.mode).toBe("offline");
    expect(reply.hint).toContain("offline");
  });

  it("answers locally when sign-in is broken but the backend is up", async () => {
    const h = await build({
      isAvailable: true,
      isAuthHealthy: false,
      streamHint: jest.fn(async () => {
        throw new AuthError("anonymous sign-in failed (400)", 400);
      }),
      getHint: jest.fn(async () => {
        throw new AuthError("anonymous sign-in failed (400)", 400);
      }),
    });
    await askPastTheGate(h);
    const reply = latest(h.posted, "hint");
    expect(reply.mode).toBe("offline");
    // The raw Firebase status code is not a useful thing to show a student.
    expect(latest(h.posted, "error")).toBeUndefined();
  });

  it("shows a real error when the backend is up but failing", async () => {
    const h = await build({
      streamHint: jest.fn(async () => {
        throw new Error("stream failed (500)");
      }),
      getHint: jest.fn(async () => {
        throw new Error("Backend error (500): boom");
      }),
    });
    await askPastTheGate(h);
    expect(latest(h.posted, "error").message).toContain("500");
  });

  it("clears the streaming bubble before reporting a failure", async () => {
    const h = await build({
      streamHint: jest.fn(async () => {
        throw new Error("boom");
      }),
      getHint: jest.fn(async () => {
        throw new Error("boom");
      }),
    });
    await askPastTheGate(h);
    expect(latest(h.posted, "streamAbort")).toBeDefined();
  });

  it("always stops the loading indicator", async () => {
    const h = await build({
      streamHint: jest.fn(async () => {
        throw new Error("boom");
      }),
      getHint: jest.fn(async () => {
        throw new Error("boom");
      }),
    });
    await askPastTheGate(h);
    expect(latest(h.posted, "loading").value).toBe(false);
  });

  it("does not advance the local hint level on failure", async () => {
    const levels: number[] = [];
    const h = await build({
      streamHint: jest.fn(async () => {
        throw new Error("boom");
      }),
      getHint: jest.fn(async () => {
        throw new Error("boom");
      }),
    });
    h.provider.onDidChangeHintLevel((level) => levels.push(level));
    await askPastTheGate(h);
    expect(levels).toEqual([]);
  });
});

describe("streaming", () => {
  beforeEach(() => mock.__reset());

  it("forwards delta events to the webview", async () => {
    const h = await build({
      streamHint: jest.fn(async (_req: any, onEvent: any) => {
        onEvent({ type: "delta", text: "Look " });
        onEvent({ type: "delta", text: "here." });
        return { hint: "Look here.", hint_level: 2, concept_tags: [] };
      }),
    });
    await askPastTheGate(h);
    const deltas = h.posted.filter((m) => m.type === "streamDelta").map((m) => m.text);
    expect(deltas).toEqual(["Look ", "here."]);
  });

  it("opens a streaming bubble before the first delta", async () => {
    const h = await build();
    await askPastTheGate(h);
    const startIndex = h.posted.findIndex((m) => m.type === "streamStart");
    const hintIndex = h.posted.findIndex((m) => m.type === "hint");
    expect(startIndex).toBeGreaterThanOrEqual(0);
    expect(startIndex).toBeLessThan(hintIndex);
  });

  it("publishes the hint level for the status bar", async () => {
    const levels: number[] = [];
    const h = await build({
      streamHint: jest.fn(async () => ({ hint: "h", hint_level: 2, concept_tags: [] })),
    });
    h.provider.onDidChangeHintLevel((level) => levels.push(level));
    await askPastTheGate(h);
    expect(levels).toEqual([2]);
  });
});

describe("the trace exercise", () => {
  beforeEach(() => mock.__reset());

  it("renders a grid when the backend designs one", async () => {
    const h = await build({
      getTrace: jest.fn(async () => ({
        variables: ["i", "total"],
        steps: 4,
        prompt: "Trace the loop.",
      })),
    });
    await h.provider.startTrace("for i in ...", CODE);
    const table = latest(h.posted, "traceTable");
    expect(table.variables).toEqual(["i", "total"]);
    expect(table.steps).toBe(4);
  });

  it("falls back to a prediction when there is nothing to trace", async () => {
    const h = await build();
    await h.provider.startTrace("x = 1", CODE);
    expect(latest(h.posted, "predictFirst")).toBeDefined();
    expect(latest(h.posted, "traceTable")).toBeUndefined();
  });

  it("falls back when the backend names too few variables", async () => {
    const h = await build({
      getTrace: jest.fn(async () => ({ variables: ["i"], steps: 4, prompt: "T." })),
    });
    await h.provider.startTrace("x = 1", CODE);
    expect(latest(h.posted, "predictFirst")).toBeDefined();
  });

  it("submits the filled grid as a trace-check", async () => {
    const h = await build({
      getTrace: jest.fn(async () => ({
        variables: ["i", "total"],
        steps: 2,
        prompt: "Trace it.",
      })),
    });
    await h.provider.startTrace("for i in ...", CODE);
    await h.send({ type: "traceAnswer", rows: [["0", "0"], ["1", "0"]] });
    expect(hintRequest(h.api).mode).toBe("trace-check");
    expect(hintRequest(h.api).question).toContain("step | i | total");
  });

  it("ignores a trace answer with no exercise pending", async () => {
    const h = await build();
    await h.send({ type: "traceAnswer", rows: [["1"]] });
    expect(h.api.streamHint).not.toHaveBeenCalled();
  });
});

describe("prediction", () => {
  beforeEach(() => mock.__reset());

  it("frames the snippet and the prediction together", async () => {
    const h = await build();
    h.provider.startPrediction("print(x)", CODE);
    await h.send({ type: "predictAnswer", prediction: "it prints 3" });
    expect(hintRequest(h.api).mode).toBe("predict-output");
    expect(hintRequest(h.api).question).toContain("print(x)");
    expect(hintRequest(h.api).question).toContain("it prints 3");
  });

  it("ignores a blank prediction", async () => {
    const h = await build();
    h.provider.startPrediction("print(x)", CODE);
    await h.send({ type: "predictAnswer", prediction: "  " });
    expect(h.api.streamHint).not.toHaveBeenCalled();
  });
});

describe("session reset", () => {
  beforeEach(() => mock.__reset());

  it("posts the summary the backend returned", async () => {
    const h = await build();
    await h.send({ type: "reset" });
    expect(latest(h.posted, "resetDone").summary).toBe("you practised loops");
  });

  it("clears the transcript for the block in focus", async () => {
    const h = await build();
    const key = h.provider["threadKey"];
    h.provider["threads"].set(key, {
      history: [],
      bubbles: [{ role: "tutor", text: "old" }],
    });

    await h.send({ type: "reset" });
    await h.send({ type: "ready" });

    expect(latest(h.posted, "restoreChat").messages).toEqual([]);
  });

  it("re-arms the explain-first gate", async () => {
    const h = await build();
    await askPastTheGate(h);
    await h.send({ type: "reset" });
    h.posted.length = 0;
    await h.send({ type: "askHint", question: "again", code: CODE, mode: "hint" });
    expect(latest(h.posted, "explainFirst")).toBeDefined();
  });

  it("resets the status-bar level", async () => {
    const levels: number[] = [];
    const h = await build();
    h.provider.onDidChangeHintLevel((level) => levels.push(level));
    await h.send({ type: "reset" });
    expect(levels).toContain(0);
  });

  it("queues the reset when the backend is unreachable", async () => {
    // The provider logs the failure by design; keep it out of the test output.
    const logged = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const h = await build({
      resetSession: jest.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    });
    await h.send({ type: "reset" });
    expect(latest(h.posted, "resetDone").summary).toBe("");
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});

describe("persistence and plumbing", () => {
  beforeEach(() => mock.__reset());

  it("stores the transcript the webview sends on the current thread", async () => {
    const h = await build();
    await h.send({ type: "persistChat", messages: [{ role: "tutor", text: "a" }] });
    expect(h.provider["thread"].bubbles).toHaveLength(1);
  });

  it("keeps only the newest fifty turns", async () => {
    const h = await build();
    const many = Array.from({ length: 80 }, (_, i) => ({ role: "tutor", text: `t${i}` }));
    await h.send({ type: "persistChat", messages: many });
    const stored = h.provider["thread"].bubbles as Array<{ text: string }>;
    expect(stored).toHaveLength(50);
    expect(stored[49].text).toBe("t79");
  });

  it("tolerates a persist message with no payload", async () => {
    const h = await build();
    await h.send({ type: "persistChat" });
    expect(h.provider["thread"].bubbles).toEqual([]);
  });

  it("routes sign-in and sign-out to the commands", async () => {
    const h = await build();
    await h.send({ type: "signIn" });
    await h.send({ type: "signOut" });
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith("edupeer.signIn");
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith("edupeer.signOut");
  });

  it("re-reads the active file on request", async () => {
    const h = await build();
    // Switch the active file first: the focus block hasn't changed since
    // `build()`'s own "ready" call, and re-posting the same block for the
    // same reason `refreshCode` exists to avoid is exactly what the
    // "nothing the student can see has changed" guard suppresses.
    const other = mock.__makeDocument("def other(n):\n    return n * 2\n", "python", "/tmp/other.py");
    mock.window.activeTextEditor = mock.__makeEditor(other);
    await h.send({ type: "refreshCode" });
    expect(latest(h.posted, "focus").focusCode).toBe("def other(n):\n    return n * 2");
  });

  it("ignores an unknown message type", async () => {
    const h = await build();
    await expect(h.send({ type: "not-a-real-message" })).resolves.toBeUndefined();
  });

  it("reports an unsupported language as no language", async () => {
    const h = await build();
    const notes = mock.__makeDocument("# notes\n", "markdown", "/tmp/notes.md");
    mock.window.activeTextEditor = mock.__makeEditor(notes);
    await h.send({ type: "refreshCode" });
    expect(latest(h.posted, "focus").language).toBe("");
  });
});

describe("the webview document", () => {
  beforeEach(() => mock.__reset());

  it("sets a content security policy with a per-load nonce", async () => {
    const h = await build();
    expect(h.html).toContain("default-src 'none'");
    expect(h.html).toMatch(/script-src 'nonce-[A-Za-z0-9+/=]+'/);
  });

  it("does not permit inline styles", async () => {
    const h = await build();
    expect(h.html).not.toContain("unsafe-inline");
  });

  it("uses a different nonce each time it is built", async () => {
    const first = await build();
    mock.__reset();
    const second = await build();
    const nonceOf = (html: string) => /nonce-([A-Za-z0-9+/=]+)/.exec(html)![1];
    expect(nonceOf(first.html)).not.toBe(nonceOf(second.html));
  });

  it("tags both scripts with the nonce", async () => {
    const h = await build();
    const nonce = /nonce-([A-Za-z0-9+/=]+)/.exec(h.html)![1];
    expect(h.html.split(`nonce="${nonce}"`).length - 1).toBe(2);
  });

  it("restricts webview resources to the media directory", async () => {
    const posted: any[] = [];
    let options: any;
    const provider = new EduPeerSidebarProvider(
      mock.Uri.file("/ext"),
      { globalState: { get: (_k: string, f: any) => f, update: async () => undefined } } as any,
      makeApi() as any,
      { getBadges: jest.fn(async () => []) } as any,
      { getSession: () => undefined, onDidChange: jest.fn() } as any,
      undefined
    );
    provider.resolveWebviewView({
      webview: {
        set options(value: any) {
          options = value;
        },
        get options() {
          return options;
        },
        html: "",
        cspSource: "x:",
        asWebviewUri: (u: any) => u,
        postMessage: (m: any) => {
          posted.push(m);
          return Promise.resolve(true);
        },
        onDidReceiveMessage: () => ({ dispose: jest.fn() }),
      },
      show: jest.fn(),
      onDidDispose: jest.fn(() => ({ dispose: jest.fn() })),
    } as any);
    expect(options.enableScripts).toBe(true);
    expect(String(options.localResourceRoots[0])).toContain("media");
  });
});

/**
 * `resolveFocus` memoises on uri + version + cursor in a module-level cache
 * that nothing resets between tests — not `jest.resetModules()`, not the
 * vscode mock's `__reset()`. Tests in here must therefore pick path/cursor
 * combinations that collide with no other test in this file, or they will
 * silently read another test's answer. That has already produced two defects
 * (Task 3 and Task 9); `setupProvider`'s per-call path is the mitigation.
 */
describe("EduPeerSidebarProvider — focus scoping", () => {
  const vscode = require("vscode");
  beforeEach(() => vscode.__reset());

  /** One webview host, with its own message log and its own `ready` channel. */
  function makeView(posted: any[]) {
    let receive: ((msg: any) => Promise<void>) | undefined;
    const view = {
      webview: {
        options: {},
        html: "",
        cspSource: "vscode-webview:",
        asWebviewUri: (u: any) => u,
        postMessage: (msg: any) => {
          posted.push(msg);
          return Promise.resolve(true);
        },
        onDidReceiveMessage: (fn: any) => {
          receive = fn;
          return { dispose: jest.fn() };
        },
      },
      show: jest.fn(),
      onDidDispose: jest.fn(() => ({ dispose: jest.fn() })),
    } as any;
    return { view, send: (msg: any) => receive!(msg) };
  }

  it("re-posts the focus block when the sidebar is closed and reopened", async () => {
    const h = await build();

    // VS Code re-resolves the view whenever the sidebar host is recreated.
    // The reloaded webview asks for its state and must actually get it —
    // `lastFocusSignature` is provider state and outlives the webview.
    const reopened: any[] = [];
    const second = makeView(reopened);
    h.provider.resolveWebviewView(second.view);
    await second.send({ type: "ready" });

    const focus = latest(reopened, "focus");
    expect(focus).toBeDefined();
    expect(focus.focusCode).toContain("def average");
  });

  it("re-reads the active file when Refresh is pressed, unchanged or not", async () => {
    const h = await build();

    await h.send({ type: "refreshCode" });

    expect(latest(h.posted, "focus")).toBeDefined();
  });

  const SOURCE = [
    "import math",
    "",
    "def calculate_average(numbers):",
    "    total = 0",
    "    return total / len(numbers)",
  ].join("\n");

  it("posts the focus block, not the whole file", async () => {
    // Uses whatever setup helper this file already defines to build a
    // provider and resolve its webview; `posted` collects postMessage calls.
    const { provider, posted, doc } = await setupProvider(SOURCE, 4);

    await provider["sendFocus"]();

    const focusMsg = posted.find((m: any) => m.type === "focus");
    expect(focusMsg.focusCode).toBe(
      ["def calculate_average(numbers):", "    total = 0", "    return total / len(numbers)"].join("\n")
    );
    expect(focusMsg.focusCode).not.toContain("import math");
    expect(focusMsg.startLine).toBe(3); // 1-based
    expect(focusMsg.endLine).toBe(5);
    expect(focusMsg.breadcrumb).toContain("calculate_average");
    expect(focusMsg.totalLines).toBe(doc.lineCount);
  });

  it("keys the hint ladder on the function, not the file", async () => {
    const { provider } = await setupProvider(SOURCE, 4);
    await provider["sendFocus"]();

    expect(provider["lastDocumentKey"]).toContain("#calculate_average");
  });

  it("sends the whole file as code and the block as focus", async () => {
    const { provider, api } = await setupProvider(SOURCE, 4);
    await provider["sendFocus"]();

    await provider["handleAsk"]("why is it dividing by zero?", "focus block text", "hint");

    const request = api.streamHint.mock.calls[0][0];
    expect(request.code).toContain("import math");
    expect(request.focus).toEqual({
      start_line: 3,
      end_line: 5,
      label: "calculate_average",
    });
  });

  it("forgets the problem key when there is no active editor", async () => {
    const { provider } = await setupProvider(SOURCE, 4);
    await provider["sendFocus"]();
    expect(provider["lastDocumentKey"]).toContain("#");

    vscode.window.activeTextEditor = undefined;
    await provider["sendFocus"]();

    expect(provider["lastDocumentKey"]).toBe("");
  });

  it("keeps one problem key while the cursor moves over top-level code", async () => {
    // No def, no class: the heuristic finds no block and `fromWindow` labels
    // the scope "lines N-M" around the cursor. That label churns per line, and
    // keying the ladder on it made every ask a first ask — hint_level pinned
    // at 1 and the "you haven't changed anything" gate never firing, for
    // exactly the beginner writing top-level script code.
    const TOP_LEVEL = Array.from({ length: 60 }, (_, i) => `value_${i} = ${i} * 2`).join("\n");
    const { provider, posted, doc } = await setupProvider(TOP_LEVEL, 5, "/tmp/top-level/demo.py");

    await provider["sendFocus"]();
    const firstKey = provider["lastDocumentKey"];
    const firstFocus = latest(posted, "focus");

    vscode.window.activeTextEditor = vscode.__makeEditor(doc, 40);
    await provider["sendFocus"]();
    const secondFocus = latest(posted, "focus");

    expect(provider["lastDocumentKey"]).toBe(firstKey);
    // The descriptive label still travels in `focus` — the prompt wants it.
    // It is only the ladder key that stops following it.
    expect(secondFocus.breadcrumb).not.toBe(firstFocus.breadcrumb);
    expect(secondFocus.breadcrumb).toContain("lines");
  });

  it("still gives two functions in one file two different problem keys", async () => {
    const TWO_FUNCTIONS = [
      "def first():",
      "    return 1",
      "",
      "",
      "def second():",
      "    return 2",
    ].join("\n");
    const { provider, doc } = await setupProvider(TWO_FUNCTIONS, 1, "/tmp/two-keys/demo.py");

    await provider["sendFocus"]();
    const firstKey = provider["lastDocumentKey"];

    vscode.window.activeTextEditor = vscode.__makeEditor(doc, 5);
    await provider["sendFocus"]();

    expect(firstKey).toContain("#first");
    expect(provider["lastDocumentKey"]).toContain("#second");
  });

  it("gives two C functions in one file two different problem keys", async () => {
    // Labelling on the leading identifier made both of these `int`, so they
    // shared a problem_key — and the attempt tracker is keyed on it too, with
    // the focus block as its payload. Moving the cursor between them then read
    // as "the student changed the code" and walked the ladder 1→2→3 with no
    // edit at all, which is the abuse path the tracker exists to close.
    const C = [
      "int main(int argc, char **argv) {",
      "    return helper(1);",
      "}",
      "",
      "int helper(int n) {",
      "    return n + 1;",
      "}",
    ].join("\n");
    const { provider, doc } = await setupProvider(C, 1, "/tmp/c-keys/demo.c", "c");

    await provider["sendFocus"]();
    const firstKey = provider["lastDocumentKey"];

    vscode.window.activeTextEditor = vscode.__makeEditor(doc, 5);
    await provider["sendFocus"]();

    expect(firstKey).toContain("#main");
    expect(provider["lastDocumentKey"]).toContain("#helper");
  });

  it("lets a move to a different function in the same document through the suppression guard", async () => {
    const TWO_FUNCTIONS = [
      "def first():",
      "    return 1",
      "",
      "",
      "def second():",
      "    return 2",
    ].join("\n");
    const { provider, posted, doc } = await setupProvider(TWO_FUNCTIONS, 1);

    await provider["sendFocus"]();
    const first = latest(posted, "focus");

    // Same document, same version — only the cursor moves.
    vscode.window.activeTextEditor = vscode.__makeEditor(doc, 5);
    await provider["sendFocus"]();
    const second = latest(posted, "focus");

    expect(second.startLine).not.toBe(first.startLine);
    expect(second.breadcrumb).not.toBe(first.breadcrumb);
  });
});

describe("EduPeerSidebarProvider — streak chip", () => {
  /** One webview host, with its own message log and its own `ready` channel. */
  function makeView(posted: any[]) {
    let receive: ((msg: any) => Promise<void>) | undefined;
    const view = {
      webview: {
        options: {},
        html: "",
        cspSource: "vscode-webview:",
        asWebviewUri: (u: any) => u,
        postMessage: (msg: any) => {
          posted.push(msg);
          return Promise.resolve(true);
        },
        onDidReceiveMessage: (fn: any) => {
          receive = fn;
          return { dispose: jest.fn() };
        },
      },
      show: jest.fn(),
      onDidDispose: jest.fn(() => ({ dispose: jest.fn() })),
    } as any;
    return { view, send: (msg: any) => receive!(msg) };
  }

  it("re-posts the last streak when the sidebar is closed and reopened", async () => {
    const h = await build();
    h.provider.postStreak(4);

    // VS Code re-resolves the view whenever the sidebar host is recreated
    // (closing and reopening the sidebar does it — see the comment on
    // `onDidDispose` in resolveWebviewView). `post` is a no-op while there is
    // no view, so the streak pushed above never reached this new webview; it
    // must be re-sent from cached provider state on "ready", the same way
    // `postOffline`/`postAuthTrouble` re-derive from live `api` state there.
    const reopened: any[] = [];
    const second = makeView(reopened);
    h.provider.resolveWebviewView(second.view);
    await second.send({ type: "ready" });

    const streak = latest(reopened, "streak");
    expect(streak).toBeDefined();
    expect(streak.days).toBe(4);
  });
});

describe("EduPeerSidebarProvider — webview CSP", () => {
  it("allows fonts from the extension, and nothing else", async () => {
    const { html } = await setupProvider(); // returns the resolved webview html
    const csp = /content="([^"]*)"/.exec(html)![1];

    expect(csp).toContain("font-src");
    // Scoped to the extension's own directory, never a CDN.
    expect(csp).not.toContain("https://fonts.gstatic.com");
    expect(csp).not.toContain("https://fonts.googleapis.com");
    expect(csp).toContain("default-src 'none'");
  });
});

/**
 * Neither fixture reuses the default `setupProvider` path with a cursor line
 * another test in this file already resolved at that same path: `resolveFocus`
 * memoises on uri+version+cursor in a cache nothing here resets (see the
 * comment on "EduPeerSidebarProvider — focus scoping" above), so a collision
 * would silently hand back another test's cached scope.
 */
describe("EduPeerSidebarProvider — cursor vs focus", () => {
  beforeEach(() => mock.__reset());

  /** A 2-line function: the enclosing block is the same wherever the cursor lands in it. */
  const TWO_LINE_BLOCK = "def f():\n    return 1";

  const TWO_FUNCTIONS = [
    "def first():",
    "    return 1",
    "",
    "",
    "def second():",
    "    return 2",
  ].join("\n");

  /** Move the cursor within the already-open document, the way an arrow key would. */
  function moveCursor(doc: any, line: number) {
    mock.window.activeTextEditor = mock.__makeEditor(doc, line);
  }

  it("posts cursor, not focus, when only the cursor line moved", async () => {
    // Same document, same version, same block: the focus signature is
    // unchanged, so the panel would otherwise never learn the cursor moved.
    const { provider, posted, doc } = await setupProvider(
      TWO_LINE_BLOCK,
      0,
      "/tmp/cursor-vs-focus/two-line.py"
    );
    await provider["sendFocus"]();
    posted.length = 0;

    moveCursor(doc, 1);
    await provider["sendFocus"]();

    expect(posted.map((m: any) => m.type)).toEqual(["cursor"]);
    expect(posted[0].cursorLine).toBe(2);
  });

  it("posts focus when the block changed", async () => {
    const { provider, posted, doc } = await setupProvider(
      TWO_FUNCTIONS,
      1,
      "/tmp/cursor-vs-focus/two-functions.py"
    );
    await provider["sendFocus"]();
    posted.length = 0;

    moveCursor(doc, 5);
    await provider["sendFocus"]();

    expect(posted.map((m: any) => m.type)).toContain("focus");
  });
});

describe("the seeded bug marker never reaches the tutor", () => {
  beforeEach(() => mock.__reset());

  const MARKED = "def add(a, b):\n    return a + b   # bug: subtracts instead of adds\n";

  it("strips the marker from the code it sends", async () => {
    const h = await build({}, MARKED);
    await askPastTheGate(h);

    const sent = hintRequest(h.api).code;
    expect(sent).not.toContain("bug:");
    expect(sent).toContain("return a + b");
  });

  it("still shows the student their own file, comment and all", async () => {
    // The strip is for the wire only. The panel is a mirror of the buffer, so
    // hiding the comment there would leave the student reading a file that
    // does not match the one on disk.
    const { provider, posted } = await setupProvider(MARKED, 1, "/tmp/marked-focus/add.py");
    await provider["sendFocus"]();

    const focus = latest(posted, "focus");
    expect(focus.focusCode).toContain("# bug: subtracts instead of adds");
  });
});

describe("answering in chat deepens the hint", () => {
  beforeEach(() => mock.__reset());

  it("does not show the same-depth block after a real answer", async () => {
    const h = await build();
    await askPastTheGate(h);
    h.posted.length = 0;

    await h.send({ type: "askHint", question: "oh it should be a plus", code: CODE, mode: "hint" });

    const gate = h.posted.find((m: any) => m.mode === "attempt-gate");
    expect(gate).toBeUndefined();
    expect(hintRequest(h.api).escalate).toBe(true);
  });

  it("still shows it when they gave up instead", async () => {
    const h = await build();
    await askPastTheGate(h);
    h.posted.length = 0;

    await h.send({ type: "askHint", question: "i dont know", code: CODE, mode: "hint" });

    const gate = h.posted.find((m: any) => m.mode === "attempt-gate");
    expect(gate).toBeDefined();
    expect(hintRequest(h.api).escalate).toBe(false);
  });
});

describe("explain-first fires once per file", () => {
  beforeEach(() => mock.__reset());

  it("does not come back after the student edits the code", async () => {
    const h = await build();
    await h.send({ type: "askHint", question: "why is this wrong?", code: CODE, mode: "hint" });
    expect(latest(h.posted, "explainFirst")).toBeDefined();
    await h.send({ type: "explainSkip" });
    h.posted.length = 0;

    // The student edits, then asks again. The gate has already had its turn.
    await h.send({
      type: "askHint",
      question: "still stuck",
      code: CODE + "\n# tried something\n",
      mode: "hint",
    });

    expect(latest(h.posted, "explainFirst")).toBeUndefined();
  });
});

describe("one chat thread per function", () => {
  beforeEach(() => mock.__reset());

  const TWO_FUNCS = [
    "def first():",
    "    return 1",
    "",
    "",
    "def second():",
    "    return 2",
  ].join("\n");

  it("swaps the transcript when the cursor moves to another function", async () => {
    const { provider, posted, doc } = await setupProvider(TWO_FUNCS, 1, "/tmp/threads/a.py");
    await provider["sendFocus"]();
    provider["threads"].set(provider["lastDocumentKey"], {
      history: [],
      bubbles: [{ role: "tutor", text: "about first" }],
    });
    posted.length = 0;

    mock.window.activeTextEditor = mock.__makeEditor(doc, 5);
    await provider["sendFocus"]();

    const restored = latest(posted, "restoreChat");
    expect(restored).toBeDefined();
    expect(restored.messages).toEqual([]);
  });

  it("brings the first thread back when the cursor returns", async () => {
    const { provider, posted, doc } = await setupProvider(TWO_FUNCS, 1, "/tmp/threads/b.py");
    await provider["sendFocus"]();
    const firstKey = provider["lastDocumentKey"];
    provider["threads"].set(firstKey, {
      history: [],
      bubbles: [{ role: "tutor", text: "about first" }],
    });

    mock.window.activeTextEditor = mock.__makeEditor(doc, 5);
    await provider["sendFocus"]();
    mock.window.activeTextEditor = mock.__makeEditor(doc, 1);
    posted.length = 0;
    await provider["sendFocus"]();

    expect(latest(posted, "restoreChat").messages).toEqual([
      { role: "tutor", text: "about first" },
    ]);
  });

  it("keeps nothing in globalState", async () => {
    const h = await build();
    await askPastTheGate(h);

    expect(h.state.get("edupeer.chatHistory")).toBeUndefined();
  });
});

/**
 * Round-1 review, Critical 1: `this.thread` used to be re-read from live
 * focus both before the request went out and after the response came back,
 * so a cursor move mid-stream filed the answer into whichever thread was on
 * screen when it landed, not the one that asked. It also posted `restoreChat`
 * the moment the cursor moved, wiping the panel out from under a student
 * watching a streaming answer arrive. Both are fixed: `handleAsk` captures
 * its thread once, before the first await, and `sendFocus` defers the swap
 * until the ask settles.
 */
describe("thread safety while an ask is in flight", () => {
  beforeEach(() => mock.__reset());

  const TWO_FUNCS = [
    "def first():",
    "    return 1",
    "",
    "",
    "def second():",
    "    return 2",
  ].join("\n");

  it("files the answer into the thread that asked, and does not wipe the panel mid-stream", async () => {
    let resolveStream: (value: any) => void = () => {};
    const streamHint = jest.fn(
      () => new Promise((resolve) => { resolveStream = resolve; })
    );
    const { provider, posted, doc, api } = await setupProvider(
      TWO_FUNCS,
      1,
      "/tmp/threads/race.py"
    );
    api.streamHint = streamHint;

    await provider["sendFocus"]();
    const firstKey = provider["threadKey"];

    // Not awaited: `handleAsk` runs synchronously up to its first await
    // (inside `api.streamHint`), so `askInFlight` and the thread it captured
    // are already set by the time this call returns control here.
    const askPromise = provider["handleAsk"]("why does this return 1?", "code", "hint");
    expect(provider["askInFlight"]).toBe(true);

    // The cursor moves to the other function while the ask is still in flight.
    mock.window.activeTextEditor = mock.__makeEditor(doc, 5);
    posted.length = 0;
    await provider["sendFocus"]();
    const secondKey = provider["threadKey"];
    expect(secondKey).not.toBe(firstKey);

    // The panel must not be wiped while the answer is still streaming in.
    expect(posted.find((m: any) => m.type === "restoreChat")).toBeUndefined();

    resolveStream({ hint: "because it returns 1", hint_level: 1, concept_tags: [] });
    await askPromise;

    // The question and answer landed in the thread that asked...
    expect(provider["threads"].get(firstKey)!.history).toEqual([
      { role: "student", content: "why does this return 1?" },
      { role: "tutor", content: "because it returns 1" },
    ]);
    // ...not the one that happened to be on screen when the response arrived.
    expect(provider["threads"].get(secondKey)?.history ?? []).toEqual([]);

    // The deferred swap fires once the ask settles.
    expect(latest(posted, "restoreChat").messages).toEqual([]);
  });
});

/**
 * Round-1 review, Important 2: the no-active-editor path used to reset the
 * document key to "", and since that ran before the key-change comparison,
 * no `restoreChat` followed — the panel kept showing the old transcript
 * while the store had silently moved to a phantom "" bucket.
 */
describe("the thread key survives losing the active editor", () => {
  beforeEach(() => mock.__reset());

  it("does not swap to a phantom thread when there is no active editor", async () => {
    const { provider, posted } = await setupProvider(CODE, 0, "/tmp/threads/no-editor.py");
    await provider["sendFocus"]();
    const key = provider["threadKey"];
    expect(key).not.toBe("");

    posted.length = 0;
    mock.window.activeTextEditor = undefined;
    await provider["sendFocus"]();

    expect(provider["threadKey"]).toBe(key);
    expect(posted.find((m: any) => m.type === "restoreChat")).toBeUndefined();
  });
});

/**
 * Final review, Important 4 (a ruling from the human partner): reset used to
 * delete one thread while `attempts.clear()` took no key and the backend's
 * /reset dropped every hint level for the user. Resetting in `total()` left
 * `average()`'s transcript on screen stamped `hint 3` while its next ask
 * started at level 1 — the exact transcript/level mismatch this branch exists
 * to remove. Reset now clears everything, which is also what the panel has
 * always told the student it does.
 *
 * This replaces "reset clears only the current thread", which asserted the
 * behaviour the ruling reverses.
 */
describe("reset clears every thread, not just the one on screen", () => {
  beforeEach(() => mock.__reset());

  const TWO_FUNCS = [
    "def first():",
    "    return 1",
    "",
    "",
    "def second():",
    "    return 2",
  ].join("\n");

  it("wipes another function's transcript too, so no thread outlives its ladder", async () => {
    const { provider, doc } = await setupProvider(
      TWO_FUNCS,
      1,
      "/tmp/threads/reset-isolation.py"
    );
    await provider["sendFocus"]();
    const firstKey = provider["threadKey"];
    provider["threads"].set(firstKey, {
      history: [{ role: "student", content: "q1" }],
      bubbles: [{ role: "tutor", text: "about first" }],
    });

    mock.window.activeTextEditor = mock.__makeEditor(doc, 5);
    await provider["sendFocus"]();
    const secondKey = provider["threadKey"];
    provider["threads"].set(secondKey, {
      history: [{ role: "student", content: "q2" }],
      bubbles: [{ role: "tutor", text: "about second" }],
    });

    // Reset while the cursor is in `second`.
    await provider.resetSession();

    expect(provider["threads"].has(secondKey)).toBe(false);
    // `first`'s ladder is gone (attempts.clear() takes no key), so its
    // transcript must not survive to be read beside a depth that no longer
    // exists.
    expect(provider["threads"].has(firstKey)).toBe(false);
  });

  it("leaves the first ask after a reset escalating from scratch in every thread", async () => {
    const { provider, doc, api } = await setupProvider(
      TWO_FUNCS,
      1,
      "/tmp/threads/reset-ladder.py"
    );
    await provider["sendFocus"]();
    await provider["handleAsk"]("why does this return 1?", "code", "hint");

    // A different function, so a different ladder — then reset from here.
    mock.window.activeTextEditor = mock.__makeEditor(doc, 5);
    await provider["sendFocus"]();
    await provider.resetSession();

    // Back in the first function: its ladder was cleared with everything
    // else, so this reads as a first ask.
    mock.window.activeTextEditor = mock.__makeEditor(doc, 1);
    await provider["sendFocus"]();
    await provider["handleAsk"]("and now?", "code", "hint");

    expect(api.streamHint.mock.calls.at(-1)[0].escalate).toBe(true);
    expect(provider["threads"].get(provider["threadKey"])!.history).toEqual([
      { role: "student", content: "and now?" },
      { role: "tutor", content: "What does len(n) return when n is empty?" },
    ]);
  });
});

/**
 * Round-1 review, Important 4 (a ruling from the human partner, overriding
 * the brief's "keyed exactly as the hint ladder is" wording): a selection or
 * a click on a blank line resolves to a file-level focus, and swapping the
 * thread on that blanked the panel mid-conversation for an ordinary cursor
 * gesture. The thread now follows named blocks only.
 */
describe("the sticky thread key", () => {
  beforeEach(() => mock.__reset());

  const TWO_FUNCS = [
    "def first():",
    "    return 1",
    "",
    "",
    "def second():",
    "    return 2",
  ].join("\n");

  it("keeps the enclosing function's thread when the focus is a selection, not a named block", async () => {
    const { provider, posted, doc } = await setupProvider(TWO_FUNCS, 1, "/tmp/threads/sticky.py");
    await provider["sendFocus"]();
    const key = provider["threadKey"];
    expect(key).toContain("#first");

    // A non-empty selection inside `first`'s body: `resolveFocus` ranks a
    // selection above the heuristic block, so `focus.kind` becomes
    // "selection" even though the student never left the function.
    mock.window.activeTextEditor = {
      document: doc,
      selection: new mock.Selection(new mock.Position(1, 4), new mock.Position(1, 12)),
      setDecorations: jest.fn(),
      revealRange: jest.fn(),
    };
    posted.length = 0;
    await provider["sendFocus"]();

    expect(provider["threadKey"]).toBe(key);
    expect(posted.find((m: any) => m.type === "restoreChat")).toBeUndefined();
  });

  it("keeps the previous function's thread when the cursor lands on a blank line between functions", async () => {
    const { provider, posted, doc } = await setupProvider(
      TWO_FUNCS,
      1,
      "/tmp/threads/sticky-blank.py"
    );
    await provider["sendFocus"]();
    const key = provider["threadKey"];

    // Line 2 (0-based) is one of the blank lines between the two functions:
    // outside `first`'s indented body, so the heuristic finds no enclosing
    // block and `resolveFocus` falls through to a file-level "window" focus.
    mock.window.activeTextEditor = mock.__makeEditor(doc, 2);
    posted.length = 0;
    await provider["sendFocus"]();

    expect(provider["threadKey"]).toBe(key);
    expect(posted.find((m: any) => m.type === "restoreChat")).toBeUndefined();
  });
});

/**
 * Final review, Critical 1: `restoreChat` tears the panel down to another
 * thread's bubbles, so the explain-first card and its Skip button are gone
 * from the screen — but the host went on holding `pendingAsk`. The student's
 * next question was then popped off as an *explanation* of the function they
 * had just left: never answered, and filed into the wrong transcript. The
 * webview half (composerMode) is covered in webviewMain.test.ts.
 */
describe("a thread swap drops the exercise the panel was waiting on", () => {
  beforeEach(() => mock.__reset());

  const TWO_FUNCS = [
    "def first():",
    "    return 1",
    "",
    "",
    "def second():",
    "    return 2",
  ].join("\n");

  it("does not consume the next question as an explanation of the function they left", async () => {
    const { provider, posted, doc, api } = await setupProvider(
      TWO_FUNCS,
      1,
      "/tmp/pending/explain-swap.py"
    );
    await provider["sendFocus"]();

    // Asking about `first` trips the explain-first gate, which parks the ask.
    await provider["handleAskFromWebview"]("why does first return 1?", "code", "hint");
    expect(latest(posted, "explainFirst")).toBeDefined();
    expect(provider["pendingAsk"]).toBeDefined();

    // The student clicks into `second`. Nothing is in flight, so the swap is
    // immediate and the card disappears.
    mock.window.activeTextEditor = mock.__makeEditor(doc, 5);
    await provider["sendFocus"]();

    expect(provider["pendingAsk"]).toBeUndefined();

    // Their next question arrives while the webview is still in explain mode
    // (a stale webview, or one that missed the reset). The host must not
    // answer it with `first`'s parked question.
    await provider["handleExplainAnswer"]("why does second return 2?");

    expect(api.streamHint).not.toHaveBeenCalled();
  });

  it("drops a paused prediction rather than marking it against another function", async () => {
    const { provider, doc, api } = await setupProvider(
      TWO_FUNCS,
      1,
      "/tmp/pending/predict-swap.py"
    );
    await provider["sendFocus"]();
    provider.startPrediction("print(x)", "code");

    mock.window.activeTextEditor = mock.__makeEditor(doc, 5);
    await provider["sendFocus"]();

    await provider["handlePredictAnswer"]("it prints 3");
    expect(api.streamHint).not.toHaveBeenCalled();
  });

  it("drops a paused trace and a paused review too", async () => {
    const { provider, doc } = await setupProvider(TWO_FUNCS, 1, "/tmp/pending/trace-swap.py");
    await provider["sendFocus"]();
    provider["pendingTrace"] = { snippet: "s", code: "c", variables: ["i", "total"] };
    provider["pendingReview"] = "an exercise from days ago";

    mock.window.activeTextEditor = mock.__makeEditor(doc, 5);
    await provider["sendFocus"]();

    expect(provider["pendingTrace"]).toBeUndefined();
    expect(provider["pendingReview"]).toBeUndefined();
  });
});

/**
 * Final review, Important 3: `handleAsk` ran `isAttempt` over whatever string
 * it was handed, and three entry points hand it canned text — "analyse
 * selection", the Quick Fix on a diagnostic, and the test watcher's "Talk it
 * through". None contains a give-up phrase, so all three scored as attempts
 * and clicking one repeatedly walked the ladder to pseudocode with the student
 * having typed nothing. That is the hint-abuse path the tracker exists to
 * close.
 */
describe("machine-generated questions are not student attempts", () => {
  beforeEach(() => mock.__reset());

  it("does not walk the ladder for a repeated right-click on an unchanged selection", async () => {
    const h = await build();

    await h.provider.askExternal("What is wrong with this selection?", CODE);
    expect(hintRequest(h.api).escalate).toBe(true); // the first ask always is
    h.posted.length = 0;
    await h.provider.askExternal("What is wrong with this selection?", CODE);

    expect(hintRequest(h.api).escalate).toBe(false);
    expect(h.posted.find((m: any) => m.mode === "attempt-gate")).toBeDefined();
  });

  it("does not count the Quick Fix's canned question as an attempt", async () => {
    const h = await build();

    const canned = `What is wrong with these lines?\n\n${CODE}`;
    await h.provider.askExternal(canned, CODE);
    await h.provider.askExternal(canned, CODE);

    expect(hintRequest(h.api).escalate).toBe(false);
  });

  it("does not count the test watcher's failure report as an attempt", async () => {
    const h = await build();

    const question = formatTestFailureQuestion("test_average", "AssertionError: 0 != 3");
    await h.provider.askExternal(question, CODE, "hint");
    await h.provider.askExternal(question, CODE, "hint");

    expect(hintRequest(h.api).escalate).toBe(false);
  });

  it("still escalates on a question the student actually typed", async () => {
    // The control: the gate closes on machine text without closing on people.
    const h = await build();
    await askPastTheGate(h);

    await h.send({
      type: "askHint",
      question: "maybe len(n) is zero when the list is empty",
      code: CODE,
      mode: "hint",
    });

    expect(hintRequest(h.api).escalate).toBe(true);
  });
});

/**
 * Final review, Important 3 (the folded-in deferred finding): the explain-first
 * flow judged `frameExplainedQuestion`'s combined "explanation + question"
 * string, so a give-up phrase in either half condemned the whole ask. Each raw
 * message is now judged on its own.
 */
describe("the explain-first gate judges what the student typed", () => {
  beforeEach(() => mock.__reset());

  /** Re-arm the gate without disturbing the ladder it sits in front of. */
  async function armTheGateAgain(h: Harness) {
    await askPastTheGate(h);
    h.provider["explainedFiles"].clear();
    h.posted.length = 0;
  }

  it("does not let a shrugged explanation condemn a real question", async () => {
    const h = await build();
    await armTheGateAgain(h);

    await h.send({ type: "askHint", question: "maybe len(n) is zero", code: CODE, mode: "hint" });
    expect(latest(h.posted, "explainFirst")).toBeDefined();
    await h.send({ type: "explainAnswer", explanation: "idk" });

    expect(hintRequest(h.api).escalate).toBe(true);
  });

  it("counts the explanation when the question itself was a shrug", async () => {
    const h = await build();
    await armTheGateAgain(h);

    await h.send({ type: "askHint", question: "idk", code: CODE, mode: "hint" });
    await h.send({ type: "explainAnswer", explanation: "i think it divides by the length" });

    expect(hintRequest(h.api).escalate).toBe(true);
  });

  it("holds the depth when both halves are a shrug", async () => {
    // The framing wrapper reads as prose, so judging it instead of the two raw
    // messages scored this pair as a real attempt.
    const h = await build();
    await armTheGateAgain(h);

    await h.send({ type: "askHint", question: "idk", code: CODE, mode: "hint" });
    await h.send({ type: "explainAnswer", explanation: "idk" });

    expect(hintRequest(h.api).escalate).toBe(false);
  });

  it("carries the typed question through a skip", async () => {
    const h = await build();
    await armTheGateAgain(h);

    await h.send({ type: "askHint", question: "maybe len(n) is zero", code: CODE, mode: "hint" });
    await h.send({ type: "explainSkip" });

    expect(hintRequest(h.api).escalate).toBe(true);
  });

  it("does not turn a skipped shrug into an attempt", async () => {
    const h = await build();
    await armTheGateAgain(h);

    await h.send({ type: "askHint", question: "idk", code: CODE, mode: "hint" });
    await h.send({ type: "explainSkip" });

    expect(hintRequest(h.api).escalate).toBe(false);
  });
});

/**
 * Final review, Important 5 (a ruling from the human partner): `threadKey` is
 * sticky and moves only on a named block, but the ladder still keyed off
 * `lastDocumentKey`, which `resolveFocus` collapses to the bare file uri the
 * moment a selection outranks the enclosing symbol. Selecting two lines
 * *inside* a function dropped the level 3 → 1 and bounced it back on deselect,
 * while the transcript correctly held. The ladder now rides the same sticky
 * key the conversation does.
 */
describe("the hint ladder follows the sticky thread key", () => {
  beforeEach(() => mock.__reset());

  /** `first` is four lines, so two of them can be selected from inside it. */
  const TWO_FUNCS = [
    "def first():",
    "    total = 0",
    "    total += 1",
    "    return total",
    "",
    "",
    "def second():",
    "    return 2",
  ].join("\n");

  /**
   * Select two lines inside `first`. `resolveFocus` ranks an explicit
   * selection above the enclosing symbol, so the focus collapses to a
   * file-level "selection" while the student never left the function.
   */
  function selectTwoLinesInside(doc: any) {
    mock.window.activeTextEditor = {
      document: doc,
      selection: new mock.Selection(new mock.Position(1, 4), new mock.Position(2, 15)),
      setDecorations: jest.fn(),
      revealRange: jest.fn(),
    };
  }

  it("sends one problem_key either side of a selection inside the same function", async () => {
    const { provider, doc, api } = await setupProvider(TWO_FUNCS, 1, "/tmp/ladder/selection.py");
    await provider["sendFocus"]();
    await provider["handleAsk"]("why is total wrong?", "code", "hint");
    const firstKey = hintRequest(api).problem_key;
    expect(firstKey).toContain("#first");

    selectTwoLinesInside(doc);
    await provider["sendFocus"]();
    // The divergence this test exists for: the block key really did collapse
    // to the bare file, while the conversation correctly stayed put.
    expect(provider["lastDocumentKey"]).not.toContain("#");
    expect(provider["threadKey"]).toBe(firstKey);

    await provider["handleAsk"]("and now?", "code", "hint");

    expect(hintRequest(api).problem_key).toBe(firstKey);
  });

  it("records the attempt under the sticky key, not the collapsed one", async () => {
    const fileKey = "file:///tmp/ladder/record.py";
    const { provider, doc } = await setupProvider(TWO_FUNCS, 1, "/tmp/ladder/record.py");
    await provider["sendFocus"]();
    await provider["handleAsk"]("why is total wrong?", "code", "hint");

    selectTwoLinesInside(doc);
    await provider["sendFocus"]();
    await provider["handleAsk"]("and now?", "code", "hint");

    // The tracker knows this problem by the thread's name...
    expect(provider["attempts"].evaluate(provider["threadKey"], "x", Date.now()).signal).not.toBe(
      "first"
    );
    // ...and has never heard of the file-level key the selection collapsed to.
    // Splitting the ladder across the two is what dropped the level 3 → 1 on
    // select and bounced it back on deselect.
    expect(provider["attempts"].evaluate(fileKey, "x", Date.now()).signal).toBe("first");
  });

  it("still gives two functions two different ladders", async () => {
    const { provider, doc, api } = await setupProvider(TWO_FUNCS, 1, "/tmp/ladder/two.py");
    await provider["sendFocus"]();
    await provider["handleAsk"]("why is total wrong?", "code", "hint");
    const firstKey = hintRequest(api).problem_key;

    mock.window.activeTextEditor = mock.__makeEditor(doc, 7);
    await provider["sendFocus"]();
    await provider["handleAsk"]("and this one?", "code", "hint");

    expect(hintRequest(api).problem_key).not.toBe(firstKey);
    expect(hintRequest(api).escalate).toBe(true);
  });
});

/**
 * Final review, Minor 6: `handleAsk`'s finally posted the deferred swap
 * unconditionally. A cursor that went A → B → A during a stream left
 * `pendingThreadSwap` set, so the finally re-posted A's stored bubbles — which
 * only contain the answer that just streamed in if the webview's `persistChat`
 * round trip has already drained. It usually has not, so the student watched
 * their answer vanish.
 */
describe("a cursor round trip during a stream leaves the panel alone", () => {
  beforeEach(() => mock.__reset());

  const TWO_FUNCS = [
    "def first():",
    "    return 1",
    "",
    "",
    "def second():",
    "    return 2",
  ].join("\n");

  it("does not re-post the thread the webview is already rendering", async () => {
    let resolveStream: (value: any) => void = () => {};
    const { provider, posted, doc, api } = await setupProvider(
      TWO_FUNCS,
      1,
      "/tmp/threads/round-trip.py"
    );
    api.streamHint = jest.fn(() => new Promise((resolve) => { resolveStream = resolve; }));
    await provider["sendFocus"]();
    const startKey = provider["threadKey"];

    const askPromise = provider["handleAsk"]("why does this return 1?", "code", "hint");

    // A → B → A, all while the answer is still streaming.
    mock.window.activeTextEditor = mock.__makeEditor(doc, 5);
    await provider["sendFocus"]();
    mock.window.activeTextEditor = mock.__makeEditor(doc, 1);
    await provider["sendFocus"]();
    expect(provider["threadKey"]).toBe(startKey);

    posted.length = 0;
    resolveStream({ hint: "because it returns 1", hint_level: 1, concept_tags: [] });
    await askPromise;

    expect(posted.find((m: any) => m.type === "restoreChat")).toBeUndefined();
  });
});

/**
 * Final review, Minor 10: `startReview` read `this.thread` after its own await,
 * the same aliasing the streaming path was already fixed for, and held no
 * in-flight flag — so a focus change during the fetch both wiped the panel
 * under the spinner and filed the exercise into whichever thread arrived.
 */
describe("a review exercise belongs to the thread that asked for it", () => {
  beforeEach(() => mock.__reset());

  const TWO_FUNCS = [
    "def first():",
    "    return 1",
    "",
    "",
    "def second():",
    "    return 2",
  ].join("\n");

  it("does not land in whichever function is on screen when it arrives", async () => {
    let resolveReview: (value: any) => void = () => {};
    const { provider, posted, doc, api } = await setupProvider(
      TWO_FUNCS,
      1,
      "/tmp/threads/review-race.py"
    );
    api.getReview = jest.fn(() => new Promise((resolve) => { resolveReview = resolve; }));
    await provider["sendFocus"]();
    const firstKey = provider["threadKey"];

    const reviewPromise = provider["startReview"]();

    mock.window.activeTextEditor = mock.__makeEditor(doc, 5);
    posted.length = 0;
    await provider["sendFocus"]();
    const secondKey = provider["threadKey"];
    expect(secondKey).not.toBe(firstKey);
    // The panel must not clear out from under the spinner.
    expect(posted.find((m: any) => m.type === "restoreChat")).toBeUndefined();

    resolveReview({ due: true, concepts: ["loops"], exercise: "Write a loop that sums a list." });
    await reviewPromise;

    expect(provider["threads"].get(firstKey)!.history).toEqual([
      { role: "tutor", content: "Write a loop that sums a list." },
    ]);
    expect(provider["threads"].get(secondKey)?.history ?? []).toEqual([]);
    // ...and the withheld swap fires once it settles.
    expect(latest(posted, "restoreChat")).toBeDefined();
  });
});

it("offers a quiz, not a claim that you fixed it", async () => {
  const h = await build();
  expect(h.html).toContain(">Quiz me<");
  expect(h.html).not.toContain("I fixed it");
  expect(h.html).not.toContain("How sure are you?");
});

describe("selecting text is not an edit", () => {
  beforeEach(() => mock.__reset());

  const TWO_FUNCS = [
    "def first():",
    "    total = 0",
    "    total += 1",
    "    return total",
    "",
    "",
    "def second():",
    "    return 2",
  ].join("\n");

  function selectTwoLinesInside(doc: any) {
    mock.window.activeTextEditor = {
      document: doc,
      selection: new mock.Selection(new mock.Position(1, 4), new mock.Position(2, 15)),
      setDecorations: jest.fn(),
      revealRange: jest.fn(),
    };
  }

  it("sends no edit_summary when the student only selected some lines", async () => {
    const { provider, doc, api } = await setupProvider(TWO_FUNCS, 1, "/tmp/selectdiff/a.py");
    await provider["sendFocus"]();
    await provider["handleAsk"]("why is total wrong?", "code", "hint");

    // Selecting collapses the focus to the two lines while the thread key
    // stays on `first`. The code compared has to stay on `first` too, or the
    // tracker reads "the function became two lines" as an edit.
    selectTwoLinesInside(doc);
    await provider["sendFocus"]();
    await provider["handleAsk"]("and now?", "code", "hint");

    expect(hintRequest(api).edit_summary).toBe("");
  });

  it("still reports a real edit made while a selection is live", async () => {
    const { provider, doc, api } = await setupProvider(TWO_FUNCS, 1, "/tmp/selectdiff/b.py");
    await provider["sendFocus"]();
    await provider["handleAsk"]("why is total wrong?", "code", "hint");

    doc.__setText(TWO_FUNCS.replace("total += 1", "total += 2"));
    selectTwoLinesInside(doc);
    await provider["sendFocus"]({ force: true });
    await provider["handleAsk"]("i changed it", "code", "hint");

    expect(hintRequest(api).edit_summary).toContain("total += 2");
  });
});

describe("answer on request", () => {
  beforeEach(() => mock.__reset());

  it("routes an outright request to answer mode", async () => {
    const h = await build();
    await h.send({ type: "askHint", question: "just tell me the answer", code: CODE, mode: "hint" });
    expect(hintRequest(h.api).mode).toBe("answer");
  });

  it("leaves an ordinary question in hint mode", async () => {
    const h = await build();
    await askPastTheGate(h, "what does range do");
    expect(hintRequest(h.api).mode).toBe("hint");
  });

  it("skips the explain-first gate", async () => {
    // Explain-first guards hint mode only. An answer request must not be held
    // behind "explain it in your own words" before the student sees anything —
    // note this test deliberately uses h.send directly rather than
    // askPastTheGate, because the gate firing at all is the failure.
    const h = await build();
    await h.send({ type: "askHint", question: "just tell me the answer", code: CODE, mode: "hint" });
    expect(latest(h.posted, "explainFirst")).toBeUndefined();
  });

  it("does not spend a rung", async () => {
    // Not a hint, so `attempts.evaluate` never runs: the first real hint that
    // follows still starts the ladder at 1.
    const h = await build();
    await h.send({ type: "askHint", question: "show me the solution", code: CODE, mode: "hint" });
    expect(hintRequest(h.api).mode).toBe("answer");
    await askPastTheGate(h);
    expect(hintRequest(h.api).mode).toBe("hint");
  });
});
