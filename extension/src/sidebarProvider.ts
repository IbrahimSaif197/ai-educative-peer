import * as vscode from "vscode";
import { ApiClient } from "./apiClient";
import { FirebaseClient } from "./firebaseClient";

const USER_ID_KEY = "edupeer.userId";

function randomUserId(): string {
  return (
    "user-" +
    Math.random().toString(36).slice(2, 10) +
    Date.now().toString(36)
  );
}

export class EduPeerSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "edupeer.sidebar";

  private view?: vscode.WebviewView;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly context: vscode.ExtensionContext,
    private readonly api: ApiClient,
    private readonly firebase: FirebaseClient
  ) {}

  public getUserId(): string {
    let id = this.context.globalState.get<string>(USER_ID_KEY);
    if (!id) {
      id = randomUserId();
      this.context.globalState.update(USER_ID_KEY, id);
    }
    return id;
  }

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case "ready":
          await this.sendActiveCode();
          await this.sendBadges();
          return;
        case "askHint":
          await this.handleAsk(msg.question as string, msg.code as string);
          return;
        case "reset":
          await this.resetSession();
          return;
        case "refreshCode":
          await this.sendActiveCode();
          return;
      }
    });

    vscode.window.onDidChangeActiveTextEditor(() => this.sendActiveCode());
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (
        vscode.window.activeTextEditor &&
        e.document === vscode.window.activeTextEditor.document
      ) {
        this.sendActiveCode();
      }
    });
  }

  public reveal() {
    this.view?.show?.(true);
  }

  public async askExternal(question: string, code: string) {
    this.reveal();
    this.post({ type: "externalAsk", question, code });
    await this.handleAsk(question, code);
  }

  public async resetSession() {
    const userId = this.getUserId();
    try {
      await this.api.resetSession(userId);
    } catch (err) {
      console.error("reset failed", err);
    }
    this.post({ type: "resetDone" });
  }

  private async handleAsk(question: string, code: string) {
    if (!question || !question.trim()) {
      return;
    }
    const userId = this.getUserId();
    this.post({ type: "userMessage", text: question });
    this.post({ type: "loading", value: true });
    try {
      const res = await this.api.getHint({
        code: code ?? "",
        question,
        user_id: userId,
        hint_level: 1,
      });
      this.post({
        type: "hint",
        hint: res.hint,
        hint_level: res.hint_level,
        concept_tags: res.concept_tags,
      });
      await this.sendBadges();
    } catch (err: any) {
      this.post({ type: "error", message: err?.message ?? String(err) });
    } finally {
      this.post({ type: "loading", value: false });
    }
  }

  private async sendActiveCode() {
    const editor = vscode.window.activeTextEditor;
    const code = editor?.document?.getText() ?? "";
    const fileName = editor?.document?.fileName ?? "";
    this.post({ type: "activeCode", code, fileName });
  }

  private async sendBadges() {
    const userId = this.getUserId();
    const badges = await this.firebase.getBadges(userId);
    this.post({ type: "badges", badges });
  }

  private post(msg: any) {
    this.view?.webview.postMessage(msg);
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "main.js")
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "style.css")
    );
    const nonce = getNonce();
    const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>EduPeer</title>
</head>
<body>
  <header class="header">
    <h2>EduPeer</h2>
    <div class="badges" id="badges"></div>
  </header>
  <section class="code-preview">
    <div class="code-header">
      <span id="fileName">No active file</span>
      <button id="refreshCode" class="small-btn">Refresh</button>
    </div>
    <pre id="codeSnippet" class="code"></pre>
  </section>
  <section class="chat" id="chat"></section>
  <div class="loading hidden" id="loading">
    <div class="spinner"></div>
    <span>EduPeer is thinking...</span>
  </div>
  <footer class="composer">
    <textarea id="input" placeholder="Describe your error or ask a question..." rows="3"></textarea>
    <div class="actions">
      <button id="send" class="primary">Ask</button>
      <button id="reset" class="secondary">Reset Session</button>
    </div>
  </footer>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = "";
  const possible =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
