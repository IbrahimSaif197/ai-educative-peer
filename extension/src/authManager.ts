import * as vscode from "vscode";

export interface AuthSession {
  uid: string;
  refreshToken: string;
  email?: string;
  displayName?: string;
  isAnonymous: boolean;
}

export interface SignInPayload {
  idToken: string;
  refreshToken: string;
  uid: string;
  email?: string;
  displayName?: string;
}

export interface SecretStore {
  get(key: string): Thenable<string | undefined>;
  store(key: string, value: string): Thenable<void>;
  delete(key: string): Thenable<void>;
}

export interface StateStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: any): Thenable<void>;
}

const SESSION_KEY = "edupeer.authSession";
const PENDING_MIGRATION_KEY = "edupeer.pendingMigration";
const LEGACY_USER_ID_KEY = "edupeer.userId";
// Refresh 60s before expiry so a token is never presented mid-expiry.
const EXPIRY_MARGIN_MS = 60_000;

interface PendingMigration {
  oldRefreshToken?: string;
  legacyUserId?: string;
}

export class AuthManager {
  private idToken?: string;
  private idTokenExpiresAt = 0;
  private session?: AuthSession;
  private apiKey?: string;
  private emitter = new vscode.EventEmitter<AuthSession | undefined>();
  readonly onDidChange = this.emitter.event;

  constructor(
    private readonly secrets: SecretStore,
    private readonly globalState: StateStore,
    private baseUrl: string
  ) {}

  setBaseUrl(url: string) {
    this.baseUrl = url.replace(/\/$/, "");
    this.apiKey = undefined;
  }

  async initialize(): Promise<void> {
    const raw = await this.secrets.get(SESSION_KEY);
    if (raw) {
      this.session = JSON.parse(raw) as AuthSession;
      this.emitter.fire(this.session);
    }
  }

  getSession(): AuthSession | undefined {
    return this.session;
  }

  async getIdToken(force = false): Promise<string> {
    if (!this.session) {
      await this.bootstrapAnonymous();
      return this.idToken!;
    }
    if (!force && this.idToken && Date.now() < this.idTokenExpiresAt - EXPIRY_MARGIN_MS) {
      return this.idToken;
    }
    return this.refresh();
  }

  async applySignIn(payload: SignInPayload): Promise<void> {
    const pending: PendingMigration = {};
    if (this.session?.isAnonymous) {
      pending.oldRefreshToken = this.session.refreshToken;
    }
    const legacy = this.globalState.get<string>(LEGACY_USER_ID_KEY);
    if (legacy) {
      pending.legacyUserId = legacy;
    }
    if (pending.oldRefreshToken || pending.legacyUserId) {
      await this.secrets.store(PENDING_MIGRATION_KEY, JSON.stringify(pending));
    }

    this.session = {
      uid: payload.uid,
      refreshToken: payload.refreshToken,
      email: payload.email,
      displayName: payload.displayName,
      isAnonymous: false,
    };
    this.idToken = payload.idToken;
    this.idTokenExpiresAt = Date.now() + 55 * 60_000;
    await this.persist();
    this.emitter.fire(this.session);
    await this.runPendingMigration();
  }

  async runPendingMigration(): Promise<void> {
    const raw = await this.secrets.get(PENDING_MIGRATION_KEY);
    if (!raw || !this.session || this.session.isAnonymous) {
      return;
    }
    const pending = JSON.parse(raw) as PendingMigration;
    try {
      let oldIdToken: string | undefined;
      if (pending.oldRefreshToken) {
        oldIdToken = (await this.exchangeRefreshToken(pending.oldRefreshToken)).idToken;
      }
      const token = await this.getIdToken();
      const res = await fetch(`${this.baseUrl}/auth/migrate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          old_id_token: oldIdToken ?? null,
          legacy_user_id: pending.legacyUserId ?? null,
        }),
      });
      if (!res.ok) {
        throw new Error(`migrate failed (${res.status})`);
      }
      await this.secrets.delete(PENDING_MIGRATION_KEY);
      await this.globalState.update(LEGACY_USER_ID_KEY, undefined);
    } catch (err) {
      // Non-fatal: the pending record stays and is retried on next activation.
      console.error("[edupeer] migration deferred:", err);
    }
  }

  async signOut(): Promise<void> {
    this.session = undefined;
    this.idToken = undefined;
    await this.secrets.delete(SESSION_KEY);
    await this.bootstrapAnonymous();
  }

  private async getApiKey(): Promise<string> {
    if (!this.apiKey) {
      const res = await fetch(`${this.baseUrl}/auth/config`);
      if (!res.ok) {
        throw new Error(`auth config failed (${res.status})`);
      }
      this.apiKey = ((await res.json()) as { apiKey: string }).apiKey;
    }
    return this.apiKey;
  }

  private async bootstrapAnonymous(): Promise<void> {
    const key = await this.getApiKey();
    const res = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ returnSecureToken: true }),
      }
    );
    if (!res.ok) {
      throw new Error(`anonymous sign-in failed (${res.status})`);
    }
    const data = (await res.json()) as any;
    this.session = { uid: data.localId, refreshToken: data.refreshToken, isAnonymous: true };
    this.idToken = data.idToken;
    this.idTokenExpiresAt = Date.now() + parseInt(data.expiresIn, 10) * 1000;
    await this.persist();
    this.emitter.fire(this.session);
  }

  private async exchangeRefreshToken(
    refreshToken: string
  ): Promise<{ idToken: string; refreshToken: string; uid: string; expiresInMs: number }> {
    const key = await this.getApiKey();
    const res = await fetch(`https://securetoken.googleapis.com/v1/token?key=${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`,
    });
    if (!res.ok) {
      throw new Error(`Session expired — sign in again (${res.status})`);
    }
    const data = (await res.json()) as any;
    return {
      idToken: data.id_token,
      refreshToken: data.refresh_token,
      uid: data.user_id,
      expiresInMs: parseInt(data.expires_in, 10) * 1000,
    };
  }

  private async refresh(): Promise<string> {
    const exchanged = await this.exchangeRefreshToken(this.session!.refreshToken);
    this.idToken = exchanged.idToken;
    this.idTokenExpiresAt = Date.now() + exchanged.expiresInMs;
    this.session = { ...this.session!, refreshToken: exchanged.refreshToken, uid: exchanged.uid };
    await this.persist();
    return this.idToken;
  }

  private async persist(): Promise<void> {
    await this.secrets.store(SESSION_KEY, JSON.stringify(this.session));
  }
}
