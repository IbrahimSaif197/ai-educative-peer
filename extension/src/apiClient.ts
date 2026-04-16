export interface HintRequest {
  code: string;
  question: string;
  user_id: string;
  hint_level: number;
}

export interface HintResponse {
  hint: string;
  hint_level: number;
  concept_tags: string[];
}

export class ApiClient {
  constructor(private baseUrl: string) {}

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

  async getHint(req: HintRequest): Promise<HintResponse> {
    const res = await fetch(`${this.baseUrl}/hint`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Backend error (${res.status}): ${text}`);
    }
    return (await res.json()) as HintResponse;
  }

  async resetSession(userId: string): Promise<void> {
    await fetch(`${this.baseUrl}/reset`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId }),
    });
  }

  async getBadges(userId: string): Promise<string[]> {
    try {
      const res = await fetch(`${this.baseUrl}/badges/${encodeURIComponent(userId)}`);
      if (!res.ok) {
        return [];
      }
      return (await res.json()) as string[];
    } catch {
      return [];
    }
  }
}
