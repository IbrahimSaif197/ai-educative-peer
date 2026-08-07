export interface ChatTurn {
  role: "student" | "tutor";
  content: string;
}

export interface TokenProvider {
  getIdToken(force?: boolean): Promise<string>;
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

export interface HintResponse {
  hint: string;
  hint_level: number;
  concept_tags: string[];
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

export class ApiClient {
  private available = true;
  private readonly availabilityListeners: Array<(up: boolean) => void> = [];

  constructor(private baseUrl: string, private readonly tokens: TokenProvider) {}

  setBaseUrl(url: string) {
    this.baseUrl = url.replace(/\/$/, "");
  }

  get isAvailable(): boolean {
    return this.available;
  }

  onAvailabilityChange(listener: (up: boolean) => void): void {
    this.availabilityListeners.push(listener);
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
    const attempt = async (force: boolean) => {
      const token = await this.tokens.getIdToken(force);
      return fetch(`${this.baseUrl}${path}`, {
        ...rest,
        signal: signal ?? timeoutSignal(REQUEST_TIMEOUT_MS),
        headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${token}` },
      });
    };
    try {
      let res = await attempt(false);
      if (res.status === 401) {
        res = await attempt(true);
      }
      this.setAvailable(true);
      return res;
    } catch (err) {
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
   */
  async getTrace(code: string, selection: string, language = "python"): Promise<TraceResponse> {
    const empty: TraceResponse = { variables: [], steps: 0, prompt: "" };
    try {
      const res = await this.authedJson("/trace", { code, selection, language });
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
    if (!res.ok || !res.body) {
      throw new Error(`stream failed (${res.status})`);
    }
    const reader = (res.body as any).getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let level = req.hint_level ?? 1;
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

  async scanCode(code: string, language = "python"): Promise<ScanResponse> {
    const res = await this.authedJson("/scan", { code, language });
    if (res.status === 429) {
      throw rateLimitErrorFrom(res);
    }
    if (!res.ok) {
      throw new Error(`scan failed (${res.status})`);
    }
    return (await res.json()) as ScanResponse;
  }

  async getLineHint(code: string, line: number, language = "python"): Promise<LineHintResponse> {
    const res = await this.authedJson("/line-hint", { code, line, language });
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
