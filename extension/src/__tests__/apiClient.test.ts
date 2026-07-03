import { ApiClient } from "../apiClient";

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
