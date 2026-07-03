import * as vscode from "vscode";
import { ApiClient } from "./apiClient";
import { AuthManager } from "./authManager";
import { signInViaBrowser } from "./signInFlow";
import { FirebaseClient } from "./firebaseClient";
import { EduPeerSidebarProvider } from "./sidebarProvider";
import { InlineTutor } from "./inlineTutor";
import { registerDebugCompanion } from "./debugCompanion";
import { registerTestWatcher } from "./testWatcher";
import { TutorMode, frameConstructExplanation } from "./pedagogy";

export async function activate(context: vscode.ExtensionContext) {
  const config = vscode.workspace.getConfiguration("edupeer");
  const backendUrl = config.get<string>("backendUrl", "http://localhost:8000");

  const auth = new AuthManager(context.secrets, context.globalState, backendUrl);
  await auth.initialize();
  const api = new ApiClient(backendUrl, auth);
  const firebase = new FirebaseClient(api);
  const provider = new EduPeerSidebarProvider(context.extensionUri, context, api, firebase, auth);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(EduPeerSidebarProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  const tutor = new InlineTutor(context, api);
  tutor.activate();
  context.subscriptions.push({ dispose: () => tutor.dispose() });

  // Retry any migration that failed on a previous run.
  void auth.runPendingMigration();

  // Health check
  const healthy = await api.health();
  if (!healthy) {
    vscode.window.showWarningMessage(
      `EduPeer backend is not reachable at ${backendUrl}. Start it with: cd backend && uvicorn main:app --reload`
    );
  }

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
    vscode.commands.registerCommand("edupeer.resetSession", async () => {
      await provider.resetSession();
      vscode.window.showInformationMessage("EduPeer: session reset.");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("edupeer.signIn", async () => {
      try {
        const payload = await signInViaBrowser(
          vscode.workspace.getConfiguration("edupeer").get<string>("backendUrl", "http://localhost:8000")
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
          .get<string>("backendUrl", "http://localhost:8000");
        api.setBaseUrl(url);
        auth.setBaseUrl(url);
      }
    })
  );
}

export function deactivate() {}
