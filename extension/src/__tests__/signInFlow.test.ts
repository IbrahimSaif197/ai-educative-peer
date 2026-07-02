import { parseCallbackPayload, signInViaBrowser } from "../signInFlow";

const vscode = require("vscode");

async function waitFor<T>(fn: () => T | undefined, ms = 2000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("parseCallbackPayload", () => {
  it("parses a valid payload", () => {
    const p = parseCallbackPayload(
      JSON.stringify({ idToken: "i", refreshToken: "r", uid: "u", email: "e@x.com", displayName: "E" })
    );
    expect(p).toEqual({ idToken: "i", refreshToken: "r", uid: "u", email: "e@x.com", displayName: "E" });
  });

  it("treats empty email/displayName as undefined", () => {
    const p = parseCallbackPayload(
      JSON.stringify({ idToken: "i", refreshToken: "r", uid: "u", email: "", displayName: "" })
    );
    expect(p.email).toBeUndefined();
    expect(p.displayName).toBeUndefined();
  });

  it("throws on a payload missing required fields", () => {
    expect(() => parseCallbackPayload(JSON.stringify({ uid: "u" }))).toThrow();
    expect(() => parseCallbackPayload("not json")).toThrow();
  });
});

describe("signInViaBrowser", () => {
  afterEach(() => jest.clearAllMocks());

  it("opens the browser and resolves with the payload POSTed to /callback", async () => {
    const promise = signInViaBrowser("http://localhost:8000");
    const uri = await waitFor(() => vscode.env.openExternal.mock.calls[0]?.[0]);
    const url = new URL(uri.toString());
    expect(url.pathname).toBe("/auth/login");
    const port = url.searchParams.get("port");
    expect(port).toBeTruthy();

    const res = await fetch(`http://127.0.0.1:${port}/callback`, {
      method: "POST",
      body: JSON.stringify({ idToken: "i", refreshToken: "r", uid: "u1", email: "", displayName: "" }),
    });
    expect(res.ok).toBe(true);
    const payload = await promise;
    expect(payload.uid).toBe("u1");
  });

  it("rejects after the timeout when no callback arrives", async () => {
    await expect(signInViaBrowser("http://localhost:8000", 100)).rejects.toThrow(/timed out/i);
  });
});
