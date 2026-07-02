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
}

export interface ScanResponse {
  flags: LineFlag[];
}

export interface LineHintResponse {
  hint: string;
  concept: string;
}

export class ApiClient {
  constructor(private baseUrl: string, private readonly tokens: TokenProvider) {}

  setBaseUrl(url: string) {
    this.baseUrl = url.replace(/\/$/, "");
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, { method: "GET" });
      return res.ok;
    } catch {
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
    let res = await attempt(false);
    if (res.status === 401) {
      res = await attempt(true);
    }
    return res;
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

  async resetSession(): Promise<void> {
    await this.authedFetch("/reset", { method: "POST" });
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
