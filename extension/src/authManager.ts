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
  oldRefreshTokens: string[];
  legacyUserId?: string;
  /**
   * The uid these anonymous accounts were captured for.
   *
   * Migration is destructive on the backend — it merges the source document
   * into the target and deletes the source. Without this, a migration that
   * failed for user A stayed queued and replayed into whichever account
   * signed in next on the same machine, handing A's progress to B and
   * deleting A's record. The queue is only replayed for the uid it was
   * captured against.
   */
  capturedForUid?: string;
}

export class AuthManager {
  private idToken?: string;
  private idTokenExpiresAt = 0;
  private session?: AuthSession;
  private apiKey?: string;
  // In-flight dedupe: concurrent callers await the same underlying
  // network round-trip instead of each kicking off their own (which would
  // double-bootstrap an anonymous account, or burn a rotated refresh token).
  private bootstrapPromise?: Promise<void>;
  private refreshPromise?: Promise<string>;
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
      await (this.bootstrapPromise ??= this.bootstrapAnonymous().finally(() => {
        this.bootstrapPromise = undefined;
      }));
      return this.idToken!;
    }
    if (!force && this.idToken && Date.now() < this.idTokenExpiresAt - EXPIRY_MARGIN_MS) {
      return this.idToken;
    }
    return this.refresh();
  }

  async applySignIn(payload: SignInPayload): Promise<void> {
    // Start from any existing record (e.g. from a previously failed migration)
    // so earlier anonymous accounts are never silently clobbered.
    const existing = await this.secrets.get(PENDING_MIGRATION_KEY);
    let pending: PendingMigration = existing
      ? (JSON.parse(existing) as PendingMigration)
      : { oldRefreshTokens: [] };
    if (!Array.isArray(pending.oldRefreshTokens)) {
      pending.oldRefreshTokens = [];
    }
    // A record captured for a different account belongs to whoever was signed
    // in before; replaying it here would merge their progress into this
    // account and delete theirs. Start clean instead.
    if (pending.capturedForUid !== undefined && pending.capturedForUid !== payload.uid) {
      pending = { oldRefreshTokens: [] };
    }
    pending.capturedForUid = payload.uid;
    if (this.session?.isAnonymous) {
      pending.oldRefreshTokens.push(this.session.refreshToken);
    }
    if (!pending.legacyUserId) {
      const legacy = this.globalState.get<string>(LEGACY_USER_ID_KEY);
      if (legacy) {
        pending.legacyUserId = legacy;
      }
    }
    if (pending.oldRefreshTokens.length > 0 || pending.legacyUserId) {
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
    if (pending.capturedForUid !== undefined && pending.capturedForUid !== this.session.uid) {
      // Queued for someone else. Merging is irreversible on the backend, so
      // drop it rather than replay it into the account that happens to be
      // signed in now.
      await this.secrets.delete(PENDING_MIGRATION_KEY);
      return;
    }
    const tokens = Array.isArray(pending.oldRefreshTokens) ? pending.oldRefreshTokens : [];
    const remaining: string[] = [];
    let legacyUserId = pending.legacyUserId;

    let idToken: string;
    try {
      idToken = await this.getIdToken();
    } catch (err) {
      // Non-fatal: the pending record stays and is retried on next activation.
      console.error("[edupeer] migration deferred:", err);
      return;
    }

    // Migrate each old anonymous account independently: a failure for one
    // token must not abort the others — it just stays queued for next time.
    for (const oldRefreshToken of tokens) {
      let oldIdToken: string;
      try {
        oldIdToken = (await this.exchangeRefreshToken(oldRefreshToken)).idToken;
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (status !== undefined && status >= 400 && status < 500) {
          // The old account is permanently gone (e.g. Firebase pruned a
          // stale anonymous user) — nothing left to migrate, so drop it
          // instead of retrying it forever.
          continue;
        }
        // Network error or 5xx: transient, keep it queued for next time.
        remaining.push(oldRefreshToken);
        continue;
      }
      try {
        // Carry legacyUserId until one call carrying it succeeds.
        const carriedLegacy = legacyUserId;
        if (await this.postMigrate(idToken, oldIdToken, carriedLegacy)) {
          if (carriedLegacy !== undefined) {
            legacyUserId = undefined;
          }
        } else {
          remaining.push(oldRefreshToken);
        }
      } catch {
        remaining.push(oldRefreshToken);
      }
    }

    // Legacy-only migration once there are no old refresh tokens left to
    // process, whether because there never were any or because this pass
    // pruned/migrated all of them.
    if (remaining.length === 0 && legacyUserId !== undefined) {
      try {
        if (await this.postMigrate(idToken, undefined, legacyUserId)) {
          legacyUserId = undefined;
        }
      } catch {
        // keep legacyUserId queued
      }
    }

    if (legacyUserId === undefined && pending.legacyUserId !== undefined) {
      await this.globalState.update(LEGACY_USER_ID_KEY, undefined);
    }

    if (remaining.length > 0 || legacyUserId !== undefined) {
      const updated: PendingMigration = {
        oldRefreshTokens: remaining,
        legacyUserId,
        capturedForUid: pending.capturedForUid ?? this.session.uid,
      };
      await this.secrets.store(PENDING_MIGRATION_KEY, JSON.stringify(updated));
      // Non-fatal: whatever is left stays and is retried on next activation.
      console.error("[edupeer] migration deferred: retrying remaining items on next activation");
    } else {
      await this.secrets.delete(PENDING_MIGRATION_KEY);
    }
  }

  private async postMigrate(
    idToken: string,
    oldIdToken?: string,
    legacyUserId?: string
  ): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/auth/migrate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
      body: JSON.stringify({
        old_id_token: oldIdToken ?? null,
        legacy_user_id: legacyUserId ?? null,
      }),
    });
    return res.ok;
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
      const err = new Error(`Session expired — sign in again (${res.status})`) as Error & {
        status?: number;
      };
      err.status = res.status;
      throw err;
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
    return (this.refreshPromise ??= this.doRefresh().finally(() => {
      this.refreshPromise = undefined;
    }));
  }

  private async doRefresh(): Promise<string> {
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
