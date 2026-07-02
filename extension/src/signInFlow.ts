import * as http from "http";
import * as vscode from "vscode";
import { SignInPayload } from "./authManager";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export function parseCallbackPayload(body: string): SignInPayload {
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
  };
}

/**
 * Opens the hosted auth page in the user's browser and waits for it to POST
 * the sign-in payload back to a one-shot localhost server.
 */
export function signInViaBrowser(
  baseUrl: string,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<SignInPayload> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      // The auth page runs on the backend's origin; allow it to POST here.
      res.setHeader("Access-Control-Allow-Origin", "*");
      if (req.method !== "POST" || req.url !== "/callback") {
        res.statusCode = 404;
        res.end();
        return;
      }
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          const payload = parseCallbackPayload(body);
          res.end("ok");
          cleanup();
          resolve(payload);
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
      void vscode.env.openExternal(vscode.Uri.parse(`${base}/auth/login?port=${port}`));
    });
  });
}
