import { ApiClient, AuthError, RateLimitError, TimeoutError, parseSseChunk } from "../apiClient";

const BASE = "http://localhost:8000";

function mockFetch(status: number, body: any): jest.Mock {
  const mock = jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  (global as any).fetch = mock;
  return mock;
}

function makeTokens() {
  return {
    getIdToken: jest.fn(async (force?: boolean) => (force ? "fresh-token" : "stale-token")),
  };
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe("ApiClient.health", () => {
  it("returns true when /health responds 200", async () => {
    mockFetch(200, { status: "ok" });
    expect(await new ApiClient(BASE, makeTokens()).health()).toBe(true);
  });

  it("returns false when fetch throws (backend down)", async () => {
    (global as any).fetch = jest.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    expect(await new ApiClient(BASE, makeTokens()).health()).toBe(false);
  });
});

describe("authenticated requests", () => {
  const validResponse = { hint: "Think!", hint_level: 1, concept_tags: ["operators"] };

  it("attaches the Bearer token to /hint", async () => {
    const fetchMock = mockFetch(200, validResponse);
    const tokens = makeTokens();
    const api = new ApiClient(BASE, tokens);
    const req = { code: "x=1", question: "help", hint_level: 1 };
    await api.getHint(req);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/hint`);
    expect(init.headers.Authorization).toBe("Bearer stale-token");
    expect(JSON.parse(init.body)).toEqual(req);
  });

  it("passes the tutor mode through to /hint", async () => {
    const fetchMock = mockFetch(200, validResponse);
    const api = new ApiClient(BASE, makeTokens());
    await api.getHint({ code: "x=1", question: "quiz me", hint_level: 1, mode: "reflect" });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).mode).toBe("reflect");
  });

  it("retries once with a forced refresh on 401", async () => {
    const responses = [
      { ok: false, status: 401, json: async () => ({}), text: async () => "unauthorized" },
      { ok: true, status: 200, json: async () => validResponse, text: async () => "" },
    ];
    const fetchMock = jest.fn(async () => responses.shift());
    (global as any).fetch = fetchMock;
    const tokens = makeTokens();
    const api = new ApiClient(BASE, tokens);
    const res = await api.getHint({ code: "x", question: "q", hint_level: 1 });
    expect(res).toEqual(validResponse);
    expect(tokens.getIdToken).toHaveBeenCalledWith(false);
    expect(tokens.getIdToken).toHaveBeenCalledWith(true);
    expect((fetchMock.mock.calls[1] as any)[1].headers.Authorization).toBe("Bearer fresh-token");
  });

  it("throws with backend detail on persistent failure", async () => {
    mockFetch(502, { detail: "LLM error" });
    const api = new ApiClient(BASE, makeTokens());
    await expect(api.getHint({ code: "x", question: "q", hint_level: 1 })).rejects.toThrow(/502/);
  });

  it("sends POST /reset with no body fields", async () => {
    const fetchMock = mockFetch(200, { status: "reset", user_id: "uid" });
    await new ApiClient(BASE, makeTokens()).resetSession();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/reset`);
    expect(init.method).toBe("POST");
  });

  it("fetches GET /badges with the Bearer token", async () => {
    const fetchMock = mockFetch(200, ["First Question"]);
    const badges = await new ApiClient(BASE, makeTokens()).getBadges();
    expect(badges).toEqual(["First Question"]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/badges`);
    expect(init.headers.Authorization).toBe("Bearer stale-token");
  });

  it("getBadges returns [] on error", async () => {
    (global as any).fetch = jest.fn().mockRejectedValue(new Error("down"));
    expect(await new ApiClient(BASE, makeTokens()).getBadges()).toEqual([]);
  });

  it("scanCode posts code and language only", async () => {
    const fetchMock = mockFetch(200, { flags: [] });
    await new ApiClient(BASE, makeTokens()).scanCode("x=1", "javascript");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ code: "x=1", language: "javascript" });
  });

  it("getLineHint posts code, line and language only", async () => {
    const fetchMock = mockFetch(200, { hint: "h", concept: "general" });
    await new ApiClient(BASE, makeTokens()).getLineHint("x=1", 3, "java");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ code: "x=1", line: 3, language: "java" });
  });
});

/**
 * A new extension against a backend that predates `answer` mode. `TutorMode`
 * there has no such member, so FastAPI answers 422 — a perfectly normal HTTP
 * response, so the client stays "available" and the offline tutor never runs.
 * Left alone, the student reads `Backend error (422): {"detail":[...]}` in a
 * banner. Same convention as `ProgressReport.calibration`: degrade, don't
 * surface the skew.
 */
describe("version skew — an old backend has never heard of answer mode", () => {
  const hint = { hint: "What does len(n) return?", hint_level: 1, concept_tags: [] };

  function sequence(responses: Array<{ status: number; body: any }>): jest.Mock {
    const queue = [...responses];
    const mock = jest.fn(async () => {
      const next = queue.shift() ?? responses[responses.length - 1];
      return {
        ok: next.status >= 200 && next.status < 300,
        status: next.status,
        headers: { get: () => null },
        json: async () => next.body,
        text: async () => JSON.stringify(next.body),
      };
    });
    (global as any).fetch = mock;
    return mock;
  }

  it("getHint retries an answer-mode 422 as a hint instead of showing raw JSON", async () => {
    const fetchMock = sequence([
      { status: 422, body: { detail: [{ msg: "unexpected value; permitted: 'hint', …" }] } },
      { status: 200, body: hint },
    ]);
    const res = await new ApiClient(BASE, makeTokens()).getHint({
      code: "x=1",
      question: "just tell me the answer",
      hint_level: 1,
      mode: "answer",
    });
    expect(res.hint).toBe(hint.hint);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).mode).toBe("hint");
  });

  it("getHint surfaces a 422 that is not about the mode", async () => {
    // A 422 on an ordinary hint is a real contract breach, not version skew.
    sequence([{ status: 422, body: { detail: "code too long" } }]);
    await expect(
      new ApiClient(BASE, makeTokens()).getHint({ code: "x", question: "q", hint_level: 1 })
    ).rejects.toThrow(/422/);
  });

  it("getHint gives up after one downgrade rather than looping", async () => {
    const fetchMock = sequence([{ status: 422, body: { detail: "nope" } }]);
    await expect(
      new ApiClient(BASE, makeTokens()).getHint({
        code: "x",
        question: "q",
        hint_level: 1,
        mode: "answer",
      })
    ).rejects.toThrow(/422/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("streamHint downgrades too, so the answer still streams", async () => {
    const encoder = new TextEncoder();
    const frames = [
      `data: ${JSON.stringify({ type: "meta", hint_level: 1, mode: "hint" })}\n\n`,
      `data: ${JSON.stringify({ type: "done", hint: "streamed", concept_tags: [] })}\n\n`,
    ];
    let call = 0;
    const fetchMock = jest.fn(async () => {
      if (call++ === 0) {
        return { ok: false, status: 422, headers: { get: () => null }, body: null };
      }
      const queue = [...frames];
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        body: {
          getReader: () => ({
            read: jest.fn(async () =>
              queue.length
                ? { value: encoder.encode(queue.shift()!), done: false }
                : { value: undefined, done: true }
            ),
            cancel: jest.fn(async () => undefined),
          }),
        },
      };
    });
    (global as any).fetch = fetchMock;
    const res = await new ApiClient(BASE, makeTokens()).streamHint(
      { code: "x", question: "tell me the answer", hint_level: 1, mode: "answer" },
      () => {}
    );
    expect(res.hint).toBe("streamed");
    expect(JSON.parse((fetchMock.mock.calls[1] as any)[1].body).mode).toBe("hint");
  });
});

describe("parseSseChunk", () => {
  it("parses complete events and keeps the remainder", () => {
    const { events, rest } = parseSseChunk(
      "",
      'data: {"type":"meta","hint_level":2}\n\ndata: {"type":"delta","text":"Hi"}\n\ndata: {"type":"do'
    );
    expect(events).toEqual([
      { type: "meta", hint_level: 2 },
      { type: "delta", text: "Hi" },
    ]);
    expect(rest).toBe('data: {"type":"do');
  });

  it("joins a previous partial buffer with the new chunk", () => {
    const first = parseSseChunk("", 'data: {"type":"del');
    const second = parseSseChunk(first.rest, 'ta","text":"x"}\n\n');
    expect(second.events).toEqual([{ type: "delta", text: "x" }]);
    expect(second.rest).toBe("");
  });

  it("skips malformed json events", () => {
    const { events } = parseSseChunk("", "data: {broken\n\n");
    expect(events).toEqual([]);
  });
});

describe("availability tracking", () => {
  it("flips to unavailable on network failure and notifies once", async () => {
    (global as any).fetch = jest.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const api = new ApiClient(BASE, makeTokens());
    const seen: boolean[] = [];
    api.onAvailabilityChange((up) => seen.push(up));
    await expect(api.getHint({ code: "x", question: "q", hint_level: 1 })).rejects.toThrow();
    await expect(api.getHint({ code: "x", question: "q", hint_level: 1 })).rejects.toThrow();
    expect(api.isAvailable).toBe(false);
    expect(seen).toEqual([false]);
  });

  it("recovers when a request succeeds", async () => {
    (global as any).fetch = jest.fn().mockRejectedValue(new Error("down"));
    const api = new ApiClient(BASE, makeTokens());
    await expect(api.resetSession()).rejects.toThrow();
    expect(api.isAvailable).toBe(false);
    mockFetch(200, { status: "reset", summary: "" });
    await api.resetSession();
    expect(api.isAvailable).toBe(true);
  });

  it("health() updates availability", async () => {
    (global as any).fetch = jest.fn().mockRejectedValue(new Error("down"));
    const api = new ApiClient(BASE, makeTokens());
    await api.health();
    expect(api.isAvailable).toBe(false);
  });

  /**
   * A broken sign-in chain used to be reported as an unreachable backend, which
   * sent students off to restart a server that was answering fine.
   */
  it("blames auth, not the backend, when the sign-in chain fails", async () => {
    const fetchMock = jest.fn();
    (global as any).fetch = fetchMock;
    const api = new ApiClient(BASE, {
      getIdToken: async () => {
        throw new AuthError("anonymous sign-in failed (400)", 400);
      },
    });
    const seenAvailability: boolean[] = [];
    const seenAuth: boolean[] = [];
    api.onAvailabilityChange((up) => seenAvailability.push(up));
    api.onAuthHealthChange((ok) => seenAuth.push(ok));

    await expect(api.getProgress()).rejects.toThrow(AuthError);

    expect(api.isAvailable).toBe(true);
    expect(api.isAuthHealthy).toBe(false);
    expect(seenAvailability).toEqual([]);
    expect(seenAuth).toEqual([false]);
    // The request never left the machine, so nothing proves the backend is down.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("clears the auth failure once a request succeeds", async () => {
    let broken = true;
    const api = new ApiClient(BASE, {
      getIdToken: async () => {
        if (broken) throw new AuthError("auth config failed (500)", 500);
        return "token";
      },
    });
    (global as any).fetch = jest.fn();
    await expect(api.getProgress()).rejects.toThrow(AuthError);
    expect(api.isAuthHealthy).toBe(false);

    broken = false;
    mockFetch(200, { streak_days: 0, review_due: false });
    await api.getProgress();
    expect(api.isAuthHealthy).toBe(true);
  });
});

describe("rate limiting", () => {
  function mockThrottled(retryAfter?: string): jest.Mock {
    const mock = jest.fn().mockResolvedValue({
      ok: false,
      status: 429,
      headers: { get: (name: string) => (name === "Retry-After" ? retryAfter ?? null : null) },
      json: async () => ({ detail: "slow down" }),
      text: async () => "slow down",
    });
    (global as any).fetch = mock;
    return mock;
  }

  it("throws a RateLimitError from /hint", async () => {
    mockThrottled("12");
    const api = new ApiClient(BASE, makeTokens());
    await expect(api.getHint({ code: "", question: "q", hint_level: 1 })).rejects.toBeInstanceOf(
      RateLimitError
    );
  });

  it("carries the Retry-After value", async () => {
    mockThrottled("12");
    const api = new ApiClient(BASE, makeTokens());
    await api.getHint({ code: "", question: "q", hint_level: 1 }).catch((err) => {
      expect((err as RateLimitError).retryAfterSeconds).toBe(12);
    });
    expect.assertions(1);
  });

  it("falls back to a sane wait when the header is missing", async () => {
    mockThrottled(undefined);
    const api = new ApiClient(BASE, makeTokens());
    await api.scanCode("x=1").catch((err) => {
      expect((err as RateLimitError).retryAfterSeconds).toBe(30);
    });
    expect.assertions(1);
  });

  it("throws rather than silently degrading on /scan", async () => {
    mockThrottled("5");
    const api = new ApiClient(BASE, makeTokens());
    await expect(api.scanCode("x=1")).rejects.toBeInstanceOf(RateLimitError);
  });

  it("throws rather than silently degrading on /line-hint", async () => {
    mockThrottled("5");
    const api = new ApiClient(BASE, makeTokens());
    await expect(api.getLineHint("x=1", 1)).rejects.toBeInstanceOf(RateLimitError);
  });

  it("does not treat a 429 stream as a fallback-to-/hint case", async () => {
    // Retrying /hint would just spend the same exhausted budget.
    mockThrottled("5");
    const api = new ApiClient(BASE, makeTokens());
    await expect(
      api.streamHint({ code: "", question: "q", hint_level: 1 }, () => {})
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  it("leaves the backend marked available — throttled is not down", async () => {
    mockThrottled("5");
    const api = new ApiClient(BASE, makeTokens());
    await api.getHint({ code: "", question: "q", hint_level: 1 }).catch(() => undefined);
    expect(api.isAvailable).toBe(true);
  });
});

describe("ApiClient.getTrace", () => {
  it("returns the designed exercise", async () => {
    mockFetch(200, { variables: ["i", "total"], steps: 4, prompt: "Trace the loop." });
    const api = new ApiClient(BASE, makeTokens());
    expect(await api.getTrace("code", "snippet", "python")).toEqual({
      variables: ["i", "total"],
      steps: 4,
      prompt: "Trace the loop.",
    });
  });

  it("sends the selection and language", async () => {
    const fetchMock = mockFetch(200, { variables: [], steps: 0, prompt: "" });
    const api = new ApiClient(BASE, makeTokens());
    await api.getTrace("whole file", "just this", "rust");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toEqual({ code: "whole file", selection: "just this", language: "rust" });
  });

  it("degrades to an empty exercise on a backend error", async () => {
    mockFetch(500, {});
    const api = new ApiClient(BASE, makeTokens());
    expect(await api.getTrace("code", "snippet")).toEqual({
      variables: [],
      steps: 0,
      prompt: "",
    });
  });

  it("degrades to an empty exercise when the backend is unreachable", async () => {
    (global as any).fetch = jest.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const api = new ApiClient(BASE, makeTokens());
    expect((await api.getTrace("code", "snippet")).steps).toBe(0);
  });

  it("degrades rather than throwing when throttled", async () => {
    // The trace exercise is optional; a 429 should not surface as an error.
    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 429,
      headers: { get: () => "5" },
      json: async () => ({}),
      text: async () => "",
    });
    const api = new ApiClient(BASE, makeTokens());
    expect((await api.getTrace("code", "snippet")).steps).toBe(0);
  });
});

describe("hint request fields", () => {
  it("forwards escalate, edit_summary and confidence", async () => {
    const fetchMock = mockFetch(200, { hint: "h", hint_level: 2, concept_tags: [] });
    const api = new ApiClient(BASE, makeTokens());
    await api.getHint({
      code: "x=1",
      question: "help",
      hint_level: 1,
      escalate: false,
      edit_summary: "1 - a\n1 + b",
      confidence: 3,
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.escalate).toBe(false);
    expect(body.edit_summary).toBe("1 - a\n1 + b");
    expect(body.confidence).toBe(3);
  });

  it("omits the new fields entirely when unset", async () => {
    const fetchMock = mockFetch(200, { hint: "h", hint_level: 1, concept_tags: [] });
    const api = new ApiClient(BASE, makeTokens());
    await api.getHint({ code: "x=1", question: "help", hint_level: 1 });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).not.toHaveProperty("escalate");
    expect(body).not.toHaveProperty("confidence");
  });
});

describe("getLineHint — focus", () => {
  it("sends the focus block alongside the file", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ hint: "what if n is 0?", concept: "division" }),
    });
    (global as any).fetch = fetchMock;

    const api = new ApiClient(BASE, makeTokens());
    await api.getLineHint("x = 1\ny = 2", 2, "python", {
      start_line: 1,
      end_line: 2,
      label: "main",
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.focus).toEqual({ start_line: 1, end_line: 2, label: "main" });
  });

  it("omits focus entirely when there isn't one", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ hint: "h", concept: "general" }),
    });
    (global as any).fetch = fetchMock;

    const api = new ApiClient(BASE, makeTokens());
    await api.getLineHint("x = 1", 1, "python");

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).not.toHaveProperty("focus");
  });
});

describe("cold start — the backend was asleep", () => {
  // Render's free plan sleeps after ~15 min idle and takes ~50s to wake, which
  // a 20s deadline can never survive. One retry on a longer clock turns a
  // guaranteed failure into a slow answer.
  const abort = () => Object.assign(new Error("aborted"), { name: "AbortError" });

  function client(fetchImpl: jest.Mock) {
    (global as any).fetch = fetchImpl;
    const api = new ApiClient("https://example.test", {
      getIdToken: async () => "tok",
    } as any);
    return api;
  }

  it("retries once when the first attempt times out", async () => {
    const fetchMock = jest
      .fn()
      .mockRejectedValueOnce(abort())
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ hint: "h", hint_level: 1, concept_tags: [] }),
      });
    const api = client(fetchMock);
    const res = await api.getHint({ code: "x", question: "q" } as any);
    expect(res.hint).toBe("h");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("announces the wait so the panel can explain the pause", async () => {
    const fetchMock = jest
      .fn()
      .mockRejectedValueOnce(abort())
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ hint: "h", hint_level: 1, concept_tags: [] }),
      });
    const api = client(fetchMock);
    const seen: string[] = [];
    api.onColdStart = () => seen.push("waking");
    await api.getHint({ code: "x", question: "q" } as any);
    expect(seen).toEqual(["waking"]);
  });

  it("gives up after the second timeout rather than retrying forever", async () => {
    const fetchMock = jest.fn().mockRejectedValue(abort());
    const api = client(fetchMock);
    await expect(api.getHint({ code: "x", question: "q" } as any)).rejects.toThrow(
      TimeoutError
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(api.isAvailable).toBe(false);
  });

  it("does not announce a cold start when the request simply succeeds", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ hint: "h", hint_level: 1, concept_tags: [] }),
    });
    const api = client(fetchMock);
    const seen: string[] = [];
    api.onColdStart = () => seen.push("waking");
    await api.getHint({ code: "x", question: "q" } as any);
    expect(seen).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
