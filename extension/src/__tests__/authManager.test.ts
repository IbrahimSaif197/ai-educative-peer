import { AuthManager, SignInPayload } from "../authManager";

const BASE = "http://localhost:8000";

class FakeSecrets {
  map = new Map<string, string>();
  get = async (k: string) => this.map.get(k);
  store = async (k: string, v: string) => void this.map.set(k, v);
  delete = async (k: string) => void this.map.delete(k);
}

class FakeState {
  map = new Map<string, any>();
  get = <T,>(k: string) => this.map.get(k) as T | undefined;
  update = async (k: string, v: any) =>
    void (v === undefined ? this.map.delete(k) : this.map.set(k, v));
}

/** Routes fetch calls by URL substring; records every call. */
function mockFetchRoutes(routes: Array<[string, number, any]>): jest.Mock {
  const mock = jest.fn(async (url: string) => {
    const match = routes.find(([frag]) => String(url).includes(frag));
    if (!match) throw new Error(`unmatched fetch: ${url}`);
    const [, status, body] = match;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  });
  (global as any).fetch = mock;
  return mock;
}

const CONFIG = ["/auth/config", 200, { apiKey: "web-key", authDomain: "x.firebaseapp.com" }] as [string, number, any];
const SIGNUP = ["accounts:signUp", 200, { localId: "anon-1", idToken: "anon-id-token", refreshToken: "anon-refresh", expiresIn: "3600" }] as [string, number, any];
const REFRESH = ["securetoken", 200, { id_token: "refreshed-id", refresh_token: "refreshed-refresh", user_id: "anon-1", expires_in: "3600" }] as [string, number, any];
const MIGRATE = ["/auth/migrate", 200, { status: "ok", merged: 1 }] as [string, number, any];

afterEach(() => jest.restoreAllMocks());

function makeManager() {
  const secrets = new FakeSecrets();
  const state = new FakeState();
  const auth = new AuthManager(secrets, state, BASE);
  return { auth, secrets, state };
}

describe("anonymous bootstrap", () => {
  it("creates an anonymous account on first getIdToken and persists it", async () => {
    const fetchMock = mockFetchRoutes([CONFIG, SIGNUP]);
    const { auth, secrets } = makeManager();
    const token = await auth.getIdToken();
    expect(token).toBe("anon-id-token");
    expect(auth.getSession()).toMatchObject({ uid: "anon-1", isAnonymous: true });
    expect(secrets.map.get("edupeer.authSession")).toContain("anon-1");
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("accounts:signUp"))).toBe(true);
  });

  it("reuses the cached idToken without another fetch", async () => {
    const fetchMock = mockFetchRoutes([CONFIG, SIGNUP]);
    const { auth } = makeManager();
    await auth.getIdToken();
    const callsAfterFirst = fetchMock.mock.calls.length;
    await auth.getIdToken();
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
  });

  it("refreshes via securetoken when force=true", async () => {
    mockFetchRoutes([CONFIG, SIGNUP, REFRESH]);
    const { auth } = makeManager();
    await auth.getIdToken();
    const token = await auth.getIdToken(true);
    expect(token).toBe("refreshed-id");
  });
});

describe("applySignIn and migration", () => {
  const payload: SignInPayload = {
    idToken: "real-id", refreshToken: "real-refresh", uid: "real-1",
    email: "a@b.com", displayName: "Ada",
  };

  it("replaces the anonymous session and migrates its progress", async () => {
    const fetchMock = mockFetchRoutes([CONFIG, SIGNUP, REFRESH, MIGRATE]);
    const { auth, state } = makeManager();
    await state.update("edupeer.userId", "user-legacy1");
    await auth.getIdToken(); // become anonymous first
    await auth.applySignIn(payload);

    expect(auth.getSession()).toMatchObject({ uid: "real-1", isAnonymous: false });
    const migrateCall = fetchMock.mock.calls.find(([u]) => String(u).includes("/auth/migrate"));
    expect(migrateCall).toBeDefined();
    const body = JSON.parse(migrateCall![1].body);
    expect(body.old_id_token).toBe("refreshed-id"); // old refresh token exchanged
    expect(body.legacy_user_id).toBe("user-legacy1");
    // migration succeeded -> pending record and legacy id cleared
    expect(state.get("edupeer.userId")).toBeUndefined();
  });

  it("keeps the pending migration when the migrate call fails", async () => {
    jest.spyOn(console, "error").mockImplementation(() => {});
    mockFetchRoutes([CONFIG, SIGNUP, REFRESH, ["/auth/migrate", 500, {}]]);
    const { auth, secrets } = makeManager();
    await auth.getIdToken();
    await auth.applySignIn(payload);
    expect(secrets.map.has("edupeer.pendingMigration")).toBe(true);
  });

  it("accumulates pending migrations across sign-in cycles instead of clobbering", async () => {
    jest.spyOn(console, "error").mockImplementation(() => {});
    let signUpCount = 0;
    let migrateStatus = 500;
    const okMigrateBodies: any[] = [];
    const respond = (status: number, body: any) => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    });
    (global as any).fetch = jest.fn(async (url: string, init?: any) => {
      const u = String(url);
      if (u.includes("/auth/config")) {
        return respond(200, { apiKey: "web-key", authDomain: "x.firebaseapp.com" });
      }
      if (u.includes("accounts:signUp")) {
        const n = signUpCount++;
        return respond(200, {
          localId: `anon-${n}`, idToken: `anon-id-${n}`,
          refreshToken: `anon-refresh-${n}`, expiresIn: "3600",
        });
      }
      if (u.includes("securetoken")) {
        // Echo back an id_token derived from the refresh token in the body,
        // so each anonymous account exchanges to a distinct old ID token.
        const m = /refresh_token=([^&]+)/.exec(String(init?.body));
        const n = decodeURIComponent(m![1]).replace("anon-refresh-", "");
        return respond(200, {
          id_token: `refreshed-${n}`, refresh_token: `anon-refresh-${n}`,
          user_id: `anon-${n}`, expires_in: "3600",
        });
      }
      if (u.includes("/auth/migrate")) {
        if (migrateStatus === 200) okMigrateBodies.push(JSON.parse(init.body));
        return respond(migrateStatus, migrateStatus === 200 ? { status: "ok", merged: 1 } : {});
      }
      throw new Error(`unmatched fetch: ${u}`);
    });

    const { auth, secrets } = makeManager();
    await auth.getIdToken();          // anonymous X0 (anon-refresh-0)
    await auth.applySignIn(payload);  // migrate fails -> X0 record kept
    expect(secrets.map.has("edupeer.pendingMigration")).toBe(true);
    await auth.signOut();             // fresh anonymous X1 (anon-refresh-1)
    migrateStatus = 200;
    await auth.applySignIn({ idToken: "real-id-2", refreshToken: "real-refresh-2", uid: "real-2" });

    // Both X0's and X1's progress migrated: old ID tokens from BOTH refresh tokens.
    const oldTokens = okMigrateBodies.map((b) => b.old_id_token);
    expect(oldTokens).toContain("refreshed-0");
    expect(oldTokens).toContain("refreshed-1");
    expect(secrets.map.has("edupeer.pendingMigration")).toBe(false);
  });
});

describe("signOut", () => {
  it("clears the session and bootstraps a fresh anonymous account", async () => {
    mockFetchRoutes([CONFIG, SIGNUP]);
    const { auth } = makeManager();
    await auth.applySignIn({ idToken: "t", refreshToken: "r", uid: "real-1" });
    await auth.signOut();
    expect(auth.getSession()).toMatchObject({ isAnonymous: true });
  });
});
