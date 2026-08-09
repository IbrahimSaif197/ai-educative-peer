import * as vscode from "vscode";
import { ApiClient } from "./apiClient";
import { AuthManager } from "./authManager";
import { deliverUriCallback, signInViaBrowser } from "./signInFlow";
import { FirebaseClient } from "./firebaseClient";
import { EduPeerSidebarProvider } from "./sidebarProvider";
import { InlineTutor } from "./inlineTutor";
import { registerDebugCompanion } from "./debugCompanion";
import { registerTestWatcher } from "./testWatcher";
import { isSupportedLanguage } from "./languages";
import { TutorMode, frameConstructExplanation } from "./pedagogy";
import { buildProgressHtml } from "./progressPanel";
import { OfflineQueue } from "./offlineQueue";
import { StatusBar } from "./statusBar";

const HEALTH_RETRY_MS = 30_000;

// Only used if the setting is missing entirely; package.json declares the same
// value as the contributed default. Keep the two in step.
const DEFAULT_BACKEND_URL = "https://edupeer-backend.onrender.com";

export async function activate(context: vscode.ExtensionContext) {
  const config = vscode.workspace.getConfiguration("edupeer");
  const backendUrl = config.get<string>("backendUrl", DEFAULT_BACKEND_URL);

  const auth = new AuthManager(context.secrets, context.globalState, backendUrl);
  await auth.initialize();
  const api = new ApiClient(backendUrl, auth);
  const firebase = new FirebaseClient(api);
  const queue = new OfflineQueue(context.globalState);
  const provider = new EduPeerSidebarProvider(
    context.extensionUri, context, api, firebase, auth, queue
  );

  const statusBar = new StatusBar(() =>
    isSupportedLanguage(vscode.window.activeTextEditor?.document?.languageId ?? "")
  );
  context.subscriptions.push(statusBar);
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => statusBar.refresh())
  );
  context.subscriptions.push(
    provider.onDidChangeHintLevel((level) => statusBar.update({ hintLevel: level }))
  );

  api.onAvailabilityChange((up) => {
    provider.postOffline(!up);
    statusBar.update({ offline: !up });
    if (up) {
      void queue.flush(api);
      void refreshStatusFromProgress();
    }
  });

  let warnedAuth = false;
  api.onAuthHealthChange((ok) => {
    provider.postAuthTrouble(!ok);
    statusBar.update({ authFailed: !ok });
    if (ok || warnedAuth) return;
    warnedAuth = true;
    // Worth a toast once: unlike an unreachable backend, this never clears on
    // its own — someone has to fix the Firebase config.
    vscode.window.showWarningMessage(
      "EduPeer can't sign in. The backend is reachable but Firebase auth is failing — check FIREBASE_WEB_API_KEY on the backend and that the Anonymous provider is enabled."
    );
  });

  /** Streak and review-due come from the same call the dashboard uses. */
  const refreshStatusFromProgress = async () => {
    try {
      const progress = await api.getProgress();
      statusBar.update({
        streakDays: progress.streak_days,
        reviewDue: progress.review_due,
      });
    } catch {
      /* the status bar is decoration; never surface a failure here */
    }
  };
  const healthTimer = setInterval(() => {
    if (!api.isAvailable) {
      void api.health();
    }
  }, HEALTH_RETRY_MS);
  context.subscriptions.push({ dispose: () => clearInterval(healthTimer) });

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(EduPeerSidebarProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  const tutor = new InlineTutor(context, api, (thinking) => statusBar.update({ thinking }));
  tutor.activate();
  context.subscriptions.push({ dispose: () => tutor.dispose() });

  // Retry any migration that failed on a previous run.
  void auth.runPendingMigration();

  // Health check. Not awaited: activation runs on startup in every window, so
  // blocking here would delay registering the commands below behind a network
  // round trip in windows that have nothing to do with EduPeer.
  let warnedOffline = false;
  const warnIfRelevant = () => {
    // The status bar already hides itself when no tutored file is open
    // (statusBar.ts). The toast used to ignore that and interrupt every VS
    // Code window on startup, including ones with no code in them.
    if (warnedOffline || api.isAvailable) return;
    if (!isSupportedLanguage(vscode.window.activeTextEditor?.document?.languageId ?? "")) {
      return;
    }
    warnedOffline = true;
    vscode.window.showWarningMessage(
      `EduPeer backend is not reachable at ${backendUrl}. Start it with: cd backend && uvicorn main:app --reload`
    );
  };
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => warnIfRelevant())
  );
  void api.health().then((healthy) => {
    if (!healthy) {
      statusBar.update({ offline: true });
      warnIfRelevant();
    } else {
      void refreshStatusFromProgress();
    }
  });

  context.subscriptions.push(
    vscode.commands.registerCommand("edupeer.activate", async () => {
      await vscode.commands.executeCommand("workbench.view.extension.edupeer-sidebar");
      provider.reveal();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("edupeer.analyseSelection", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showInformationMessage("EduPeer: open a file and select code first.");
        return;
      }
      const selection = editor.document.getText(editor.selection);
      if (!selection.trim()) {
        vscode.window.showInformationMessage("EduPeer: no code is selected.");
        return;
      }
      await vscode.commands.executeCommand("workbench.view.extension.edupeer-sidebar");
      await provider.askExternal("What is wrong with this selection?", selection);
    })
  );

  const askWithActiveFile = async (question: string, mode: TutorMode) => {
    const editor = vscode.window.activeTextEditor;
    const code = editor?.document?.getText() ?? "";
    await vscode.commands.executeCommand("workbench.view.extension.edupeer-sidebar");
    await provider.askExternal(question, code, mode);
  };

  registerDebugCompanion(context, (q) => askWithActiveFile(q, "explain-error"));
  registerTestWatcher(context, (q) => askWithActiveFile(q, "hint"));

  context.subscriptions.push(
    vscode.commands.registerCommand("edupeer.reflectQuiz", async () => {
      await askWithActiveFile("", "reflect");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("edupeer.explainError", async () => {
      const editor = vscode.window.activeTextEditor;
      let text = editor ? editor.document.getText(editor.selection) : "";
      if (!text.trim()) {
        text =
          (await vscode.window.showInputBox({
            prompt: "Paste the error message or stack trace",
            placeHolder: "Traceback (most recent call last): ...",
          })) ?? "";
      }
      if (!text.trim()) return;
      await askWithActiveFile(`Help me read this error:\n\n${text}`, "explain-error");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("edupeer.explainSelection", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showInformationMessage("EduPeer: open a file first.");
        return;
      }
      const selection =
        editor.document.getText(editor.selection).trim() ||
        editor.document.lineAt(editor.selection.active.line).text.trim();
      if (!selection) {
        vscode.window.showInformationMessage("EduPeer: select some code first.");
        return;
      }
      await askWithActiveFile(frameConstructExplanation(selection), "explain-concept");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("edupeer.predictOutput", async () => {
      const editor = vscode.window.activeTextEditor;
      const snippet = editor ? editor.document.getText(editor.selection) : "";
      if (!snippet.trim()) {
        vscode.window.showInformationMessage(
          "EduPeer: select the code whose output you want to predict."
        );
        return;
      }
      await vscode.commands.executeCommand("workbench.view.extension.edupeer-sidebar");
      provider.startPrediction(snippet, editor!.document.getText());
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("edupeer.traceCode", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showInformationMessage("EduPeer: open a file first.");
        return;
      }
      const snippet =
        editor.document.getText(editor.selection).trim() || editor.document.getText().trim();
      if (!snippet) {
        vscode.window.showInformationMessage("EduPeer: there's nothing here to trace.");
        return;
      }
      await vscode.commands.executeCommand("workbench.view.extension.edupeer-sidebar");
      await provider.startTrace(snippet, editor.document.getText());
    })
  );

  // Invoked from the Quick Fix on an EduPeer diagnostic: pull the flagged
  // lines into the panel so the student doesn't have to select them by hand.
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "edupeer.discussLines",
      async (uri: vscode.Uri, startLine: number, endLine: number, question?: string) => {
        const doc = await vscode.workspace.openTextDocument(uri);
        const last = Math.max(0, Math.min(doc.lineCount - 1, endLine));
        const first = Math.max(0, Math.min(last, startLine));
        const range = new vscode.Range(first, 0, last, doc.lineAt(last).text.length);
        const snippet = doc.getText(range);
        await vscode.commands.executeCommand("workbench.view.extension.edupeer-sidebar");
        await provider.askExternal(
          question
            ? `About these lines you flagged — "${question}"\n\n${snippet}`
            : `What is wrong with these lines?\n\n${snippet}`,
          doc.getText()
        );
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("edupeer.resetSession", async () => {
      await provider.resetSession();
      vscode.window.showInformationMessage("EduPeer: session reset.");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("edupeer.showProgress", async () => {
      try {
        const progress = await api.getProgress();
        const panel = vscode.window.createWebviewPanel(
          "edupeer.progress",
          "EduPeer Progress",
          vscode.ViewColumn.One,
          {}
        );
        panel.webview.html = buildProgressHtml(progress);
      } catch (err: any) {
        vscode.window.showErrorMessage(
          `EduPeer: could not load progress (${err?.message ?? err}).`
        );
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("edupeer.setGoal", async () => {
      const text = await vscode.window.showInputBox({
        prompt: "What do you want to get better at? (leave empty to clear your goal)",
        placeHolder: "e.g. get comfortable with recursion",
      });
      if (text === undefined) return;
      const language = vscode.window.activeTextEditor?.document?.languageId ?? "python";
      try {
        const concepts = await api.setGoal(text, language);
        vscode.window.showInformationMessage(
          text.trim()
            ? `EduPeer: goal set${concepts.length ? ` (focus: ${concepts.join(", ")})` : ""}.`
            : "EduPeer: goal cleared."
        );
      } catch (err: any) {
        if (!api.isAvailable) {
          await queue.enqueue({ kind: "goal", text, language });
          vscode.window.showInformationMessage(
            "EduPeer: backend unreachable — goal saved locally and will sync later."
          );
        } else {
          vscode.window.showErrorMessage(`EduPeer: could not save goal (${err?.message ?? err}).`);
        }
      }
    })
  );

  // The sign-in page hands tokens back through this rather than POSTing to a
  // loopback server. Chrome and Edge now gate a public page's access to
  // 127.0.0.1 behind a permission prompt that reads like an attack, and a
  // student who declines it cannot sign in at all.
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      handleUri(uri: vscode.Uri) {
        if (uri.path === "/callback") deliverUriCallback(uri.query);
      },
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("edupeer.signIn", async () => {
      try {
        const payload = await signInViaBrowser(
          vscode.workspace.getConfiguration("edupeer").get<string>("backendUrl", DEFAULT_BACKEND_URL),
          undefined,
          { uriScheme: vscode.env.uriScheme, extensionId: context.extension?.id }
        );
        await auth.applySignIn(payload);
        vscode.window.showInformationMessage(
          `EduPeer: signed in as ${payload.displayName || payload.email || payload.uid}`
        );
      } catch (err: any) {
        vscode.window.showErrorMessage(`EduPeer sign-in failed: ${err?.message ?? err}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("edupeer.signOut", async () => {
      await auth.signOut();
      vscode.window.showInformationMessage("EduPeer: signed out.");
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("edupeer.backendUrl")) {
        const url = vscode.workspace
          .getConfiguration("edupeer")
          .get<string>("backendUrl", DEFAULT_BACKEND_URL);
        api.setBaseUrl(url);
        auth.setBaseUrl(url);
      }
    })
  );
}

export function deactivate() {}
