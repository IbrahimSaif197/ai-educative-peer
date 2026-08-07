import * as crypto from "crypto";
import * as http from "http";
import * as vscode from "vscode";
import { SignInPayload } from "./authManager";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/** Hex length of the sign-in state nonce; mirrored by the regex in auth.html. */
const STATE_BYTES = 16;

export function newSignInState(): string {
  return crypto.randomBytes(STATE_BYTES).toString("hex");
}

/**
 * Constant-time comparison of two state nonces.
 *
 * `timingSafeEqual` throws on a length mismatch, so the length is checked
 * first — that check leaks only the length, which is a public constant.
 */
export function stateMatches(expected: string, received: unknown): boolean {
  if (typeof received !== "string" || received.length !== expected.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(received));
}

export function parseCallbackPayload(body: string): SignInPayload & { state: string } {
  const data = JSON.parse(body);
  if (!data.idToken || !data.refreshToken || !data.uid) {
    throw new Error("invalid sign-in payload");
  }
  return {
    idToken: data.idToken,
    refreshToken: data.refreshToken,
    uid: data.uid,
    email: data.email || undefined,
    displayName: data.displayName || undefined,
    state: typeof data.state === "string" ? data.state : "",
  };
}

/**
 * Opens the hosted auth page in the user's browser and waits for it to POST
 * the sign-in payload back to a one-shot localhost server.
 *
 * The callback is bound to a fresh 128-bit state nonce that only this
 * invocation and the page it opened know. Without it, any web page the user
 * had open could POST its own Firebase tokens to the loopback port during the
 * sign-in window and take over the session — and because the callback is a
 * CORS-simple request, no browser gate would stop it. The port alone is not a
 * secret: it is guessable in ~16k tries.
 */
export function signInViaBrowser(
  baseUrl: string,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<SignInPayload> {
  return new Promise((resolve, reject) => {
    const state = newSignInState();

    const server = http.createServer((req, res) => {
      if (req.method !== "POST" || req.url !== "/callback") {
        // No Access-Control-Allow-Origin here: a readable 404 turns this
        // server into a cross-origin port scanner that finds the one open
        // loopback port worth attacking.
        res.statusCode = 404;
        res.end();
        return;
      }
      // The auth page runs on the backend's origin and never reads this
      // response, so the delivery path does not need CORS either.
      let body = "";
      let tooLarge = false;
      req.on("data", (chunk) => {
        body += chunk;
        // A stranger who found the port should not be able to grow the
        // extension host's heap by streaming at it.
        if (body.length > 64 * 1024) {
          tooLarge = true;
          req.destroy();
        }
      });
      req.on("end", () => {
        if (tooLarge) return;
        try {
          const payload = parseCallbackPayload(body);
          if (!stateMatches(state, payload.state)) {
            res.statusCode = 403;
            res.end("state mismatch");
            return;
          }
          const { state: _state, ...session } = payload;
          res.end("ok");
          cleanup();
          resolve(session);
        } catch {
          res.statusCode = 400;
          res.end("bad payload");
        }
      });
    });

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Sign-in timed out — no response from the browser."));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      server.close();
    }

    server.on("error", (err) => {
      cleanup();
      reject(err);
    });

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const base = baseUrl.replace(/\/$/, "");
      void vscode.env.openExternal(
        vscode.Uri.parse(`${base}/auth/login?port=${port}&state=${state}`)
      );
    });
  });
}
