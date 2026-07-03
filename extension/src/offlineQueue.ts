/**
 * Persists mutations attempted while the backend is unreachable and replays
 * them when it comes back. Only idempotent-ish mutations are queued (reset,
 * goal); hints are interactive and cannot be deferred.
 */

export interface QueueItem {
  kind: "reset" | "goal";
  text?: string;
  language?: string;
}

export interface QueueStorage {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

export interface QueueApi {
  resetSession(): Promise<string>;
  setGoal(text: string, language?: string): Promise<string[]>;
}

const STORAGE_KEY = "edupeer.offlineQueue";

export class OfflineQueue {
  constructor(private readonly storage: QueueStorage) {}

  items(): QueueItem[] {
    return this.storage.get<QueueItem[]>(STORAGE_KEY, []);
  }

  /** Queue an item; a newer item of the same kind replaces the older one. */
  async enqueue(item: QueueItem): Promise<void> {
    const items = this.items().filter((i) => i.kind !== item.kind);
    items.push(item);
    await this.storage.update(STORAGE_KEY, items);
  }

  /** Replay queued items; failures stay queued. Returns how many flushed. */
  async flush(api: QueueApi): Promise<number> {
    const items = this.items();
    if (!items.length) return 0;
    const remaining: QueueItem[] = [];
    let flushed = 0;
    for (const item of items) {
      try {
        if (item.kind === "reset") {
          await api.resetSession();
        } else {
          await api.setGoal(item.text ?? "", item.language);
        }
        flushed++;
      } catch {
        remaining.push(item);
      }
    }
    await this.storage.update(STORAGE_KEY, remaining);
    return flushed;
  }
}
