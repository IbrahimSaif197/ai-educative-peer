import * as vscode from "vscode";
import { ApiClient, ChatTurn } from "./apiClient";
import { AuthManager } from "./authManager";
import { FirebaseClient } from "./firebaseClient";
import { isSupportedLanguage, languageLabel } from "./languages";
import {
  EXPLAIN_FIRST_PROMPT,
  TutorMode,
  codeFingerprint,
  frameExplainedQuestion,
  framePrediction,
  looksLikeErrorText,
  questionForMode,
} from "./pedagogy";
import { OfflineQueue } from "./offlineQueue";

// How many prior turns are sent with each question (the backend caps
// again on its side).
const MAX_HISTORY_TURNS = 6;

export class EduPeerSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "edupeer.sidebar";

  private view?: vscode.WebviewView;
  private history: ChatTurn[] = [];
  private lastLanguageId = "python";
  /** Code fingerprints that already went through the explain-first gate. */
  private seenFingerprints = new Set<string>();
  /** The ask that is paused behind the explain-first gate. */
  private pendingAsk?: { question: string; code: string };
  /** The snippet awaiting the student's output prediction. */
  private pendingPredict?: { snippet: string; code: string };

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly context: vscode.ExtensionContext,
    private readonly api: ApiClient,
    private readonly firebase: FirebaseClient,
    private readonly auth: AuthManager,
    private readonly queue?: OfflineQueue
  ) {}

  /** Show or hide the offline banner in the sidebar. */
  public postOffline(offline: boolean) {
    this.post({ type: "offline", value: offline });
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
          this.postAuthState();
          this.postOffline(!this.api.isAvailable);
          void this.checkReviewDue();
          return;
        case "startReview":
          await this.startReview();
          return;
        case "askHint":
          await this.handleAskFromWebview(
            msg.question as string,
            msg.code as string,
            (msg.mode as TutorMode) ?? "hint"
          );
          return;
        case "explainAnswer":
          await this.handleExplainAnswer(msg.explanation as string);
          return;
        case "explainSkip":
          await this.handleExplainSkip();
          return;
        case "predictAnswer":
          await this.handlePredictAnswer(msg.prediction as string);
          return;
        case "reset":
          await this.resetSession();
          return;
        case "refreshCode":
          await this.sendActiveCode();
          return;
        case "signIn":
          await vscode.commands.executeCommand("edupeer.signIn");
          return;
        case "signOut":
          await vscode.commands.executeCommand("edupeer.signOut");
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

    this.auth.onDidChange(() => {
      this.postAuthState();
      void this.sendBadges();
    });
  }

  public reveal() {
    this.view?.show?.(true);
  }

  public async askExternal(question: string, code: string, mode: TutorMode = "hint") {
    this.reveal();
    this.post({ type: "externalAsk", question, code });
    // External asks (context menu, reflection toast) bypass the gate.
    this.seenFingerprints.add(codeFingerprint(code ?? ""));
    await this.handleAsk(questionForMode(mode, question), code, mode);
  }

  public async resetSession() {
    this.history = [];
    this.seenFingerprints.clear();
    this.pendingAsk = undefined;
    this.pendingPredict = undefined;
    let summary = "";
    try {
      summary = await this.api.resetSession();
    } catch (err) {
      console.error("reset failed; queuing for when the backend returns", err);
      await this.queue?.enqueue({ kind: "reset" });
    }
    this.post({ type: "resetDone", summary });
  }

  /** Once per webview load, surface the Review button when a review is due. */
  private async checkReviewDue() {
    const res = await this.api.getReview(this.lastLanguageId, false);
    if (res.due) {
      this.post({ type: "reviewDue", concepts: res.concepts });
    }
  }

  private async startReview() {
    this.post({ type: "loading", value: true });
    try {
      const res = await this.api.getReview(this.lastLanguageId, true);
      if (!res.due || !res.exercise) {
        this.post({
          type: "hint",
          hint: "Nothing to review right now — nice work staying on top of things!",
          hint_level: 1,
          concept_tags: [],
          mode: "review-exercise",
        });
        return;
      }
      this.history.push({ role: "tutor", content: res.exercise });
      this.post({
        type: "hint",
        hint: res.exercise,
        hint_level: 1,
        concept_tags: res.concepts,
        mode: "review-exercise",
      });
    } finally {
      this.post({ type: "loading", value: false });
    }
  }

  /** Start a predict-the-output exercise for the given snippet. */
  public startPrediction(snippet: string, code: string) {
    this.reveal();
    this.pendingPredict = { snippet, code };
    this.post({ type: "predictFirst", snippet });
  }

  private async handlePredictAnswer(prediction: string) {
    const pending = this.pendingPredict;
    this.pendingPredict = undefined;
    if (!pending || !(prediction || "").trim()) return;
    this.post({ type: "userMessage", text: prediction });
    await this.handleAsk(
      framePrediction(pending.snippet, prediction),
      pending.code,
      "predict-output",
      { echoUser: false }
    );
  }

  private async handleAskFromWebview(question: string, code: string, mode: TutorMode) {
    // A pasted stack trace or compiler error is a lesson in reading errors,
    // not a level-1 hint.
    if (mode === "hint" && looksLikeErrorText(question)) {
      mode = "explain-error";
    }
    const filled = questionForMode(mode, question);
    if (mode === "hint") {
      const fp = codeFingerprint(code ?? "");
      if (!this.seenFingerprints.has(fp)) {
        this.seenFingerprints.add(fp);
        this.pendingAsk = { question: filled, code: code ?? "" };
        this.post({ type: "userMessage", text: filled });
        this.post({ type: "explainFirst", prompt: EXPLAIN_FIRST_PROMPT });
        return;
      }
    }
    await this.handleAsk(filled, code, mode);
  }

  private async handleExplainAnswer(explanation: string) {
    const pending = this.pendingAsk;
    this.pendingAsk = undefined;
    if (!pending) return;
    const text = (explanation || "").trim();
    if (text) {
      this.post({ type: "userMessage", text });
      await this.handleAsk(
        frameExplainedQuestion(text, pending.question),
        pending.code,
        "hint",
        { echoUser: false }
      );
    } else {
      await this.handleAsk(pending.question, pending.code, "hint", { echoUser: false });
    }
  }

  private async handleExplainSkip() {
    const pending = this.pendingAsk;
    this.pendingAsk = undefined;
    if (!pending) return;
    await this.handleAsk(pending.question, pending.code, "hint", { echoUser: false });
  }

  private async handleAsk(
    question: string,
    code: string,
    mode: TutorMode = "hint",
    opts: { echoUser?: boolean } = {}
  ) {
    if (!question || !question.trim()) {
      return;
    }
    if (opts.echoUser !== false) {
      this.post({ type: "userMessage", text: question });
    }
    this.post({ type: "loading", value: true });
    try {
      const request = {
        code: code ?? "",
        question,
        hint_level: 1,
        language: this.lastLanguageId,
        mode,
        history: this.history.slice(-MAX_HISTORY_TURNS),
      };
      let res;
      try {
        this.post({ type: "streamStart" });
        res = await this.api.streamHint(request, (event) => {
          if (event.type === "delta") {
            this.post({ type: "streamDelta", text: event.text });
          }
        });
      } catch {
        // Older backend or interrupted stream: fall back to the plain call.
        this.post({ type: "streamAbort" });
        res = await this.api.getHint(request);
      }
      this.history.push({ role: "student", content: question });
      this.history.push({ role: "tutor", content: res.hint });
      this.post({
        type: "hint",
        hint: res.hint,
        hint_level: res.hint_level,
        concept_tags: res.concept_tags,
        mode,
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
    const languageId = editor?.document?.languageId ?? "";
    if (isSupportedLanguage(languageId)) {
      this.lastLanguageId = languageId;
    }
    this.post({
      type: "activeCode",
      code,
      fileName,
      language: isSupportedLanguage(languageId) ? languageLabel(languageId) : "",
    });
  }

  private async sendBadges() {
    const badges = await this.firebase.getBadges();
    this.post({ type: "badges", badges });
  }

  private postAuthState(): void {
    const s = this.auth.getSession();
    const signedIn = !!s && !s.isAnonymous;
    this.post({
      type: "authState",
      signedIn,
      label: signedIn ? (s!.displayName || s!.email || s!.uid) : "Not signed in",
    });
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
  <div id="offlineBanner" class="offline hidden">⚠ Backend unreachable — EduPeer is offline. Retrying…</div>
  <header class="header">
    <h2>EduPeer</h2>
    <div class="account">
      <span id="accountLabel">Not signed in</span>
      <button id="authBtn" class="small-btn">Sign in</button>
    </div>
    <div class="badges" id="badges"></div>
  </header>
  <section class="code-preview">
    <div class="code-header">
      <span id="fileName">No active file</span>
      <span id="langChip" class="lang-chip hidden"></span>
      <button id="reviewBtn" class="small-btn hidden" title="A spaced-review exercise is ready">🔁 Review</button>
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
      <button id="quiz" class="secondary" title="Get a reflection question about your fix">I fixed it 🎓</button>
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
