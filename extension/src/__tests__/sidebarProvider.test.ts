import * as vscode from "vscode";
import { EduPeerSidebarProvider } from "../sidebarProvider";
import { RateLimitError } from "../apiClient";

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

  it("restores the persisted transcript, the file, badges, auth and offline state", async () => {
    const posted: any[] = [];
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

    expect(latest(posted, "restoreChat").messages).toHaveLength(1);
    expect(latest(posted, "activeCode").language).toBe("Python");
    expect(latest(posted, "badges")).toBeDefined();
    expect(latest(posted, "authState").signedIn).toBe(false);
    expect(latest(posted, "offline").value).toBe(false);
  });

  it("labels an anonymous session as not signed in", async () => {
    const h = await build();
    h.provider.reveal();
    await h.send({ type: "ready" });
    expect(latest(h.posted, "authState").label).toBe("Not signed in");
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
    const h = await build();
    await askPastTheGate(h);
    await h.send({ type: "askHint", question: "still stuck", code: CODE, mode: "hint" });
    expect(hintRequest(h.api).escalate).toBe(false);
  });

  it("tells the student why they got the same depth", async () => {
    const h = await build();
    await askPastTheGate(h);
    h.posted.length = 0;
    await h.send({ type: "askHint", question: "still stuck", code: CODE, mode: "hint" });
    const gate = h.posted.find((m) => m.type === "hint" && m.mode === "attempt-gate");
    expect(gate.hint).toContain("haven't changed anything");
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
    // Editing produces a new fingerprint, which re-arms the explain-first
    // gate, so the ask has to be let through a second time.
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

  it("re-arms the explain-first gate after any edit", async () => {
    // Documents current behaviour: the gate is keyed on the code fingerprint,
    // not on the file, so it returns every time the student edits.
    const h = await build();
    await askPastTheGate(h);
    h.posted.length = 0;
    await h.send({
      type: "askHint",
      question: "now?",
      code: CODE.replace("sum(n)", "total(n)"),
      mode: "hint",
    });
    expect(latest(h.posted, "explainFirst")).toBeDefined();
  });

  it("sends no diff when nothing changed", async () => {
    const h = await build();
    await askPastTheGate(h);
    await h.send({ type: "askHint", question: "still stuck", code: CODE, mode: "hint" });
    expect(hintRequest(h.api).edit_summary).toBe("");
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

describe("confidence", () => {
  beforeEach(() => mock.__reset());

  it("forwards the rating", async () => {
    const h = await build();
    await h.send({ type: "askHint", question: "help", code: CODE, mode: "hint", confidence: 3 });
    await h.send({ type: "explainSkip" });
    expect(hintRequest(h.api).confidence).toBe(3);
  });

  it("survives the explain-first gate", async () => {
    const h = await build();
    await h.send({ type: "askHint", question: "help", code: CODE, mode: "hint", confidence: 2 });
    await h.send({ type: "explainAnswer", explanation: "an average" });
    expect(hintRequest(h.api).confidence).toBe(2);
  });

  it("defaults to zero when not given", async () => {
    const h = await build();
    await askPastTheGate(h);
    expect(hintRequest(h.api).confidence).toBe(0);
  });

  it("clamps a value the webview should never send", async () => {
    const h = await build();
    await askPastTheGate(h, "help", { confidence: 99 });
    expect(hintRequest(h.api).confidence).toBe(3);
  });

  it("clamps a negative value", async () => {
    const h = await build();
    await askPastTheGate(h, "help", { confidence: -5 });
    expect(hintRequest(h.api).confidence).toBe(0);
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

  it("clears the persisted transcript", async () => {
    const h = await build();
    h.state.set("edupeer.chatHistory", [{ role: "tutor", text: "old" }]);
    await h.send({ type: "reset" });
    expect(h.state.get("edupeer.chatHistory")).toEqual([]);
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

  it("stores the transcript the webview sends", async () => {
    const h = await build();
    await h.send({ type: "persistChat", messages: [{ role: "tutor", text: "a" }] });
    expect(h.state.get("edupeer.chatHistory")).toHaveLength(1);
  });

  it("keeps only the newest fifty turns", async () => {
    const h = await build();
    const many = Array.from({ length: 80 }, (_, i) => ({ role: "tutor", text: `t${i}` }));
    await h.send({ type: "persistChat", messages: many });
    const stored = h.state.get("edupeer.chatHistory");
    expect(stored).toHaveLength(50);
    expect(stored[49].text).toBe("t79");
  });

  it("tolerates a persist message with no payload", async () => {
    const h = await build();
    await h.send({ type: "persistChat" });
    expect(h.state.get("edupeer.chatHistory")).toEqual([]);
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
    await h.send({ type: "refreshCode" });
    expect(latest(h.posted, "activeCode").code).toBe(CODE);
  });

  it("ignores an unknown message type", async () => {
    const h = await build();
    await expect(h.send({ type: "not-a-real-message" })).resolves.toBeUndefined();
  });

  it("reports an unsupported language as no language", async () => {
    const h = await build({}, "# notes\n", "markdown");
    await h.send({ type: "refreshCode" });
    expect(latest(h.posted, "activeCode").language).toBe("");
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
