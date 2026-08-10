/**
 * The SSE read loop in `ApiClient.streamHint`.
 *
 * This is the primary hint path — `sidebarProvider` always tries it first and
 * only falls back to `getHint` when it throws — and before the 2026-08-06
 * audit the loop had no test at all: the only case that touched `streamHint`
 * threw on a 429 before the reader was ever created.
 */
import { ApiClient, STREAM_IDLE_TIMEOUT_MS, TimeoutError } from "../apiClient";

const BASE = "http://localhost:8000";

const tokens = () => ({ getIdToken: jest.fn(async () => "token") });

const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;

/**
 * Stubs fetch with a body that yields `chunks` in order, then EOF.
 * Returns the reader so tests can assert it was released.
 */
function stubStream(chunks: string[], opts: { status?: number } = {}) {
  const encoder = new TextEncoder();
  const queue = [...chunks];
  const reader = {
    read: jest.fn(async () =>
      queue.length
        ? { value: encoder.encode(queue.shift()!), done: false }
        : { value: undefined, done: true }
    ),
    cancel: jest.fn(async () => undefined),
  };
  (global as any).fetch = jest.fn(async () => ({
    ok: (opts.status ?? 200) < 300,
    status: opts.status ?? 200,
    headers: { get: () => null },
    body: { getReader: () => reader },
  }));
  return reader;
}

afterEach(() => jest.restoreAllMocks());

describe("streamHint", () => {
  const req = { code: "x = 1", question: "help", hint_level: 1 };

  it("resolves with the hint and tags from the done event", async () => {
    stubStream([
      frame({ type: "meta", hint_level: 2 }),
      frame({ type: "delta", text: "Think " }),
      frame({ type: "delta", text: "about it." }),
      frame({ type: "done", hint: "Think about it.", concept_tags: ["loops"] }),
    ]);
    const res = await new ApiClient(BASE, tokens()).streamHint(req, () => {});
    expect(res).toEqual({
      hint: "Think about it.",
      hint_level: 2,
      concept_tags: ["loops"],
    });
  });

  it("reports the level from meta, not the level the client asked with", async () => {
    // The status bar and the webview's hint ladder both read this; taking the
    // request's level would show 1 for every hint no matter how deep it went.
    stubStream([
      frame({ type: "meta", hint_level: 3 }),
      frame({ type: "done", hint: "h", concept_tags: [] }),
    ]);
    const res = await new ApiClient(BASE, tokens()).streamHint(req, () => {});
    expect(res.hint_level).toBe(3);
  });

  it("reports the mode from meta, so a rung-4 worked example is not labelled a hint", async () => {
    // The backend answers `mode` on the meta event because the mode it ran is
    // not always the one asked for: `hint` at the top of the ladder *is* the
    // worked example. Dropping it here is what left the panel titling a worked
    // example "hint 4" and the "Label the steps" action unreachable.
    stubStream([
      frame({ type: "meta", hint_level: 4, mode: "worked-example" }),
      frame({ type: "done", hint: "h", concept_tags: [] }),
    ]);
    const res = await new ApiClient(BASE, tokens()).streamHint(req, () => {});
    expect(res.mode).toBe("worked-example");
  });

  it("leaves the mode unset when an older backend's meta omits it", async () => {
    stubStream([
      frame({ type: "meta", hint_level: 2 }),
      frame({ type: "done", hint: "h", concept_tags: [] }),
    ]);
    const res = await new ApiClient(BASE, tokens()).streamHint(req, () => {});
    expect(res.mode).toBeUndefined();
  });

  it("forwards every event to the callback in order", async () => {
    stubStream([
      frame({ type: "meta", hint_level: 1 }),
      frame({ type: "delta", text: "a" }),
      frame({ type: "delta", text: "b" }),
      frame({ type: "done", hint: "ab", concept_tags: [] }),
    ]);
    const seen: string[] = [];
    await new ApiClient(BASE, tokens()).streamHint(req, (e) => seen.push(e.type));
    expect(seen).toEqual(["meta", "delta", "delta", "done"]);
  });

  it("reassembles an event split across two chunks", async () => {
    const whole = frame({ type: "done", hint: "split ok", concept_tags: ["x"] });
    stubStream([whole.slice(0, 14), whole.slice(14)]);
    const res = await new ApiClient(BASE, tokens()).streamHint(req, () => {});
    expect(res.hint).toBe("split ok");
  });

  it("handles several events arriving in one chunk", async () => {
    stubStream([
      frame({ type: "meta", hint_level: 2 }) +
        frame({ type: "delta", text: "hi" }) +
        frame({ type: "done", hint: "hi", concept_tags: [] }),
    ]);
    const seen: string[] = [];
    const res = await new ApiClient(BASE, tokens()).streamHint(req, (e) => seen.push(e.type));
    expect(seen).toEqual(["meta", "delta", "done"]);
    expect(res.hint_level).toBe(2);
  });

  it("skips a malformed frame rather than failing the stream", async () => {
    stubStream([
      "data: {not json\n\n",
      frame({ type: "done", hint: "survived", concept_tags: [] }),
    ]);
    const res = await new ApiClient(BASE, tokens()).streamHint(req, () => {});
    expect(res.hint).toBe("survived");
  });

  it("throws the backend's message on an error event", async () => {
    // The backend reports an LLM failure as an event inside a 200 response,
    // so this is the only thing standing between a dead Groq call and a
    // silently empty hint bubble.
    stubStream([frame({ type: "error", message: "LLM error: boom" })]);
    await expect(
      new ApiClient(BASE, tokens()).streamHint(req, () => {})
    ).rejects.toThrow("LLM error: boom");
  });

  it("throws when the stream ends without a done event", async () => {
    stubStream([frame({ type: "delta", text: "half a hint" })]);
    await expect(
      new ApiClient(BASE, tokens()).streamHint(req, () => {})
    ).rejects.toThrow(/without a done event/);
  });

  it("releases the reader on the happy path", async () => {
    const reader = stubStream([frame({ type: "done", hint: "h", concept_tags: [] })]);
    await new ApiClient(BASE, tokens()).streamHint(req, () => {});
    expect(reader.cancel).toHaveBeenCalled();
  });

  it("releases the reader when an error event throws", async () => {
    const reader = stubStream([frame({ type: "error", message: "boom" })]);
    await expect(
      new ApiClient(BASE, tokens()).streamHint(req, () => {})
    ).rejects.toThrow();
    expect(reader.cancel).toHaveBeenCalled();
  });

  it("throws a RateLimitError on 429 without opening a reader", async () => {
    (global as any).fetch = jest.fn(async () => ({
      ok: false,
      status: 429,
      headers: { get: () => "12" },
      body: null,
    }));
    await expect(
      new ApiClient(BASE, tokens()).streamHint(req, () => {})
    ).rejects.toMatchObject({ name: "RateLimitError", retryAfterSeconds: 12 });
  });

  it("throws when the response carries no body", async () => {
    (global as any).fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: null,
    }));
    await expect(
      new ApiClient(BASE, tokens()).streamHint(req, () => {})
    ).rejects.toThrow(/stream failed/);
  });

  it("abandons a stream that goes silent instead of hanging forever", async () => {
    jest.useFakeTimers();
    try {
      const reader = {
        // Never resolves: the backend accepted the connection and stalled.
        read: jest.fn(() => new Promise(() => {})),
        cancel: jest.fn(async () => undefined),
      };
      (global as any).fetch = jest.fn(async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        body: { getReader: () => reader },
      }));
      const promise = new ApiClient(BASE, tokens()).streamHint(req, () => {});
      const assertion = expect(promise).rejects.toBeInstanceOf(TimeoutError);
      // Let the token fetch, the response and the first reader.read() settle
      // before the idle clock is wound forward.
      for (let i = 0; i < 20; i++) await Promise.resolve();
      jest.advanceTimersByTime(STREAM_IDLE_TIMEOUT_MS + 1);
      await assertion;
      expect(reader.cancel).toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it("does not time out a slow stream that keeps producing", async () => {
    // A long level-3 hint legitimately takes a while; only silence is fatal.
    stubStream([
      frame({ type: "delta", text: "slow " }),
      frame({ type: "delta", text: "but alive" }),
      frame({ type: "done", hint: "slow but alive", concept_tags: [] }),
    ]);
    const res = await new ApiClient(BASE, tokens()).streamHint(req, () => {});
    expect(res.hint).toBe("slow but alive");
  });

  it("sends problem_key so the ladder survives an edit", async () => {
    const reader = stubStream([frame({ type: "done", hint: "h", concept_tags: [] })]);
    await new ApiClient(BASE, tokens()).streamHint(
      { ...req, problem_key: "file:///a.py" },
      () => {}
    );
    const body = JSON.parse((global as any).fetch.mock.calls[0][1].body);
    expect(body.problem_key).toBe("file:///a.py");
    expect(reader.cancel).toHaveBeenCalled();
  });
});

describe("request deadlines", () => {
  const req = { code: "x = 1", question: "help", hint_level: 1 };

  it("gives every authenticated request an abort signal", async () => {
    stubStream([frame({ type: "done", hint: "h", concept_tags: [] })]);
    await new ApiClient(BASE, tokens()).streamHint(req, () => {});
    // An explicit `signal: undefined` from the caller used to spread over the
    // deadline and leave the opening request with no timeout at all.
    const init = (global as any).fetch.mock.calls[0][1];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("gives the plain /hint call an abort signal too", async () => {
    (global as any).fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ hint: "h", hint_level: 1, concept_tags: [] }),
    }));
    await new ApiClient(BASE, tokens()).getHint(req);
    expect((global as any).fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it("honours a caller-supplied signal instead of the default deadline", async () => {
    stubStream([frame({ type: "done", hint: "h", concept_tags: [] })]);
    const controller = new AbortController();
    await new ApiClient(BASE, tokens()).streamHint(req, () => {}, controller.signal);
    expect((global as any).fetch.mock.calls[0][1].signal).toBe(controller.signal);
  });

  it("surfaces an aborted request as a TimeoutError and marks the client offline", async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    (global as any).fetch = jest.fn(async () => {
      throw abort;
    });
    const api = new ApiClient(BASE, tokens());
    await expect(api.getHint(req)).rejects.toBeInstanceOf(TimeoutError);
    expect(api.isAvailable).toBe(false);
  });

  it("gives /health its own short deadline", async () => {
    (global as any).fetch = jest.fn(async () => ({ ok: true, status: 200 }));
    await new ApiClient(BASE, tokens()).health();
    expect((global as any).fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });
});
