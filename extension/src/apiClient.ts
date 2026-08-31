import type { CodeBand, CodeDigest } from "./codeDigest";

export interface ChatTurn {
  role: "student" | "tutor";
  content: string;
}

export interface TokenProvider {
  getIdToken(force?: boolean): Promise<string>;
}

/**
 * The block inside `code` the student is working on, 1-based and inclusive.
 *
 * `code` is a digest, not the file: the imports, the enclosing headers, one
 * line per top-level definition, and this block. So the span is not merely
 * advisory any more — it names the part of the digest the answer is about,
 * and the backend scopes both its instruction and its flags to it. The
 * numbers are absolute editor lines, the same coordinates `bands` uses.
 */
export interface FocusRange {
  start_line: number;
  end_line: number;
  label?: string;
}

export interface HintRequest {
  code: string;
  question: string;
  hint_level: number;
  /**
   * Stable identifier for the problem (the document URI). The hint ladder is
   * keyed on this rather than a hash of the code, so editing the file deepens
   * the hint instead of restarting at level 1.
   */
  problem_key?: string;
  language?: string;
  mode?: string;
  history?: ChatTurn[];
  /** False re-uses the current hint level instead of advancing it. */
  escalate?: boolean;
  /** Compact diff of what the student changed since the last hint. */
  edit_summary?: string;
  /** Self-rated confidence 1-3 before the hint; 0 or omitted means not given. */
  confidence?: number;
  /** The block the student is working on; omitted when it could not be resolved. */
  focus?: FocusRange;
  /** Absolute line ranges `code` was lifted from. */
  bands?: CodeBand[];
  /** Lines in the real file, so an elision can say how much is missing. */
  total_lines?: number;
}

/**
 * Thrown when the sign-in chain fails: the backend has no Firebase web API key
 * configured, the anonymous bootstrap is refused, or a refresh token no longer
 * exchanges.
 *
 * Kept distinct from a network failure because the two need opposite fixes. The
 * requests that carry a token never reach the wire when this is thrown, so
 * treating it as proof the backend is down told students to restart a server
 * that was answering /health perfectly well.
 */
export class AuthError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "AuthError";
  }
}

/** Thrown when the backend asks us to slow down, so callers can stay quiet. */
export class RateLimitError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super("EduPeer is getting a lot of questions from you — give it a moment.");
    this.name = "RateLimitError";
  }
}

function rateLimitErrorFrom(res: Response): RateLimitError {
  const header = Number(res.headers?.get?.("Retry-After"));
  return new RateLimitError(Number.isFinite(header) && header > 0 ? header : 30);
}

/**
 * Modes young enough that a backend may not have heard of them yet. Its
 * `TutorMode` literal rejects the value outright, so the request comes back
 * 422 — a perfectly ordinary HTTP response, which means the client stays
 * "available" and the offline tutor never steps in. What the student saw was
 * the raw validation JSON in an error banner.
 *
 * Every other mode this client sends has been in `TutorMode` since v1, so a
 * 422 for one of those is a real contract breach and still surfaces.
 */
const DOWNGRADABLE_MODES = new Set(["answer"]);

/**
 * The same request as a plain hint, or undefined when the mode is old enough
 * that a 422 cannot be version skew. Degrading rather than surfacing is the
 * convention here — see `ProgressReport.calibration`.
 */
function withoutNewMode(req: HintRequest): HintRequest | undefined {
  if (!req.mode || !DOWNGRADABLE_MODES.has(req.mode)) return undefined;
  // `escalate` is forced false on the way down. Answer mode never runs the
  // attempt gate, so the request reaches here carrying the default `true` -
  // and once the mode is rewritten to `hint`, that flag is precisely what the
  // backend advances the ladder on. Left alone, asking for the answer would
  // climb a rung against an older backend and not against a current one.
  return { ...req, mode: "hint", escalate: false };
}

export interface HintResponse {
  hint: string;
  hint_level: number;
  concept_tags: string[];
  /**
   * The mode the backend actually ran, which is not always the one asked for:
   * a hint at the top of the ladder *is* the worked example. The panel labels
   * each card from this, so dropping it titles a worked example "hint 4".
   *
   * Added in v2; absent when talking to an older backend, so callers fall back
   * to the mode they requested.
   */
  mode?: string;
}

export interface LineFlag {
  line: number;
  end_line: number;
  question: string;
  concept: string;
  severity: "info" | "warning";
  kind?: "bug" | "style";
}

export interface ScanResponse {
  flags: LineFlag[];
}

export interface LineHintResponse {
  hint: string;
  concept: string;
}

export interface ConceptStat {
  concept: string;
  encounters: number;
  avg_level: number;
}

export interface ProgressReport {
  badges: string[];
  total_interactions: number;
  sessions: number;
  streak_days: number;
  languages_used: string[];
  goal: { text: string; concepts: string[] } | null;
  concept_struggles: ConceptStat[];
  concept_strengths: ConceptStat[];
  session_summaries: Array<{ text: string; date: string }>;
  review_due: boolean;
  /** Added in v2; absent when talking to an older backend. */
  calibration?: CalibrationReport;
  hint_level_counts?: Record<string, number>;
  activity?: ActivityDay[];
}

export interface ReviewResponse {
  due: boolean;
  concepts: string[];
  exercise: string;
}

export interface TraceResponse {
  variables: string[];
  steps: number;
  prompt: string;
}

export interface CalibrationReport {
  samples: number;
  score: number;
  calibrated: number;
  overconfident: number;
  underconfident: number;
  enough_data: boolean;
}

export interface ActivityDay {
  date: string;
  count: number;
}

export interface SseEvent {
  type: string;
  [key: string]: unknown;
}

/**
 * Pull complete `data: {...}` SSE events out of buffer+chunk; returns the
 * parsed events and the unconsumed remainder.
 */
export function parseSseChunk(buffer: string, chunk: string): { events: SseEvent[]; rest: string } {
  let data = buffer + chunk;
  const events: SseEvent[] = [];
  let idx: number;
  while ((idx = data.indexOf("\n\n")) >= 0) {
    const block = data.slice(0, idx);
    data = data.slice(idx + 2);
    for (const line of block.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      try {
        events.push(JSON.parse(line.slice(6)) as SseEvent);
      } catch {
        /* skip malformed events */
      }
    }
  }
  return { events, rest: data };
}

/**
 * How long a normal request may take before it is abandoned. Without a
 * deadline a backend that accepts the connection and then stalls leaves the
 * sidebar spinning on "EduPeer is thinking…" forever, with no cancel button.
 */
export const REQUEST_TIMEOUT_MS = 20_000;

/**
 * The deadline for the one retry after a timeout, sized for a cold start.
 *
 * The backend runs on Render's free plan, which stops the service after ~15
 * minutes idle and takes roughly 50 seconds to wake. Against a 20-second
 * deadline that is not a slow request, it is a guaranteed failure: the first
 * student to ask anything after a quiet spell waits 20s, gets the offline
 * tutor, and reasonably concludes EduPeer is broken. A scheduled pinger
 * narrows the window but never closes it — every deploy restarts the service
 * too.
 *
 * So a timeout buys exactly one more attempt on a longer clock. A waking
 * backend answers inside it; a genuinely dead one costs the student an extra
 * minute once, after which `isAvailable` is false and later asks fail fast
 * against the offline tutor instead of retrying again.
 */
export const COLD_START_TIMEOUT_MS = 75_000;

/**
 * How long a stream may go without producing a chunk. The whole stream has no
 * overall deadline — a long hint legitimately takes a while — but silence does.
 */
export const STREAM_IDLE_TIMEOUT_MS = 30_000;

/** Thrown when a request or stream is abandoned for taking too long. */
export class TimeoutError extends Error {
  constructor(message = "EduPeer took too long to respond.") {
    super(message);
    this.name = "TimeoutError";
  }
}

/**
 * Rejects with a TimeoutError if `promise` has not settled within `ms`.
 *
 * Used per chunk rather than per stream so a slow-but-alive stream is never
 * cut off, while a stream that goes silent is.
 */
export async function withIdleDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new TimeoutError("The hint stream stalled.")), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * `AbortSignal.timeout` under a name we can stub in tests, and with a manual
 * fallback for hosts that predate it (VS Code 1.85 ships Node 18.15, where it
 * exists, but the webview/test environments are not guaranteed to).
 */
function timeoutSignal(ms: number): AbortSignal {
  const anyAbort = AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal };
  if (typeof anyAbort.timeout === "function") {
    return anyAbort.timeout(ms);
  }
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms).unref?.();
  return controller.signal;
}

/**
 * The three fields `scanCode` and `getLineHint` build their payload from.
 *
 * One function so there is one place a digest becomes those fields — but it
 * is not the only door to the network: `getHint`/`streamHint` forward
 * whatever `code` the caller already put on the request. So the property that
 * makes "the file never leaves the machine" checkable rather than merely
 * intended lives in the callers, not in this function — `auditRegressions`
 * reads `sidebarProvider.ts`, `inlineTutor.ts` and `extension.ts` directly
 * rather than trusting that they used this.
 *
 * `getTrace` used to be the third door and the only unbounded one, carrying a
 * whole block as a plain string. It now sends no code at all, because the
 * handler never read it — so every remaining door goes through `buildDigest`
 * and is bounded at `MAX_DIGEST_LINES`.
 */
export function digestFields(digest: CodeDigest): {
  code: string;
  bands: CodeBand[];
  total_lines: number;
} {
  return { code: digest.code, bands: digest.bands, total_lines: digest.totalLines };
}

export class ApiClient {
  private available = true;
  private readonly availabilityListeners: Array<(up: boolean) => void> = [];
  private authHealthy = true;
  private readonly authListeners: Array<(ok: boolean) => void> = [];

  /**
   * Called when a request times out and is about to be retried on the
   * cold-start clock. The wait can run to a minute, and a spinner that says
   * nothing for that long reads as a hang — this lets the panel say what is
   * actually happening. Optional: nothing breaks if no one is listening.
   */
  onColdStart?: () => void;

  constructor(private baseUrl: string, private readonly tokens: TokenProvider) {}

  setBaseUrl(url: string) {
    this.baseUrl = url.replace(/\/$/, "");
  }

  get isAvailable(): boolean {
    return this.available;
  }

  /** False once the sign-in chain has failed and not yet recovered. */
  get isAuthHealthy(): boolean {
    return this.authHealthy;
  }

  onAvailabilityChange(listener: (up: boolean) => void): void {
    this.availabilityListeners.push(listener);
  }

  onAuthHealthChange(listener: (ok: boolean) => void): void {
    this.authListeners.push(listener);
  }

  private setAuthHealthy(ok: boolean): void {
    if (this.authHealthy === ok) return;
    this.authHealthy = ok;
    for (const listener of this.authListeners) {
      try {
        listener(ok);
      } catch {
        /* listeners must not break the client */
      }
    }
  }

  private setAvailable(up: boolean): void {
    if (this.available === up) return;
    this.available = up;
    for (const listener of this.availabilityListeners) {
      try {
        listener(up);
      } catch {
        /* listeners must not break the client */
      }
    }
  }

  async health(): Promise<boolean> {
    try {
      // A short deadline: this runs on the activate() path, and a hung probe
      // would delay registering every command behind it.
      const res = await fetch(`${this.baseUrl}/health`, {
        method: "GET",
        signal: timeoutSignal(5_000),
      });
      this.setAvailable(res.ok);
      return res.ok;
    } catch {
      this.setAvailable(false);
      return false;
    }
  }

  /** Fetch with a Bearer token; on 401, refresh the token once and retry. */
  private async authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
    // Spreading `init` would let an explicit `signal: undefined` overwrite the
    // deadline with nothing, so the caller's signal is applied by name and only
    // when it exists.
    const { signal, ...rest } = init;
    const attempt = async (force: boolean, timeoutMs = REQUEST_TIMEOUT_MS) => {
      const token = await this.tokens.getIdToken(force);
      return fetch(`${this.baseUrl}${path}`, {
        ...rest,
        signal: signal ?? timeoutSignal(timeoutMs),
        headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${token}` },
      });
    };
    const isTimeout = (e: unknown) => (e as { name?: string })?.name === "AbortError";
    try {
      let res: Response;
      try {
        res = await attempt(false);
      } catch (err) {
        // A caller-supplied signal is the caller's deadline to own — retrying
        // under it would ignore a cancellation the student asked for.
        if (!isTimeout(err) || signal) throw err;
        this.onColdStart?.();
        res = await attempt(false, COLD_START_TIMEOUT_MS);
      }
      if (res.status === 401) {
        res = await attempt(true);
      }
      this.setAvailable(true);
      this.setAuthHealthy(true);
      return res;
    } catch (err) {
      if (err instanceof AuthError) {
        // Sign-in is broken, which says nothing about the backend: this threw
        // before the request was ever sent. Leave availability alone so the
        // student is not told to go restart a healthy server.
        this.setAuthHealthy(false);
        throw err;
      }
      if ((err as { name?: string })?.name === "AbortError") {
        // A timeout is not proof the backend is down, but from the student's
        // side it is indistinguishable, and the offline tutor is a better
        // answer than a spinner.
        this.setAvailable(false);
        throw new TimeoutError();
      }
      // fetch only throws on network-level failures: the backend is down.
      this.setAvailable(false);
      throw err;
    }
  }

  private async authedJson(
    path: string,
    body: unknown,
    init: RequestInit = {}
  ): Promise<Response> {
    return this.authedFetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      ...init,
    });
  }

  async getHint(req: HintRequest): Promise<HintResponse> {
    const res = await this.authedJson("/hint", req);
    if (res.status === 429) {
      throw rateLimitErrorFrom(res);
    }
    if (res.status === 422) {
      // Version skew, most likely: ask again for the same thing in a mode
      // every backend knows. `withoutNewMode` returns nothing the second time
      // round, so this retries once and never loops.
      const retry = withoutNewMode(req);
      if (retry) {
        const hint = await this.getHint(retry);
        // An old backend answers no `mode` at all; name the one that ran so
        // the panel does not title a Socratic hint "Answer".
        return { ...hint, mode: hint.mode ?? retry.mode };
      }
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Backend error (${res.status}): ${text}`);
    }
    return (await res.json()) as HintResponse;
  }

  /**
   * Ask the backend to design a desk-check exercise for a snippet. Returns
   * steps: 0 when there is nothing worth tracing or the backend is unhappy —
   * callers fall back to a free-text prediction rather than showing an error.
   *
   * Deliberately sends no `code`. The handler reads `req.code` only as a
   * fallback for an empty `selection`, and `design_trace_table` never sees it
   * either way; the caller bails before asking when it has nothing to trace,
   * so that fallback is unreachable from this client. The block this used to
   * carry was uploaded and discarded on every trace — and being a plain string
   * rather than a digest, it was the one payload `buildDigest` never bounded.
   * The field stays on `TraceRequest` for the published 1.5.1 build, which
   * does send a whole file there.
   */
  async getTrace(selection: string, language = "python"): Promise<TraceResponse> {
    const empty: TraceResponse = { variables: [], steps: 0, prompt: "" };
    try {
      const res = await this.authedJson("/trace", { selection, language });
      if (!res.ok) return empty;
      return (await res.json()) as TraceResponse;
    } catch {
      return empty;
    }
  }

  /**
   * Streaming variant of getHint. Calls onEvent for meta/delta events and
   * resolves with the final hint. Throws when streaming is unavailable so the
   * caller can fall back to getHint.
   */
  async streamHint(
    req: HintRequest,
    onEvent: (event: SseEvent) => void,
    signal?: AbortSignal
  ): Promise<HintResponse> {
    // The overall stream has no deadline (a long hint is legitimate), but the
    // request that opens it does, and so does each gap between chunks.
    const res = await this.authedJson("/hint/stream", req, { signal });
    if (res.status === 429) {
      // Not a stream failure — falling back to /hint would just burn the same
      // exhausted budget, so surface it and let the caller show the message.
      throw rateLimitErrorFrom(res);
    }
    if (res.status === 422) {
      // A mode this backend has never heard of. Retried once as a plain hint
      // so the student gets taught something instead of reading validation
      // JSON; `withoutNewMode` gives nothing back on the retry, so it stops.
      const retry = withoutNewMode(req);
      if (retry) {
        const hint = await this.streamHint(retry, onEvent, signal);
        return { ...hint, mode: hint.mode ?? retry.mode };
      }
    }
    if (!res.ok || !res.body) {
      throw new Error(`stream failed (${res.status})`);
    }
    const reader = (res.body as any).getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let level = req.hint_level ?? 1;
    // The mode the backend reports running, which is not always `req.mode`.
    // Left undefined when the meta event carries none, so the caller can tell
    // "an older backend said nothing" from "it ran what I asked for".
    let mode: string | undefined;
    let done: SseEvent | undefined;
    try {
      while (true) {
        const { value, done: eof } = await withIdleDeadline<{
          value?: Uint8Array;
          done?: boolean;
        }>(reader.read(), STREAM_IDLE_TIMEOUT_MS);
        if (eof) break;
        const parsed = parseSseChunk(buffer, decoder.decode(value, { stream: true }));
        buffer = parsed.rest;
        for (const event of parsed.events) {
          if (event.type === "error") {
            throw new Error(String(event.message ?? "stream error"));
          }
          if (event.type === "meta") {
            level = Number(event.hint_level ?? level);
            if (typeof event.mode === "string") mode = event.mode;
          }
          if (event.type === "done") {
            done = event;
          }
          onEvent(event);
        }
      }
    } finally {
      // Releasing the body matters on every exit path, not just the happy one:
      // throwing on an `error` event used to leave the socket open.
      try {
        await reader.cancel();
      } catch {
        /* the stream is already gone */
      }
    }
    if (!done) {
      throw new Error("stream ended without a done event");
    }
    return {
      hint: String(done.hint ?? ""),
      hint_level: level,
      concept_tags: (done.concept_tags as string[]) ?? [],
      mode,
    };
  }

  /** Resets the session; resolves to the "what you learned" summary ("" if none).
   * Throws on network failure so callers can queue the reset for later. */
  async resetSession(): Promise<string> {
    const res = await this.authedFetch("/reset", { method: "POST" });
    if (!res.ok) return "";
    const data = (await res.json()) as { summary?: string };
    return data.summary ?? "";
  }

  async getProgress(): Promise<ProgressReport> {
    const res = await this.authedFetch("/progress");
    if (!res.ok) {
      throw new Error(`progress failed (${res.status})`);
    }
    return (await res.json()) as ProgressReport;
  }

  async getReview(language = "python", exercise = true): Promise<ReviewResponse> {
    try {
      const params = new URLSearchParams({ language, exercise: String(exercise) });
      const res = await this.authedFetch(`/review?${params}`);
      if (!res.ok) return { due: false, concepts: [], exercise: "" };
      return (await res.json()) as ReviewResponse;
    } catch {
      return { due: false, concepts: [], exercise: "" };
    }
  }

  async setGoal(text: string, language = "python"): Promise<string[]> {
    const res = await this.authedJson("/goal", { text, language });
    if (!res.ok) {
      throw new Error(`goal failed (${res.status})`);
    }
    const data = (await res.json()) as { concepts?: string[] };
    return data.concepts ?? [];
  }

  async scanCode(
    digest: CodeDigest,
    language = "python",
    focus?: FocusRange
  ): Promise<ScanResponse> {
    const res = await this.authedJson("/scan", {
      ...digestFields(digest),
      language,
      ...(focus ? { focus } : {}),
    });
    if (res.status === 429) {
      throw rateLimitErrorFrom(res);
    }
    if (!res.ok) {
      throw new Error(`scan failed (${res.status})`);
    }
    return (await res.json()) as ScanResponse;
  }

  async getLineHint(
    digest: CodeDigest,
    line: number,
    language = "python",
    focus?: FocusRange
  ): Promise<LineHintResponse> {
    const res = await this.authedJson("/line-hint", {
      ...digestFields(digest),
      line,
      language,
      ...(focus ? { focus } : {}),
    });
    if (res.status === 429) {
      throw rateLimitErrorFrom(res);
    }
    if (!res.ok) {
      throw new Error(`line-hint failed (${res.status})`);
    }
    return (await res.json()) as LineHintResponse;
  }

  async getBadges(): Promise<string[]> {
    try {
      const res = await this.authedFetch("/badges");
      if (!res.ok) {
        return [];
      }
      return (await res.json()) as string[];
    } catch {
      return [];
    }
  }
}
