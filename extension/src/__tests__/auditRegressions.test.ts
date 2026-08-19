/**
 * Regressions for the extension-side defects found in the 2026-08-06 audit.
 *
 * The suites next to this one are organised by module; this one is organised
 * by defect, so each block states the wrong behaviour it pins shut.
 */
import * as fs from "fs";
import * as path from "path";
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
  it("keys problem_key on the document uri plus the focused symbol", async () => {
    const h = build();
    await h.send({ type: "ready" });
    await h.send({ type: "askHint", question: "help", code: CODE, mode: "hint" });
    await h.send({ type: "explainSkip" });
    const req = h.api.streamHint.mock.calls[0][0];
    // A different function is a different problem: being stuck on `main`
    // should not start at hint 3 because you were stuck on `parse` a minute
    // ago, so the key carries the resolved symbol, not just the file.
    expect(req.problem_key).toBe(
      `${mock.window.activeTextEditor.document.uri.toString()}#average`
    );
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

// ------------------------------------------------- the file stays on the machine

describe("no source file writes to the student's code", () => {
  const SRC = path.join(__dirname, "..");

  /** A trailing `//` comment, so prose naming the API cannot trip the scan. */
  const stripComment = (line: string) => line.replace(/(^|[^:])\/\/.*$/, "$1");

  /**
   * Until 1.7.0 there was exactly one write: a setting that deleted `bug:`
   * comments from a block once it scanned clean. It was removed because
   * nothing outside the demo files carries those comments, so on real student
   * code the feature could only ever be a risk of editing a file it had no
   * reason to touch.
   *
   * That makes the invariant unconditional, which is worth pinning: a tutor
   * that never modifies your code is a much easier promise to keep than one
   * that modifies it narrowly, and the difference is one careless
   * `applyEdit` away. The Marketplace page states it as a flat fact.
   */
  it("constructs no WorkspaceEdit and calls no applyEdit anywhere in src/", () => {
    const offenders = fs
      .readdirSync(SRC)
      .filter((name) => name.endsWith(".ts") && fs.statSync(path.join(SRC, name)).isFile())
      .flatMap((name) =>
        fs
          .readFileSync(path.join(SRC, name), "utf8")
          .split("\n")
          .map((line, i) => [i + 1, stripComment(line)] as const)
          .filter(([, line]) => /\bWorkspaceEdit\b|\bapplyEdit\s*\(/.test(line))
          .map(([lineNo, line]) => `${name}:${lineNo} ${line.trim()}`)
      );

    expect(offenders).toEqual([]);
  });
});

describe("no source file hands raw document text to the network", () => {
  const SRC = path.join(__dirname, "..");
  /**
   * Every top-level module that talks to the backend, discovered rather than
   * hand-listed. A fixed array stops covering a new sender the moment
   * someone adds one and forgets to update it here — this found
   * `firebaseClient.ts` on the first run, which the hand-maintained list of
   * three had never named. `apiClient.ts` itself is excluded: it is what
   * the other files reference, not a sender, and the bare word `ApiClient`
   * appears throughout its own class declaration.
   */
  const SENDERS = fs
    .readdirSync(SRC)
    .filter((name) => name.endsWith(".ts") && fs.statSync(path.join(SRC, name)).isFile())
    .filter((name) => name !== "apiClient.ts")
    .filter((name) => {
      const source = fs.readFileSync(path.join(SRC, name), "utf8");
      return /\bApiClient\b/.test(source) || /this\.api\./.test(source);
    })
    .sort();

  /**
   * A trailing `//` comment, stripped before it can matter. Left in, a
   * comment can exempt a real offender (`doc.getText(); // eventually goes
   * through buildDigest`) as easily as it can trip a false one — the first
   * draft of this suite's own `askWithActiveFile` comment did exactly that
   * by quoting `getText()`. Not preceded by `:`, so a `"https://..."`
   * literal survives; that is the one `//` this codebase's source carries
   * outside an actual comment (verified against every sender file).
   */
  function stripLineComment(line: string): string {
    return line.replace(/(?<!:)\/\/.*/, "");
  }

  /**
   * A file's lines, `\r\n` normalised to `\n` first. This repo checks out
   * with CRLF endings, and a trailing `\r` survives `.split("\n")` on every
   * line — which silently defeats a `$`-anchored strip like the one above
   * (`.*` does not consume a line terminator, `\r` included, so the pattern
   * can never reach `$`). Normalising once here means neither this file's
   * own regexes nor a future one has to remember that.
   */
  function readLines(name: string): string[] {
    return fs
      .readFileSync(path.join(SRC, name), "utf8")
      .replace(/\r\n/g, "\n")
      .split("\n");
  }

  /**
   * The one module that turns a `TextDocument` into the lines a digest is
   * built from. Named once here so the assertions below are about a symbol
   * rather than about the shape of an incantation.
   */
  const CHOKEPOINT = "documentDigest.ts";

  /**
   * The argument text of every `buildDigest(...)` call in `source`, taken by
   * matching parentheses rather than by line. The call this exists to catch
   * spans four lines, so a line-level scan would miss it — and a line-level
   * scan is what the incantation-shaped guard this replaces was.
   */
  function buildDigestArguments(source: string): string[] {
    const calls: string[] = [];
    const pattern = /\bbuildDigest\s*\(/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source))) {
      let depth = 1;
      let i = match.index + match[0].length;
      for (; i < source.length && depth > 0; i++) {
        if (source[i] === "(") depth++;
        else if (source[i] === ")") depth--;
      }
      calls.push(source.slice(match.index + match[0].length, i - 1));
    }
    return calls;
  }

  it("keeps every document-to-digest conversion inside the one chokepoint", () => {
    // What this guarantees: no file that can reach the network builds a
    // digest out of a document itself. `digestFor` is the only door, so the
    // strip-split-budget decision is made in one place and can be read in
    // one place — which is what `digestFields` (where a digest becomes a
    // payload) explicitly is not, since by then the choice of what to send
    // has already been made.
    //
    // `buildDigest` on its own is not forbidden: `sidebarProvider`'s
    // fallback branch builds a digest out of a review exercise or a trace
    // answer, which is a string and was never a document. What is forbidden
    // is a sender feeding a document's own text into one.
    for (const name of SENDERS) {
      const source = readLines(name).map(stripLineComment).join("\n");
      const fromADocument = buildDigestArguments(source).filter((args) =>
        /getText\s*\(/.test(args)
      );
      expect({ name, fromADocument }).toEqual({ name, fromADocument: [] });
    }
    // ...and the chokepoint really is one: it is where the pair lives.
    const chokepoint = fs.readFileSync(path.join(SRC, CHOKEPOINT), "utf8");
    expect(chokepoint).toContain("getText()");
    expect(chokepoint).toContain("buildDigest(");
    expect(chokepoint).toContain("stripBugMarkers(");
  });

  it("keeps the digest rules themselves free of the editor", () => {
    // The chokepoint exists so that `codeDigest` can stay a pure module —
    // raw lines in, a digest out, every test a fixture array. An import of
    // `vscode` there would make the budget arithmetic testable only through
    // a mocked editor.
    const pure = fs.readFileSync(path.join(SRC, "codeDigest.ts"), "utf8");
    expect(pure).not.toMatch(/from ["']vscode["']/);
  });

  it("flags a bare getText() not routed through the chokepoint or a marker call", () => {
    // A line-level textual guard against the obvious regression — a
    // `getText()` sitting in one of these files with nothing on the same line
    // that accounts for it — not a data-flow proof, and a regex over source
    // text cannot honestly be more than that. It has no way to see a value
    // carried across lines or variables. Catching that shape is what the
    // behavioural tests next to each call site are for (e.g.
    // sidebarProvider.test.ts's "the conversation carries a digest, not the
    // file"), not this scan.
    //
    // The allow-list is the three things a raw `getText()` may legitimately
    // be: the panel's display copy, a marker search over the live buffer, and
    // — inside the chokepoint only — the digest's own input.
    for (const name of [...SENDERS, CHOKEPOINT]) {
      const allowed =
        name === CHOKEPOINT
          ? /stripBugMarkers\(/
          : /panelFullCode|findBugMarkers\(/;
      const offenders = readLines(name)
        .map((line, i) => [i + 1, stripLineComment(line)] as const)
        .filter(([, line]) => /getText\(\)/.test(line))
        .filter(([, line]) => !allowed.test(line));
      expect({ name, offenders }).toEqual({ name, offenders: [] });
    }
  });

  it("keeps the panel's whole-file copy out of every request", () => {
    // `panelFullCode` legitimately reaches the webview through `this.post` —
    // that is the "Whole file" toggle, and the webview runs inside the
    // editor, so nothing posted to it has left the machine. The property
    // that matters is narrower than "the string never appears": it must
    // never be handed to `this.api.*`, the only door to the network. (A
    // literal `code:\s*this\.panelFullCode` search also matches that
    // legitimate `post` call one-for-one and fails unconditionally — it is
    // not what is checked here.)
    //
    // Same-line only, like the scan above: `handleAsk`'s request object
    // (sidebarProvider.ts, built for `streamHint`/`getHint`) spans several
    // lines before the `this.api.` call that sends it, so a `panelFullCode`
    // reference planted inside that object, rather than in the
    // `this.post(...)` call it belongs to today, would slip past this
    // one-line check. `sidebarProvider.test.ts`'s "the conversation carries
    // a digest, not the file" tests already exercise that request body
    // behaviourally and would catch it there.
    const reachesApi = readLines("sidebarProvider.ts")
      .map(stripLineComment)
      .filter((line) => line.includes("panelFullCode") && line.includes("this.api."));
    expect(reachesApi).toEqual([]);
    expect(fs.readFileSync(path.join(SRC, "sidebarProvider.ts"), "utf8")).toContain(
      "digestFields("
    );
  });
});
