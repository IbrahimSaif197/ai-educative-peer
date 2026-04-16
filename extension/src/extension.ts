import * as vscode from "vscode";
import { ApiClient } from "./apiClient";
import { FirebaseClient } from "./firebaseClient";
import { EduPeerSidebarProvider } from "./sidebarProvider";

export async function activate(context: vscode.ExtensionContext) {
  const config = vscode.workspace.getConfiguration("edupeer");
  const backendUrl = config.get<string>("backendUrl", "http://localhost:8000");

  const api = new ApiClient(backendUrl);
  const firebase = new FirebaseClient(api);
  const provider = new EduPeerSidebarProvider(context.extensionUri, context, api, firebase);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(EduPeerSidebarProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  // Ensure user id persists.
  provider.getUserId();

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

  context.subscriptions.push(
    vscode.commands.registerCommand("edupeer.resetSession", async () => {
      await provider.resetSession();
      vscode.window.showInformationMessage("EduPeer: session reset.");
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("edupeer.backendUrl")) {
        const url = vscode.workspace
          .getConfiguration("edupeer")
          .get<string>("backendUrl", "http://localhost:8000");
        api.setBaseUrl(url);
      }
    })
  );
}

export function deactivate() {}
