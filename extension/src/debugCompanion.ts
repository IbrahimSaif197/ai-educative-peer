import * as vscode from "vscode";
import { formatExceptionQuestion } from "./pedagogy";

/**
 * Watches debug sessions and, when the program stops on an exception, offers
 * to talk the paused state through with EduPeer (explain-error mode).
 */
export function registerDebugCompanion(
  context: vscode.ExtensionContext,
  ask: (question: string) => Promise<void>
): void {
  const offeredSessions = new Set<string>();
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterTrackerFactory("*", {
      createDebugAdapterTracker(session) {
        return {
          onDidSendMessage(message: any) {
            if (
              message?.type === "event" &&
              message.event === "stopped" &&
              message.body?.reason === "exception" &&
              !offeredSessions.has(session.id)
            ) {
              offeredSessions.add(session.id);
              void offerExceptionHelp(session, message.body.threadId, ask);
            }
          },
        };
      },
    })
  );
}

async function offerExceptionHelp(
  session: vscode.DebugSession,
  threadId: number,
  ask: (question: string) => Promise<void>
): Promise<void> {
  const choice = await vscode.window.showInformationMessage(
    "EduPeer: your program stopped on an exception. Want to talk it through?",
    "Talk it through",
    "Not now"
  );
  if (choice !== "Talk it through") return;
  try {
    let description = "an exception";
    try {
      const info = await session.customRequest("exceptionInfo", { threadId });
      description = info?.description || info?.exceptionId || description;
    } catch {
      /* not every debug adapter supports exceptionInfo */
    }

    const stack = await session.customRequest("stackTrace", { threadId, levels: 1 });
    const frame = stack?.stackFrames?.[0];

    let variables: Array<{ name: string; value: string }> = [];
    if (frame) {
      try {
        const scopes = await session.customRequest("scopes", { frameId: frame.id });
        const scope = scopes?.scopes?.[0];
        if (scope) {
          const vars = await session.customRequest("variables", {
            variablesReference: scope.variablesReference,
          });
          variables = (vars?.variables ?? []).map((v: any) => ({
            name: String(v.name),
            value: String(v.value),
          }));
        }
      } catch {
        /* variables are a nice-to-have */
      }
    }

    const location = frame ? `${frame.source?.name ?? "?"}:${frame.line}` : "unknown location";
    await ask(
      formatExceptionQuestion(description, frame?.name ?? "your code", location, variables)
    );
  } catch (err) {
    void vscode.window.showWarningMessage(
      `EduPeer: could not inspect the exception (${err}).`
    );
  }
}
