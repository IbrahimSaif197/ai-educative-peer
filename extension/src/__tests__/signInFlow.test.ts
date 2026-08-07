import { newSignInState, parseCallbackPayload, signInViaBrowser, stateMatches } from "../signInFlow";

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
    expect(p).toEqual({
      idToken: "i",
      refreshToken: "r",
      uid: "u",
      email: "e@x.com",
      displayName: "E",
      state: "",
    });
  });

  it("carries the state nonce through", () => {
    const p = parseCallbackPayload(
      JSON.stringify({ idToken: "i", refreshToken: "r", uid: "u", state: "abc" })
    );
    expect(p.state).toBe("abc");
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

  /** Starts a sign-in and returns the port and state from the opened URL. */
  async function start(timeoutMs?: number) {
    const promise = signInViaBrowser("http://localhost:8000", timeoutMs);
    const uri = await waitFor(() => vscode.env.openExternal.mock.calls[0]?.[0]);
    const url = new URL(uri.toString());
    expect(url.pathname).toBe("/auth/login");
    return {
      promise,
      port: url.searchParams.get("port")!,
      state: url.searchParams.get("state")!,
    };
  }

  const post = (port: string, body: unknown) =>
    fetch(`http://127.0.0.1:${port}/callback`, {
      method: "POST",
      body: JSON.stringify(body),
    });

  it("opens the browser and resolves with the payload POSTed to /callback", async () => {
    const { promise, port, state } = await start();
    expect(port).toBeTruthy();

    const res = await post(port, {
      idToken: "i", refreshToken: "r", uid: "u1", email: "", displayName: "", state,
    });
    expect(res.ok).toBe(true);
    const payload = await promise;
    expect(payload.uid).toBe("u1");
    expect(payload).not.toHaveProperty("state");
  });

  it("puts a 32-hex state nonce on the login url", async () => {
    const { promise, port, state } = await start();
    expect(state).toMatch(/^[a-f0-9]{32}$/);
    await post(port, { idToken: "i", refreshToken: "r", uid: "u1", state });
    await promise;
  });

  it("rejects a callback with no state", async () => {
    const { promise, port, state } = await start();
    const res = await post(port, { idToken: "evil", refreshToken: "r", uid: "attacker" });
    expect(res.status).toBe(403);

    // The server is still listening for the real callback.
    await post(port, { idToken: "i", refreshToken: "r", uid: "u1", state });
    expect((await promise).uid).toBe("u1");
  });

  it("rejects a callback with the wrong state", async () => {
    const { promise, port, state } = await start();
    const res = await post(port, {
      idToken: "evil", refreshToken: "r", uid: "attacker", state: newSignInState(),
    });
    expect(res.status).toBe(403);

    await post(port, { idToken: "i", refreshToken: "r", uid: "u1", state });
    expect((await promise).uid).toBe("u1");
  });

  it("does not make non-callback responses cross-origin readable", async () => {
    const { promise, port, state } = await start();
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(404);
    // Without this the server answers a cross-origin probe, which turns it
    // into a reliable scanner for the one loopback port worth attacking.
    expect(res.headers.get("access-control-allow-origin")).toBeNull();

    await post(port, { idToken: "i", refreshToken: "r", uid: "u1", state });
    await promise;
  });

  it("rejects after the timeout when no callback arrives", async () => {
    await expect(signInViaBrowser("http://localhost:8000", 100)).rejects.toThrow(/timed out/i);
  });
});

describe("stateMatches", () => {
  it("accepts the exact nonce", () => {
    const s = newSignInState();
    expect(stateMatches(s, s)).toBe(true);
  });

  it("rejects a different nonce of the same length", () => {
    expect(stateMatches(newSignInState(), newSignInState())).toBe(false);
  });

  it("rejects a different length without throwing", () => {
    expect(stateMatches(newSignInState(), "short")).toBe(false);
  });

  it("rejects non-strings", () => {
    expect(stateMatches(newSignInState(), undefined)).toBe(false);
    expect(stateMatches(newSignInState(), 42)).toBe(false);
  });

  it("mints a fresh nonce each time", () => {
    expect(newSignInState()).not.toBe(newSignInState());
  });
});
