import * as vscode from "vscode";
import { registerDebugCompanion } from "../debugCompanion";

const mock = vscode as any;

function makeContext() {
  return { subscriptions: [] as any[] } as any;
}

/** Build a tracker the way VS Code would, for a given session id. */
function trackerFor(sessionId: string) {
  const factory = mock.__state.debugTrackerFactories[0].factory;
  return factory.createDebugAdapterTracker({ id: sessionId } as any);
}

function stoppedOnException(threadId = 1) {
  return {
    type: "event",
    event: "stopped",
    body: { reason: "exception", threadId },
  };
}

function makeSession(overrides: Record<string, any> = {}) {
  return {
    id: "session-1",
    customRequest: jest.fn(async (command: string) => {
      if (command === "exceptionInfo") {
        return { description: "ZeroDivisionError: division by zero" };
      }
      if (command === "stackTrace") {
        return {
          stackFrames: [{ id: 7, name: "divide", line: 12, source: { name: "demo.py" } }],
        };
      }
      if (command === "scopes") {
        return { scopes: [{ variablesReference: 99 }] };
      }
      if (command === "variables") {
        return { variables: [{ name: "b", value: "0" }] };
      }
      return {};
    }),
    ...overrides,
  };
}

describe("registerDebugCompanion", () => {
  beforeEach(() => mock.__reset());

  it("registers a tracker factory for every debug type", () => {
    registerDebugCompanion(makeContext(), jest.fn());
    expect(vscode.debug.registerDebugAdapterTrackerFactory).toHaveBeenCalledTimes(1);
    expect(mock.__state.debugTrackerFactories[0].selector).toBe("*");
  });

  it("adds the tracker to the context subscriptions", () => {
    const context = makeContext();
    registerDebugCompanion(context, jest.fn());
    expect(context.subscriptions).toHaveLength(1);
  });

  it("offers help when the program stops on an exception", async () => {
    registerDebugCompanion(makeContext(), jest.fn());
    trackerFor("s1").onDidSendMessage(stoppedOnException());
    await Promise.resolve();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining("stopped on an exception"),
      "Talk it through",
      "Not now"
    );
  });

  it("ignores a stop for any other reason", async () => {
    registerDebugCompanion(makeContext(), jest.fn());
    trackerFor("s1").onDidSendMessage({
      type: "event",
      event: "stopped",
      body: { reason: "breakpoint", threadId: 1 },
    });
    await Promise.resolve();
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it("ignores non-stopped events", async () => {
    registerDebugCompanion(makeContext(), jest.fn());
    trackerFor("s1").onDidSendMessage({ type: "event", event: "output", body: {} });
    await Promise.resolve();
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it("ignores a malformed message without throwing", async () => {
    registerDebugCompanion(makeContext(), jest.fn());
    expect(() => trackerFor("s1").onDidSendMessage(undefined)).not.toThrow();
    expect(() => trackerFor("s1").onDidSendMessage({ type: "event" })).not.toThrow();
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it("offers only once per debug session", async () => {
    registerDebugCompanion(makeContext(), jest.fn());
    const tracker = trackerFor("s1");
    tracker.onDidSendMessage(stoppedOnException());
    tracker.onDidSendMessage(stoppedOnException());
    await Promise.resolve();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledTimes(1);
  });

  it("offers again for a different session", async () => {
    registerDebugCompanion(makeContext(), jest.fn());
    trackerFor("s1").onDidSendMessage(stoppedOnException());
    trackerFor("s2").onDidSendMessage(stoppedOnException());
    await Promise.resolve();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledTimes(2);
  });
});

describe("accepting the offer", () => {
  beforeEach(() => mock.__reset());

  /** Drive the whole flow with a session and a queued answer. */
  async function run(answer: string | undefined, session = makeSession()) {
    const ask = jest.fn(async (_question: string) => undefined);
    mock.__state.infoMessageAnswers.push(answer);
    registerDebugCompanion(makeContext(), ask);
    const factory = mock.__state.debugTrackerFactories[0].factory;
    factory.createDebugAdapterTracker(session).onDidSendMessage(stoppedOnException());
    // Let the offer promise and every customRequest settle.
    for (let i = 0; i < 12; i++) await Promise.resolve();
    return ask;
  }

  it("asks nothing when the student declines", async () => {
    const ask = await run("Not now");
    expect(ask).not.toHaveBeenCalled();
  });

  it("asks nothing when the notification is dismissed", async () => {
    const ask = await run(undefined);
    expect(ask).not.toHaveBeenCalled();
  });

  it("builds the question from the exception, frame and variables", async () => {
    const ask = await run("Talk it through");
    expect(ask).toHaveBeenCalledTimes(1);
    const question = ask.mock.calls[0][0];
    expect(question).toContain("ZeroDivisionError: division by zero");
    expect(question).toContain("divide");
    expect(question).toContain("demo.py:12");
    expect(question).toContain("b = 0");
  });

  it("still asks when exceptionInfo is unsupported", async () => {
    const session = makeSession({
      customRequest: jest.fn(async (command: string) => {
        if (command === "exceptionInfo") throw new Error("unsupported");
        if (command === "stackTrace") {
          return { stackFrames: [{ id: 1, name: "main", line: 3, source: { name: "a.py" } }] };
        }
        return {};
      }),
    });
    const ask = await run("Talk it through", session);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0][0]).toContain("an exception");
  });

  it("still asks when variables cannot be read", async () => {
    const session = makeSession({
      customRequest: jest.fn(async (command: string) => {
        if (command === "exceptionInfo") return { description: "Boom" };
        if (command === "stackTrace") {
          return { stackFrames: [{ id: 1, name: "main", line: 3, source: { name: "a.py" } }] };
        }
        if (command === "scopes") throw new Error("no scopes");
        return {};
      }),
    });
    const ask = await run("Talk it through", session);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0][0]).not.toContain("Variables in scope");
  });

  it("reports an unknown location when there is no stack frame", async () => {
    const session = makeSession({
      customRequest: jest.fn(async (command: string) => {
        if (command === "exceptionInfo") return { description: "Boom" };
        if (command === "stackTrace") return { stackFrames: [] };
        return {};
      }),
    });
    const ask = await run("Talk it through", session);
    expect(ask.mock.calls[0][0]).toContain("unknown location");
  });

  it("warns rather than throwing when the stack trace request fails", async () => {
    const session = makeSession({
      customRequest: jest.fn(async (command: string) => {
        if (command === "exceptionInfo") return { description: "Boom" };
        throw new Error("adapter died");
      }),
    });
    const ask = await run("Talk it through", session);
    expect(ask).not.toHaveBeenCalled();
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining("could not inspect the exception")
    );
  });
});
