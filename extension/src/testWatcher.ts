import * as vscode from "vscode";
import { formatTestFailureQuestion } from "./pedagogy";

const OFFER_COOLDOWN_MS = 30_000;
const MAX_BUFFER_CHARS = 8_000;
const TAIL_LINES = 40;

export const TEST_COMMAND_RE =
  /\b(pytest|jest|vitest|mocha|unittest|npm (run )?test|yarn test|pnpm test|go test|cargo test|dotnet test|mvn test|gradle(w)? test)\b/;

/** Keep only the last `maxChars` of accumulated terminal output. */
export function appendBounded(buffer: string, chunk: string, maxChars = MAX_BUFFER_CHARS): string {
  const combined = buffer + chunk;
  return combined.length > maxChars ? combined.slice(combined.length - maxChars) : combined;
}

/** The last few lines of test output, where the failure summary lives. */
export function failureTail(output: string, lines = TAIL_LINES): string {
  const all = output.split(/\r?\n/).filter((l) => l.trim());
  return all.slice(-lines).join("\n");
}

/**
 * Watches terminal test runs via the shell-integration API (VS Code 1.93+,
 * feature-detected so older hosts just no-op). When a test command exits
 * non-zero, offers to talk through the failure with EduPeer.
 */
export function registerTestWatcher(
  context: vscode.ExtensionContext,
  ask: (question: string) => Promise<void>
): void {
  const win = vscode.window as any;
  if (!win.onDidStartTerminalShellExecution || !win.onDidEndTerminalShellExecution) {
    return;
  }

  const buffers = new Map<object, { commandLine: string; output: string }>();
  let lastOffered = 0;

  context.subscriptions.push(
    win.onDidStartTerminalShellExecution(async (event: any) => {
      const commandLine: string = event.execution?.commandLine?.value ?? "";
      if (!TEST_COMMAND_RE.test(commandLine)) return;
      const entry = { commandLine, output: "" };
      buffers.set(event.execution, entry);
      try {
        const stream = event.execution.read();
        for await (const chunk of stream) {
          entry.output = appendBounded(entry.output, String(chunk));
        }
      } catch {
        /* stream reading is best-effort */
      }
    })
  );

  context.subscriptions.push(
    win.onDidEndTerminalShellExecution((event: any) => {
      const entry = buffers.get(event.execution);
      buffers.delete(event.execution);
      if (!entry || event.exitCode === 0 || event.exitCode === undefined) return;
      const now = Date.now();
      if (now - lastOffered < OFFER_COOLDOWN_MS) return;
      lastOffered = now;
      void vscode.window
        .showInformationMessage(
          "EduPeer: that test run failed. Want to talk through why?",
          "Talk it through",
          "Not now"
        )
        .then((choice) => {
          if (choice === "Talk it through") {
            const tail = failureTail(entry.output) || "(no captured output)";
            void ask(formatTestFailureQuestion(entry.commandLine, tail));
          }
        });
    })
  );
}
