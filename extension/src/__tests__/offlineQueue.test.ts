import { OfflineQueue, QueueStorage } from "../offlineQueue";

function makeStorage(): QueueStorage {
  const store = new Map<string, unknown>();
  return {
    get: <T>(key: string, def: T) => (store.has(key) ? (store.get(key) as T) : def),
    update: async (key: string, value: unknown) => {
      store.set(key, value);
    },
  };
}

function makeApi(overrides: Partial<{ reset: jest.Mock; goal: jest.Mock }> = {}) {
  const reset = overrides.reset ?? jest.fn(async () => "");
  const goal = overrides.goal ?? jest.fn(async () => []);
  return { api: { resetSession: reset, setGoal: goal }, reset, goal };
}

describe("OfflineQueue", () => {
  it("enqueues and flushes a reset", async () => {
    const queue = new OfflineQueue(makeStorage());
    await queue.enqueue({ kind: "reset" });
    const { api, reset } = makeApi();
    expect(await queue.flush(api)).toBe(1);
    expect(reset).toHaveBeenCalled();
    expect(queue.items()).toEqual([]);
  });

  it("newer goal replaces older queued goal", async () => {
    const queue = new OfflineQueue(makeStorage());
    await queue.enqueue({ kind: "goal", text: "old" });
    await queue.enqueue({ kind: "goal", text: "new" });
    expect(queue.items()).toHaveLength(1);
    expect(queue.items()[0].text).toBe("new");
  });

  it("failed items stay queued", async () => {
    const queue = new OfflineQueue(makeStorage());
    await queue.enqueue({ kind: "goal", text: "g" });
    await queue.enqueue({ kind: "reset" });
    const { api } = makeApi({
      goal: jest.fn(async () => {
        throw new Error("still down");
      }),
    });
    expect(await queue.flush(api)).toBe(1);
    expect(queue.items()).toEqual([{ kind: "goal", text: "g" }]);
  });

  it("flush with empty queue is a no-op", async () => {
    const queue = new OfflineQueue(makeStorage());
    const { api, reset } = makeApi();
    expect(await queue.flush(api)).toBe(0);
    expect(reset).not.toHaveBeenCalled();
  });
});
