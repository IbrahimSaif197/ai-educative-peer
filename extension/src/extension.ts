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
import { focusText, resolveFocus } from "./focusScope";

const HEALTH_RETRY_MS = 30_000;

// Only used if the setting is missing entirely; package.json declares the same
// value as the contributed default. Keep the two in step.
const DEFAULT_BACKEND_URL = "https://edupeer-backend.onrender.com";

/**
 * The block around a position, ignoring any selection.
 *
 * `resolveFocus` ranks a selection above the enclosing symbol, which is right
 * when the selection *is* the question. Here it is the answer's subject and
 * the block around it is the context, so the selection must not win.
 *
 * Deliberately not `digestFor`, and not to be "unified" with it. This is the
 * block's own verbatim text, because a digest's elided bands would give the
 * model a desk-check exercise with holes in it. The seeded `bug:` markers are
 * left in for the same reason — a trace of code the student can see must be a
 * trace of the code they can see. Everything that asks for a *hint* about a
 * file goes through `digestFor`; this does not.
 *
 * Every route out of here is bounded. `/predict`, `discussLines`, the debug
 * companion and the trace follow-up all reach the wire through `handleAsk`,
 * which digests whatever it is handed, so they cap at `MAX_DIGEST_LINES`.
 * `traceCode` no longer draws its snippet from this at all — it requires a
 * selection — so the one payload a digest cannot bound is now something the
 * student chose by selecting it, never something a resting cursor implied.
 */
async function blockAround(
  doc: vscode.TextDocument,
  at: vscode.Position
): Promise<string> {
  return focusText(doc, await resolveFocus(doc, new vscode.Selection(at, at)));
}

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
      provider.postStreak(progress.streak_days);
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
  context.subscriptions.push(tutor.onDidScanClean(() => provider.postScanClean()));

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
    // The block around the cursor, not the file: `askExternal` calls
    // `sendFocus` before asking anything, which re-resolves its own digest
    // from the live focus regardless of what `code` carries here — this only
    // ever backs the local offline-tutor fallback (the webview's
    // `externalAsk` handler in media/main.js ignores `code` outright, so
    // there is no display use to preserve either), but it has no business
    // holding the whole document on the way there.
    const code = editor ? await blockAround(editor.document, editor.selection.active) : "";
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
      provider.startPrediction(
        snippet,
        await blockAround(editor!.document, editor!.selection.active)
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("edupeer.traceCode", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showInformationMessage("EduPeer: open a file first.");
        return;
      }
      // A trace needs a selection, and this is the one command that insists.
      //
      // The snippet is the exercise, so it travels whole — a desk-check over a
      // digest's elided bands would have holes in it. That makes this the only
      // payload `buildDigest` cannot bound, and it used to fill itself from the
      // enclosing block when nothing was selected: a cursor resting at class
      // level in a long class sent the class. Requiring a selection puts that
      // bound in the student's hand instead. Nothing leaves for a trace they
      // did not ask for by selecting it.
      //
      // `isEmpty` rather than trimming `getText(selection)`: an empty range is
      // the question being asked here, and reading it off the selection says so
      // directly instead of inferring it from the text a range happens to span.
      const snippet = editor.selection.isEmpty
        ? ""
        : editor.document.getText(editor.selection).trim();
      if (!snippet) {
        vscode.window.showInformationMessage(
          "EduPeer: select the code you want to trace."
        );
        return;
      }
      // Context for the follow-up ask, which digests it — so unlike the
      // snippet, this one is capped.
      const block = await blockAround(editor.document, editor.selection.active);
      await vscode.commands.executeCommand("workbench.view.extension.edupeer-sidebar");
      await provider.startTrace(snippet, block);
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
          await blockAround(doc, new vscode.Position(first, 0))
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
            ? // The tags are worth naming because they now do something: they
              // lead the spaced review and they tell the tutor which honest
              // framing of your code to prefer. Before 1.7.0 this line was the
              // only place they were ever used.
              `EduPeer: goal set.${
                concepts.length
                  ? ` Hints will lean towards ${concepts.join(", ")} where your code touches them.`
                  : ""
              }`
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
