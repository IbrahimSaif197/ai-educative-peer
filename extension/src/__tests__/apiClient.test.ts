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

afterEach(() => {
  jest.restoreAllMocks();
});

describe("ApiClient.health", () => {
  it("returns true when /health responds 200", async () => {
    mockFetch(200, { status: "ok" });
    const api = new ApiClient(BASE);
    expect(await api.health()).toBe(true);
  });

  it("returns false when /health responds 500", async () => {
    mockFetch(500, {});
    const api = new ApiClient(BASE);
    expect(await api.health()).toBe(false);
  });

  it("returns false when fetch throws (backend down)", async () => {
    (global as any).fetch = jest.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const api = new ApiClient(BASE);
    expect(await api.health()).toBe(false);
  });
});

describe("ApiClient.getHint", () => {
  const validResponse = {
    hint: "Think about what + does. What do you think should happen next?",
    hint_level: 1,
    concept_tags: ["operators"],
  };

  it("sends POST to /hint with correct body", async () => {
    const fetchMock = mockFetch(200, validResponse);
    const api = new ApiClient(BASE);
    const req = { code: "x=1", question: "help", user_id: "u1", hint_level: 1 };
    await api.getHint(req);
    expect(fetchMock).toHaveBeenCalledWith(
      `${BASE}/hint`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(req),
      })
    );
  });

  it("returns parsed HintResponse on success", async () => {
    mockFetch(200, validResponse);
    const api = new ApiClient(BASE);
    const result = await api.getHint({ code: "", question: "q", user_id: "u1", hint_level: 1 });
    expect(result.hint).toContain("What do you think should happen next?");
    expect(result.hint_level).toBe(1);
    expect(result.concept_tags).toEqual(["operators"]);
  });

  it("throws an error on non-200 response", async () => {
    mockFetch(400, { detail: "question must not be empty" });
    const api = new ApiClient(BASE);
    await expect(
      api.getHint({ code: "", question: "", user_id: "u1", hint_level: 1 })
    ).rejects.toThrow("Backend error (400)");
  });

  it("throws an error on 502", async () => {
    mockFetch(502, { detail: "LLM error" });
    const api = new ApiClient(BASE);
    await expect(
      api.getHint({ code: "x", question: "q", user_id: "u1", hint_level: 1 })
    ).rejects.toThrow("Backend error (502)");
  });

  it("sends language and history when provided", async () => {
    const fetchMock = mockFetch(200, validResponse);
    const api = new ApiClient(BASE);
    const req = {
      code: "int x = 1;",
      question: "help",
      user_id: "u1",
      hint_level: 1,
      language: "java",
      history: [{ role: "student" as const, content: "earlier question" }],
    };
    await api.getHint(req);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.language).toBe("java");
    expect(body.history).toEqual([{ role: "student", content: "earlier question" }]);
  });
});

describe("ApiClient.scanCode", () => {
  it("sends the language with the scan request", async () => {
    const fetchMock = mockFetch(200, { flags: [] });
    const api = new ApiClient(BASE);
    await api.scanCode("int main() {}", "u1", "c");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.language).toBe("c");
  });

  it("defaults to python when no language given", async () => {
    const fetchMock = mockFetch(200, { flags: [] });
    const api = new ApiClient(BASE);
    await api.scanCode("x = 1", "u1");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.language).toBe("python");
  });
});

describe("ApiClient.getLineHint", () => {
  it("sends the language with the line-hint request", async () => {
    const fetchMock = mockFetch(200, { hint: "check the loop", concept: "loops" });
    const api = new ApiClient(BASE);
    await api.getLineHint("for (;;) {}", 1, "u1", "cpp");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.language).toBe("cpp");
    expect(body.line).toBe(1);
  });
});

describe("ApiClient.resetSession", () => {
  it("sends POST to /reset with correct user_id", async () => {
    const fetchMock = mockFetch(200, { status: "reset", user_id: "u1" });
    const api = new ApiClient(BASE);
    await api.resetSession("u1");
    expect(fetchMock).toHaveBeenCalledWith(
      `${BASE}/reset`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ user_id: "u1" }),
      })
    );
  });

  it("resolves without throwing on success", async () => {
    mockFetch(200, { status: "reset", user_id: "u1" });
    const api = new ApiClient(BASE);
    await expect(api.resetSession("u1")).resolves.toBeUndefined();
  });
});

describe("ApiClient.getBadges", () => {
  it("returns badge list on success", async () => {
    mockFetch(200, ["First Question", "Persistent Learner"]);
    const api = new ApiClient(BASE);
    const badges = await api.getBadges("u1");
    expect(badges).toEqual(["First Question", "Persistent Learner"]);
  });

  it("returns empty array on non-200", async () => {
    mockFetch(404, {});
    const api = new ApiClient(BASE);
    const badges = await api.getBadges("u1");
    expect(badges).toEqual([]);
  });

  it("returns empty array when fetch throws", async () => {
    (global as any).fetch = jest.fn().mockRejectedValue(new Error("Network error"));
    const api = new ApiClient(BASE);
    const badges = await api.getBadges("u1");
    expect(badges).toEqual([]);
  });
});

describe("ApiClient.setBaseUrl", () => {
  it("updates the base URL used in subsequent requests", async () => {
    const fetchMock = mockFetch(200, { status: "ok" });
    const api = new ApiClient(BASE);
    api.setBaseUrl("http://localhost:9000/");
    await api.health();
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:9000/health",
      expect.anything()
    );
  });
});
