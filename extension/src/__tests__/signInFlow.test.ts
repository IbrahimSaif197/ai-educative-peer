import {
  deliverUriCallback,
  newSignInState,
  parseCallbackPayload,
  signInViaBrowser,
  stateMatches,
} from "../signInFlow";

const vscode = require("vscode");

const post = (port: string, body: unknown) =>
  fetch(`http://127.0.0.1:${port}/callback`, {
    method: "POST",
    body: JSON.stringify(body),
  });

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

describe("deliverUriCallback", () => {
  afterEach(() => jest.clearAllMocks());

  const encode = (obj: unknown) =>
    "payload=" + Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");

  /** Starts a sign-in that advertises the URI-handler path to the page. */
  async function startWithUri() {
    const promise = signInViaBrowser("http://localhost:8000", 5000, {
      uriScheme: "vscode",
      extensionId: "edupeer.edupeer",
    });
    const uri = await waitFor(() => vscode.env.openExternal.mock.calls[0]?.[0]);
    const url = new URL(uri.toString());
    return {
      promise,
      url,
      port: url.searchParams.get("port")!,
      state: url.searchParams.get("state")!,
    };
  }

  it("tells the page where to hand the session back", async () => {
    const { promise, url, state, port } = await startWithUri();
    expect(url.searchParams.get("scheme")).toBe("vscode");
    expect(url.searchParams.get("ext")).toBe("edupeer.edupeer");

    expect(
      deliverUriCallback(encode({ idToken: "i", refreshToken: "r", uid: "u1", state }))
    ).toBe(true);
    expect((await promise).uid).toBe("u1");
    expect(port).toBeTruthy();
  });

  it("omits the deep-link params when the editor identity is unknown", async () => {
    const promise = signInViaBrowser("http://localhost:8000", 200);
    const uri = await waitFor(() => vscode.env.openExternal.mock.calls[0]?.[0]);
    const url = new URL(uri.toString());
    expect(url.searchParams.get("scheme")).toBeNull();
    expect(url.searchParams.get("ext")).toBeNull();
    await expect(promise).rejects.toThrow(/timed out/i);
  });

  it("refuses a callback whose state does not match", async () => {
    const { promise, port, state } = await startWithUri();
    expect(
      deliverUriCallback(
        encode({ idToken: "evil", refreshToken: "r", uid: "attacker", state: newSignInState() })
      )
    ).toBe(false);
    expect(deliverUriCallback(encode({ idToken: "evil", refreshToken: "r", uid: "x" }))).toBe(false);

    // Still listening for the real one.
    await post(port, { idToken: "i", refreshToken: "r", uid: "u1", state });
    expect((await promise).uid).toBe("u1");
  });

  it("ignores malformed links instead of throwing", async () => {
    const { promise, port, state } = await startWithUri();
    expect(deliverUriCallback("")).toBe(false);
    expect(deliverUriCallback("payload=not-base64-json")).toBe(false);
    expect(deliverUriCallback(encode({ uid: "u" }))).toBe(false);

    await post(port, { idToken: "i", refreshToken: "r", uid: "u1", state });
    await promise;
  });

  it("ignores a link when no sign-in is waiting", () => {
    expect(
      deliverUriCallback(encode({ idToken: "i", refreshToken: "r", uid: "u", state: "x" }))
    ).toBe(false);
  });

  it("stops accepting links once the attempt has timed out", async () => {
    const promise = signInViaBrowser("http://localhost:8000", 60, {
      uriScheme: "vscode",
      extensionId: "edupeer.edupeer",
    });
    const uri = await waitFor(() => vscode.env.openExternal.mock.calls[0]?.[0]);
    const state = new URL(uri.toString()).searchParams.get("state")!;
    await expect(promise).rejects.toThrow(/timed out/i);

    expect(
      deliverUriCallback(encode({ idToken: "i", refreshToken: "r", uid: "u1", state }))
    ).toBe(false);
  });

  it("does not resolve twice when both paths deliver", async () => {
    const { promise, port, state } = await startWithUri();
    expect(
      deliverUriCallback(encode({ idToken: "i", refreshToken: "r", uid: "first", state }))
    ).toBe(true);
    expect((await promise).uid).toBe("first");

    // The loopback server is closed, so the late POST has nowhere to land.
    await expect(post(port, { idToken: "i", refreshToken: "r", uid: "second", state })).rejects.toThrow();
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
