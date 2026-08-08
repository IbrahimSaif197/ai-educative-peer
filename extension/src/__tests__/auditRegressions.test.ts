/**
 * Regressions for the extension-side defects found in the 2026-08-06 audit.
 *
 * The suites next to this one are organised by module; this one is organised
 * by defect, so each block states the wrong behaviour it pins shut.
 */
import * as vscode from "vscode";
import { AttemptTracker, normalizeCode } from "../attemptTracker";
import { EduPeerSidebarProvider } from "../sidebarProvider";
import { InlineTutor } from "../inlineTutor";
import { RateLimitError } from "../apiClient";

const mock = vscode as any;

const CODE = "def average(n):\n    return sum(n) / len(n)\n";

// --------------------------------------------------------------- attempt gate

describe("the attempt gate ignores whitespace-only edits", () => {
  it("treats a trailing blank line as no attempt", () => {
    const tracker = new AttemptTracker();
    tracker.record("doc", CODE, 0);
    const result = tracker.evaluate("doc", CODE + "\n", 1000);
    expect(result.signal).toBe("unchanged");
    expect(result.escalate).toBe(false);
  });

  it("reports no edit summary for a whitespace-only change", () => {
    // Otherwise the tutor is told the student made an edit they did not make.
    const tracker = new AttemptTracker();
    tracker.record("doc", CODE, 0);
    expect(tracker.evaluate("doc", CODE + "   \n", 1000).editSummary).toBe("");
  });

  it("treats trailing spaces on an existing line as no attempt", () => {
    const tracker = new AttemptTracker();
    tracker.record("doc", "x = 1\ny = 2", 0);
    expect(tracker.evaluate("doc", "x = 1   \ny = 2  ", 1000).signal).toBe("unchanged");
  });

  it("still counts a real edit as an attempt", () => {
    const tracker = new AttemptTracker();
    tracker.record("doc", CODE, 0);
    const result = tracker.evaluate("doc", CODE.replace("sum", "total"), 1000);
    expect(result.signal).toBe("changed");
    expect(result.escalate).toBe(true);
    expect(result.editSummary).not.toBe("");
  });

  it("still escalates after the cooldown on unchanged code", () => {
    const tracker = new AttemptTracker(1000);
    tracker.record("doc", CODE, 0);
    expect(tracker.evaluate("doc", CODE + "\n", 5000).signal).toBe("stalled");
  });
});

describe("normalizeCode", () => {
  it("matches the backend's notion of the same code", () => {
    // Mirrors backend/session_store.py: strip the whole thing, right-strip
    // each line. Indentation inside the file is preserved.
    expect(normalizeCode("  x = 1  \n\n    y = 2   \n\n")).toBe("x = 1\n\n    y = 2");
  });

  it("is stable for identical input", () => {
    expect(normalizeCode(CODE)).toBe(normalizeCode(CODE));
  });
});

// ------------------------------------------------------------ sidebar asks

interface Harness {
  provider: EduPeerSidebarProvider;
  posted: any[];
  send: (msg: any) => Promise<void>;
  api: any;
}

function build(apiOverrides: Record<string, any> = {}): Harness {
  const posted: any[] = [];
  const state = new Map<string, any>();
  let receive: ((msg: any) => Promise<void>) | undefined;

  const api = {
    isAvailable: true,
    streamHint: jest.fn(async () => ({
      hint: "What does len(n) return?",
      hint_level: 1,
      concept_tags: ["functions"],
    })),
    getHint: jest.fn(async () => ({ hint: "fallback", hint_level: 1, concept_tags: [] })),
    getTrace: jest.fn(async () => ({ variables: [], steps: 0, prompt: "" })),
    getReview: jest.fn(async () => ({ due: false, concepts: [], exercise: "" })),
    resetSession: jest.fn(async () => "you practised loops"),
    ...apiOverrides,
  };

  const context = {
    globalState: {
      get: (key: string, fallback: any) => (state.has(key) ? state.get(key) : fallback),
      update: async (key: string, value: any) => void state.set(key, value),
    },
  } as any;

  const doc = mock.__makeDocument(CODE, "python", "/tmp/demo.py");
  mock.window.activeTextEditor = mock.__makeEditor(doc);

  const provider = new EduPeerSidebarProvider(
    mock.Uri.file("/ext"),
    context,
    api as any,
    { getBadges: jest.fn(async () => []) } as any,
    { getSession: () => undefined, onDidChange: jest.fn() } as any,
    { enqueue: jest.fn(async () => undefined) } as any
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

  return { provider, posted, api, send: (msg: any) => receive!(msg) };
}

const ofType = (posted: any[], type: string) => posted.filter((m) => m.type === type);

beforeEach(() => mock.__reset());

describe("the hint ladder is keyed on the problem", () => {
  it("sends the document uri as problem_key", async () => {
    const h = build();
    await h.send({ type: "ready" });
    await h.send({ type: "askHint", question: "help", code: CODE, mode: "hint" });
    await h.send({ type: "explainSkip" });
    const req = h.api.streamHint.mock.calls[0][0];
    expect(req.problem_key).toBe(mock.window.activeTextEditor.document.uri.toString());
  });
});

describe("overlapping asks", () => {
  it("refuses a second ask while one is in flight", async () => {
    let release: (v: any) => void = () => {};
    const h = build({
      streamHint: jest.fn(
        () => new Promise((r) => (release = r as any))
      ),
    });
    await h.send({ type: "ready" });

    const first = h.send({ type: "askHint", question: "one", code: CODE, mode: "reflect" });
    const second = h.send({ type: "askHint", question: "two", code: CODE, mode: "reflect" });
    await second;

    // The refusal is a withholding message, not a second stream.
    expect(ofType(h.posted, "streamStart")).toHaveLength(1);
    expect(
      ofType(h.posted, "hint").some((m) => m.mode === "attempt-gate")
    ).toBe(true);

    release({ hint: "done", hint_level: 1, concept_tags: [] });
    await first;
  });

  it("tags each stream with a sequence number", async () => {
    const h = build();
    await h.send({ type: "ready" });
    await h.send({ type: "askHint", question: "a", code: CODE, mode: "reflect" });
    await h.send({ type: "askHint", question: "b", code: CODE, mode: "reflect" });
    const seqs = ofType(h.posted, "streamStart").map((m) => m.seq);
    expect(seqs).toEqual([1, 2]);
  });

  it("accepts a new ask once the first finishes", async () => {
    const h = build();
    await h.send({ type: "ready" });
    await h.send({ type: "askHint", question: "a", code: CODE, mode: "reflect" });
    await h.send({ type: "askHint", question: "b", code: CODE, mode: "reflect" });
    expect(h.api.streamHint).toHaveBeenCalledTimes(2);
  });
});

describe("reset during an in-flight ask", () => {
  it("drops the late response instead of re-seeding the cleared chat", async () => {
    let release: (v: any) => void = () => {};
    const h = build({
      streamHint: jest.fn(() => new Promise((r) => (release = r as any))),
    });
    await h.send({ type: "ready" });

    const ask = h.send({ type: "askHint", question: "one", code: CODE, mode: "reflect" });
    await h.send({ type: "reset" });
    release({ hint: "late hint", hint_level: 3, concept_tags: [] });
    await ask;

    expect(ofType(h.posted, "hint").some((m) => m.hint === "late hint")).toBe(false);
  });

  it("does not surface an error from an ask the student already reset", async () => {
    let fail: (e: any) => void = () => {};
    const h = build({
      streamHint: jest.fn(() => new Promise((_r, j) => (fail = j as any))),
      getHint: jest.fn(() => Promise.reject(new Error("backend exploded"))),
    });
    await h.send({ type: "ready" });

    const ask = h.send({ type: "askHint", question: "one", code: CODE, mode: "reflect" });
    await h.send({ type: "reset" });
    fail(new Error("stream died"));
    await ask;

    expect(ofType(h.posted, "error")).toHaveLength(0);
  });

  it("still clears the loading state after a dropped response", async () => {
    let release: (v: any) => void = () => {};
    const h = build({
      streamHint: jest.fn(() => new Promise((r) => (release = r as any))),
    });
    await h.send({ type: "ready" });
    const ask = h.send({ type: "askHint", question: "one", code: CODE, mode: "reflect" });
    await h.send({ type: "reset" });
    release({ hint: "late", hint_level: 1, concept_tags: [] });
    await ask;
    expect(ofType(h.posted, "loading").pop().value).toBe(false);
  });
});

describe("the webview view releases its listeners", () => {
  it("disposes the editor listeners when the view goes away", () => {
    let onDispose: (() => void) | undefined;
    const posted: any[] = [];
    const provider = new EduPeerSidebarProvider(
      mock.Uri.file("/ext"),
      {
        globalState: { get: (_k: string, f: any) => f, update: async () => undefined },
      } as any,
      { isAvailable: true, getReview: jest.fn(async () => ({ due: false })) } as any,
      { getBadges: jest.fn(async () => []) } as any,
      { getSession: () => undefined, onDidChange: jest.fn(() => ({ dispose: jest.fn() })) } as any,
      undefined
    );

    const before = mock.__state.listeners.textDocument.length;
    provider.resolveWebviewView({
      webview: {
        options: {},
        html: "",
        cspSource: "x:",
        asWebviewUri: (u: any) => u,
        postMessage: (m: any) => (posted.push(m), Promise.resolve(true)),
        onDidReceiveMessage: () => ({ dispose: jest.fn() }),
      },
      show: jest.fn(),
      onDidDispose: jest.fn((fn: any) => ((onDispose = fn), { dispose: jest.fn() })),
    } as any);

    expect(mock.__state.listeners.textDocument.length).toBe(before + 1);
    expect(onDispose).toBeDefined();
    // Every subscription taken in resolveWebviewView must be handed back.
    const disposables = mock.workspace.onDidChangeTextDocument.mock.results.map(
      (r: any) => r.value
    );
    onDispose!();
    expect(disposables[disposables.length - 1].dispose).toHaveBeenCalled();
  });
});

// ------------------------------------------------------------- inline tutor

function makeTutor(api: any) {
  const context = { subscriptions: [] as any[] } as any;
  const tutor = new InlineTutor(context, api);
  tutor.activate();
  return tutor;
}

describe("a failed scan is retried", () => {
  it("does not suppress the next scan of the same content", async () => {
    const scanCode = jest
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue({ flags: [] });
    const api = { isAvailable: true, scanCode, getLineHint: jest.fn() } as any;
    const doc = mock.__makeDocument("x = 1", "python", "/tmp/a.py");
    mock.window.activeTextEditor = mock.__makeEditor(doc);

    const tutor = makeTutor(api);
    await (tutor as any).runScan(doc);
    await (tutor as any).runScan(doc);
    expect(scanCode).toHaveBeenCalledTimes(2);
    tutor.dispose();
  });

  it("still de-dupes after a scan that succeeded", async () => {
    const scanCode = jest.fn().mockResolvedValue({ flags: [] });
    const api = { isAvailable: true, scanCode, getLineHint: jest.fn() } as any;
    const doc = mock.__makeDocument("x = 1", "python", "/tmp/a.py");
    mock.window.activeTextEditor = mock.__makeEditor(doc);

    const tutor = makeTutor(api);
    await (tutor as any).runScan(doc);
    await (tutor as any).runScan(doc);
    expect(scanCode).toHaveBeenCalledTimes(1);
    tutor.dispose();
  });

  it("retries after a 429 once the quiet window has passed", async () => {
    const scanCode = jest
      .fn()
      .mockRejectedValueOnce(new RateLimitError(1))
      .mockResolvedValue({ flags: [] });
    const api = { isAvailable: true, scanCode, getLineHint: jest.fn() } as any;
    const doc = mock.__makeDocument("x = 1", "python", "/tmp/a.py");
    mock.window.activeTextEditor = mock.__makeEditor(doc);

    const tutor = makeTutor(api);
    await (tutor as any).runScan(doc);
    await (tutor as any).runScan(doc);
    expect(scanCode).toHaveBeenCalledTimes(2);
    tutor.dispose();
  });
});

describe("per-file state is released when a document closes", () => {
  it("forgets the file's scan state and diagnostics", async () => {
    // FileState (a single per-file blob) was replaced by three maps: the
    // AnnotationStore itself plus the two fingerprints that de-dupe scans.
    // All three must be released together, or a closed document's identity
    // (its URI) keeps a slot in one of them for the rest of the session.
    const scanCode = jest.fn().mockResolvedValue({ flags: [] });
    const api = { isAvailable: true, scanCode, getLineHint: jest.fn() } as any;
    const doc = mock.__makeDocument("x = 1", "python", "/tmp/a.py");
    mock.window.activeTextEditor = mock.__makeEditor(doc);

    const tutor = makeTutor(api);
    await (tutor as any).runScan(doc);
    expect((tutor as any).stores.size).toBe(1);
    expect((tutor as any).scanFingerprints.size).toBe(1);

    for (const fn of mock.__state.listeners.closeTextDocument) fn(doc);
    expect((tutor as any).stores.size).toBe(0);
    expect((tutor as any).scanFingerprints.size).toBe(0);
    expect((tutor as any).inFlightFingerprints.size).toBe(0);
    tutor.dispose();
  });
});

describe("ghost hints do not linger in a split view", () => {
  it("clears the decoration on every other visible editor", async () => {
    const api = {
      isAvailable: true,
      scanCode: jest.fn().mockResolvedValue({ flags: [] }),
      getLineHint: jest.fn(),
    } as any;
    const doc = mock.__makeDocument("x = 1", "python", "/tmp/a.py");
    const active = mock.__makeEditor(doc);
    const other = mock.__makeEditor(doc);
    mock.window.activeTextEditor = active;
    mock.window.visibleTextEditors = [active, other];

    const tutor = makeTutor(api);
    (tutor as any).renderActiveLineDecoration(active);

    const cleared = other.setDecorations.mock.calls.some(
      (call: any[]) => Array.isArray(call[1]) && call[1].length === 0
    );
    expect(cleared).toBe(true);
    tutor.dispose();
  });
});

// ------------------------------------------------------- spaced review answer

describe("a spaced-review exercise can be answered", () => {
  it("marks the answer against the exercise, not the open file", async () => {
    const h = build({
      getReview: jest.fn(async () => ({
        due: true,
        concepts: ["loops"],
        exercise: "Write a loop that sums a list, then say what it prints.",
      })),
    });
    await h.send({ type: "ready" });
    await h.send({ type: "startReview" });
    await h.send({ type: "reviewAnswer", answer: "total = 0 ... prints 6" });

    const req = h.api.streamHint.mock.calls[0][0];
    expect(req.mode).toBe("review-exercise");
    expect(req.question).toContain("Write a loop that sums a list");
    expect(req.question).toContain("total = 0 ... prints 6");
    // The editor is on an unrelated file; the exercise is the subject.
    expect(req.code).toContain("Write a loop that sums a list");
    expect(req.code).not.toContain("def average");
  });

  it("echoes the student's answer into the chat", async () => {
    const h = build({
      getReview: jest.fn(async () => ({
        due: true, concepts: ["loops"], exercise: "Write a loop.",
      })),
    });
    await h.send({ type: "ready" });
    await h.send({ type: "startReview" });
    await h.send({ type: "reviewAnswer", answer: "my answer" });
    expect(ofType(h.posted, "userMessage").some((m) => m.text === "my answer")).toBe(true);
  });

  it("ignores an empty answer", async () => {
    const h = build({
      getReview: jest.fn(async () => ({
        due: true, concepts: ["loops"], exercise: "Write a loop.",
      })),
    });
    await h.send({ type: "ready" });
    await h.send({ type: "startReview" });
    await h.send({ type: "reviewAnswer", answer: "   " });
    expect(h.api.streamHint).not.toHaveBeenCalled();
  });

  it("ignores an answer with no exercise pending", async () => {
    const h = build();
    await h.send({ type: "ready" });
    await h.send({ type: "reviewAnswer", answer: "out of nowhere" });
    expect(h.api.streamHint).not.toHaveBeenCalled();
  });

  it("consumes the exercise so it cannot be answered twice", async () => {
    const h = build({
      getReview: jest.fn(async () => ({
        due: true, concepts: ["loops"], exercise: "Write a loop.",
      })),
    });
    await h.send({ type: "ready" });
    await h.send({ type: "startReview" });
    await h.send({ type: "reviewAnswer", answer: "first" });
    await h.send({ type: "reviewAnswer", answer: "second" });
    expect(h.api.streamHint).toHaveBeenCalledTimes(1);
  });

  it("does not advance the hint ladder", async () => {
    const h = build({
      getReview: jest.fn(async () => ({
        due: true, concepts: ["loops"], exercise: "Write a loop.",
      })),
    });
    await h.send({ type: "ready" });
    await h.send({ type: "startReview" });
    await h.send({ type: "reviewAnswer", answer: "my answer" });
    expect(h.api.streamHint.mock.calls[0][0].mode).toBe("review-exercise");
  });
});
