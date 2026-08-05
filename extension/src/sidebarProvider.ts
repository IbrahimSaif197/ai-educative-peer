import * as crypto from "crypto";
import * as vscode from "vscode";
import { ApiClient, ChatTurn, RateLimitError } from "./apiClient";
import { AttemptTracker, nudgeForUnchangedCode } from "./attemptTracker";
import { AuthManager } from "./authManager";
import { FirebaseClient } from "./firebaseClient";
import { isSupportedLanguage, languageLabel } from "./languages";
import { offlineTutorReply } from "./localTutor";
import {
  EXPLAIN_FIRST_PROMPT,
  TutorMode,
  codeFingerprint,
  frameExplainedQuestion,
  framePrediction,
  frameTraceTable,
  looksLikeErrorText,
  questionForMode,
} from "./pedagogy";
import { OfflineQueue } from "./offlineQueue";

// How many prior turns are sent with each question (the backend caps
// again on its side).
const MAX_HISTORY_TURNS = 6;

/** Chat bubbles kept across window reloads. */
const CHAT_STATE_KEY = "edupeer.chatHistory";
const MAX_PERSISTED_BUBBLES = 50;

export class EduPeerSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "edupeer.sidebar";

  private view?: vscode.WebviewView;
  private history: ChatTurn[] = [];
  private lastLanguageId = "python";
  /** Identifies the document the attempt tracker is following. */
  private lastDocumentKey = "";
  /** Code fingerprints that already went through the explain-first gate. */
  private seenFingerprints = new Set<string>();
  /** The ask that is paused behind the explain-first gate. */
  private pendingAsk?: { question: string; code: string; confidence: number };
  /** The snippet awaiting the student's output prediction. */
  private pendingPredict?: { snippet: string; code: string };
  /** The desk-check exercise awaiting the student's filled-in grid. */
  private pendingTrace?: { snippet: string; code: string; variables: string[] };
  private readonly attempts = new AttemptTracker();
  /** Rotates the generic offline prompt so it doesn't repeat verbatim. */
  private offlineReplyCount = 0;
  /** Current hint level, mirrored to the status bar. */
  private readonly levelEmitter = new vscode.EventEmitter<number>();
  readonly onDidChangeHintLevel = this.levelEmitter.event;

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
          this.post({
            type: "restoreChat",
            messages: this.context.globalState.get<unknown[]>(CHAT_STATE_KEY, []),
          });
          await this.sendActiveCode();
          await this.sendBadges();
          this.postAuthState();
          this.postOffline(!this.api.isAvailable);
          void this.checkReviewDue();
          return;
        case "persistChat":
          await this.context.globalState.update(
            CHAT_STATE_KEY,
            (msg.messages as unknown[] | undefined)?.slice(-MAX_PERSISTED_BUBBLES) ?? []
          );
          return;
        case "startReview":
          await this.startReview();
          return;
        case "askHint":
          await this.handleAskFromWebview(
            msg.question as string,
            msg.code as string,
            (msg.mode as TutorMode) ?? "hint",
            Number(msg.confidence ?? 0)
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
        case "traceAnswer":
          await this.handleTraceAnswer(msg.rows as string[][]);
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
    this.pendingTrace = undefined;
    this.attempts.clear();
    this.levelEmitter.fire(0);
    await this.context.globalState.update(CHAT_STATE_KEY, []);
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

  /**
   * Start a desk-check exercise: ask the backend which variables are worth
   * tracing, then show a grid. Snippets with no changing state fall back to a
   * free-text prediction rather than showing an empty table.
   */
  public async startTrace(snippet: string, code: string) {
    this.reveal();
    this.post({ type: "loading", value: true });
    try {
      const design = await this.api.getTrace(code, snippet, this.lastLanguageId);
      if (!design.steps || design.variables.length < 2) {
        this.startPrediction(snippet, code);
        return;
      }
      this.pendingTrace = { snippet, code, variables: design.variables };
      this.post({
        type: "traceTable",
        snippet,
        variables: design.variables,
        steps: design.steps,
        prompt: design.prompt,
      });
    } finally {
      this.post({ type: "loading", value: false });
    }
  }

  private async handleTraceAnswer(rows: string[][]) {
    const pending = this.pendingTrace;
    this.pendingTrace = undefined;
    if (!pending) return;
    const filled = Array.isArray(rows) ? rows : [];
    await this.handleAsk(
      frameTraceTable(pending.snippet, pending.variables, filled),
      pending.code,
      "trace-check",
      { echoUser: false }
    );
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

  private async handleAskFromWebview(
    question: string,
    code: string,
    mode: TutorMode,
    confidence: number
  ) {
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
        this.pendingAsk = { question: filled, code: code ?? "", confidence };
        this.post({ type: "userMessage", text: filled });
        this.post({ type: "explainFirst", prompt: EXPLAIN_FIRST_PROMPT });
        return;
      }
    }
    await this.handleAsk(filled, code, mode, { confidence });
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
        { echoUser: false, confidence: pending.confidence }
      );
    } else {
      await this.handleAsk(pending.question, pending.code, "hint", {
        echoUser: false,
        confidence: pending.confidence,
      });
    }
  }

  private async handleExplainSkip() {
    const pending = this.pendingAsk;
    this.pendingAsk = undefined;
    if (!pending) return;
    await this.handleAsk(pending.question, pending.code, "hint", {
      echoUser: false,
      confidence: pending.confidence,
    });
  }

  private async handleAsk(
    question: string,
    code: string,
    mode: TutorMode = "hint",
    opts: { echoUser?: boolean; confidence?: number } = {}
  ) {
    if (!question || !question.trim()) {
      return;
    }
    if (opts.echoUser !== false) {
      this.post({ type: "userMessage", text: question });
    }

    // Only progressive hints are gated on having actually tried something.
    const attempt =
      mode === "hint"
        ? this.attempts.evaluate(this.lastDocumentKey, code ?? "")
        : undefined;
    if (attempt?.signal === "unchanged") {
      this.post({
        type: "hint",
        hint: nudgeForUnchangedCode(attempt.cooldownRemainingMs),
        hint_level: 0,
        concept_tags: [],
        mode: "attempt-gate",
      });
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
        escalate: attempt ? attempt.escalate : true,
        edit_summary: attempt?.editSummary ?? "",
        confidence: Math.max(0, Math.min(3, Math.trunc(opts.confidence ?? 0))),
      };
      let res;
      try {
        this.post({ type: "streamStart" });
        res = await this.api.streamHint(request, (event) => {
          if (event.type === "delta") {
            this.post({ type: "streamDelta", text: event.text });
          }
        });
      } catch (err) {
        this.post({ type: "streamAbort" });
        if (err instanceof RateLimitError) throw err;
        // Older backend or interrupted stream: fall back to the plain call.
        res = await this.api.getHint(request);
      }
      if (mode === "hint") {
        this.attempts.record(this.lastDocumentKey, code ?? "");
        this.levelEmitter.fire(res.hint_level);
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
      this.postFailure(err, code ?? "");
    } finally {
      this.post({ type: "loading", value: false });
    }
  }

  /**
   * Turn a failed ask into something useful: a quota message when the backend
   * is throttling, a local rule-based nudge when it is unreachable, and only
   * then a plain error.
   */
  private postFailure(err: unknown, code: string) {
    if (err instanceof RateLimitError) {
      this.post({
        type: "hint",
        hint:
          `${err.message}\n\n` +
          `While you wait: re-read the line you're least sure about and say what you expect it to do.`,
        hint_level: 0,
        concept_tags: [],
        mode: "rate-limited",
      });
      return;
    }
    if (!this.api.isAvailable) {
      this.post({
        type: "hint",
        hint: offlineTutorReply(code, this.lastLanguageId, this.offlineReplyCount++),
        hint_level: 0,
        concept_tags: [],
        mode: "offline",
      });
      return;
    }
    const message = (err as { message?: string })?.message ?? String(err);
    this.post({ type: "error", message });
  }

  private async sendActiveCode() {
    const editor = vscode.window.activeTextEditor;
    const code = editor?.document?.getText() ?? "";
    const fileName = editor?.document?.fileName ?? "";
    const languageId = editor?.document?.languageId ?? "";
    if (isSupportedLanguage(languageId)) {
      this.lastLanguageId = languageId;
    }
    this.lastDocumentKey = editor?.document?.uri?.toString() ?? "";
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
    const asset = (name: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", name));
    const nonce = getNonce();
    const csp = `default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <link rel="stylesheet" href="${asset("style.css")}" />
  <title>EduPeer</title>
</head>
<body>
  <div id="offlineBanner" class="banner banner--warn" hidden>
    <span class="banner__dot" aria-hidden="true"></span>
    <span>Backend unreachable — retrying. Nudges are local for now.</span>
  </div>

  <header class="topbar">
    <div class="topbar__row">
      <span class="brand">
        <span class="brand__mark" aria-hidden="true"></span>
        <span class="brand__name">EduPeer</span>
      </span>
      <span class="topbar__spacer"></span>
      <span id="accountLabel" class="topbar__account" title="Signed-in account">Not signed in</span>
      <button id="authBtn" class="btn btn--ghost btn--sm">Sign in</button>
    </div>
    <details class="badges" id="badgesWrap">
      <summary class="badges__summary">
        <span id="badgeCount">No badges yet</span>
      </summary>
      <div class="badges__list" id="badges"></div>
    </details>
  </header>

  <section class="filecard">
    <div class="filecard__head">
      <span class="filecard__name" id="fileName">No active file</span>
      <span id="langChip" class="chip" hidden></span>
      <span class="topbar__spacer"></span>
      <button id="reviewBtn" class="btn btn--accent btn--sm" hidden title="A spaced-review exercise is ready">Review</button>
      <button id="collapseCode" class="btn btn--ghost btn--sm" title="Show or hide the code preview" aria-expanded="true">Hide</button>
      <button id="refreshCode" class="btn btn--ghost btn--sm" title="Re-read the active file">Refresh</button>
    </div>
    <pre id="codeSnippet" class="filecard__code" tabindex="0"></pre>
  </section>

  <section class="chat" id="chat" role="log" aria-live="polite" aria-label="Tutor conversation"></section>

  <div class="thinking" id="loading" hidden>
    <span class="thinking__dots" aria-hidden="true"><i></i><i></i><i></i></span>
    <span>EduPeer is thinking…</span>
  </div>

  <footer class="composer">
    <div class="stepper" id="stepper" hidden>
      <span class="stepper__label">Hint depth</span>
      <ol class="stepper__track" id="stepperTrack">
        <li class="stepper__step" data-level="1"><span>1</span></li>
        <li class="stepper__step" data-level="2"><span>2</span></li>
        <li class="stepper__step" data-level="3"><span>3</span></li>
      </ol>
    </div>

    <fieldset class="confidence" id="confidence">
      <legend class="confidence__legend">How sure are you?</legend>
      <button type="button" class="conf" data-value="1" aria-pressed="false">No idea</button>
      <button type="button" class="conf" data-value="2" aria-pressed="false">Some idea</button>
      <button type="button" class="conf" data-value="3" aria-pressed="false">Pretty sure</button>
    </fieldset>

    <label class="visually-hidden" for="input">Your question</label>
    <textarea id="input" rows="3" placeholder="Describe your error or ask a question…"></textarea>
    <div class="composer__actions">
      <button id="send" class="btn btn--primary">Ask<span class="btn__hint">Ctrl↵</span></button>
      <button id="quiz" class="btn btn--ghost" title="Get a reflection question about your fix">I fixed it</button>
      <button id="reset" class="btn btn--ghost" title="Clear the conversation and start at hint 1">Reset</button>
    </div>
  </footer>

  <script nonce="${nonce}" src="${asset("markdown.js")}"></script>
  <script nonce="${nonce}" src="${asset("main.js")}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  return crypto.randomBytes(24).toString("base64");
}
