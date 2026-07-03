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
  language?: string;
  mode?: string;
  history?: ChatTurn[];
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
}

export interface ReviewResponse {
  due: boolean;
  concepts: string[];
  exercise: string;
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
      const res = await fetch(`${this.baseUrl}/health`, { method: "GET" });
      this.setAvailable(res.ok);
      return res.ok;
    } catch {
      this.setAvailable(false);
      return false;
    }
  }

  /** Fetch with a Bearer token; on 401, refresh the token once and retry. */
  private async authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const attempt = async (force: boolean) => {
      const token = await this.tokens.getIdToken(force);
      return fetch(`${this.baseUrl}${path}`, {
        ...init,
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
      // fetch only throws on network-level failures: the backend is down.
      this.setAvailable(false);
      throw err;
    }
  }

  private async authedJson(path: string, body: unknown): Promise<Response> {
    return this.authedFetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async getHint(req: HintRequest): Promise<HintResponse> {
    const res = await this.authedJson("/hint", req);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Backend error (${res.status}): ${text}`);
    }
    return (await res.json()) as HintResponse;
  }

  /**
   * Streaming variant of getHint. Calls onEvent for meta/delta events and
   * resolves with the final hint. Throws when streaming is unavailable so the
   * caller can fall back to getHint.
   */
  async streamHint(
    req: HintRequest,
    onEvent: (event: SseEvent) => void
  ): Promise<HintResponse> {
    const res = await this.authedJson("/hint/stream", req);
    if (!res.ok || !res.body) {
      throw new Error(`stream failed (${res.status})`);
    }
    const reader = (res.body as any).getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let level = req.hint_level ?? 1;
    let done: SseEvent | undefined;
    while (true) {
      const { value, done: eof } = await reader.read();
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
    if (!res.ok) {
      throw new Error(`scan failed (${res.status})`);
    }
    return (await res.json()) as ScanResponse;
  }

  async getLineHint(code: string, line: number, language = "python"): Promise<LineHintResponse> {
    const res = await this.authedJson("/line-hint", { code, line, language });
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
