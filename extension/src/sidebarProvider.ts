import * as crypto from "crypto";
import * as vscode from "vscode";
import { ApiClient, AuthError, ChatTurn, RateLimitError, digestFields } from "./apiClient";
import { AttemptTracker, isAnswerRequest, isAttempt, nudgeForUnchangedCode } from "./attemptTracker";
import { AuthManager } from "./authManager";
import { stripBugMarkers } from "./bugMarkers";
import { buildDigest, type CodeDigest } from "./codeDigest";
import { digestFor } from "./documentDigest";
import { FirebaseClient } from "./firebaseClient";
import { FocusScope, focusText, resolveFocus } from "./focusScope";
import { isSupportedLanguage, languageLabel } from "./languages";
import { offlineTutorReply } from "./localTutor";
import {
  EXPLAIN_FIRST_PROMPT,
  TutorMode,
  frameExplainedQuestion,
  framePrediction,
  frameReviewAnswer,
  frameTraceTable,
  looksLikeErrorText,
  questionForMode,
} from "./pedagogy";
import { OfflineQueue } from "./offlineQueue";

// How many prior turns are sent with each question (the backend caps
// again on its side).
const MAX_HISTORY_TURNS = 6;

/** Cap on one thread's rendered bubbles, so a long session cannot grow forever. */
const MAX_PERSISTED_BUBBLES = 50;

/** One conversation: the model-facing turns and the rendered bubbles. */
type Thread = { history: ChatTurn[]; bubbles: unknown[] };

export class EduPeerSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "edupeer.sidebar";

  private view?: vscode.WebviewView;
  /**
   * One conversation per function, keyed by `threadKey`.
   *
   * The hint ladder was already per function while the transcript was one
   * global list, so the transcript on screen and the level beside it
   * described different things. In memory rather than `globalState` because
   * a conversation belongs to the session that had it.
   */
  private threads = new Map<string, Thread>();
  /** The thread for `key`, created on first use. */
  private threadFor(key: string): Thread {
    let thread = this.threads.get(key);
    if (!thread) {
      thread = { history: [], bubbles: [] };
      this.threads.set(key, thread);
    }
    return thread;
  }
  /** The thread for the block the cursor is in, created on first use. */
  private get thread(): Thread {
    return this.threadFor(this.threadKey);
  }
  /**
   * The conversation on screen, which follows named blocks only.
   *
   * A selection or a click on a blank line resolves to a file-level focus, and
   * keying off that blanked the panel mid-conversation for an ordinary cursor
   * gesture. The thread stays where it is until the student is genuinely in a
   * different function.
   */
  private threadKey = "";
  /**
   * The thread the webview is currently rendering.
   *
   * `persistChat` carries no key and crosses an async boundary, so resolving
   * its destination from the live focus writes one function's transcript over
   * another's. The webview only ever renders what `restoreChat` gave it, so
   * that is the key its bubbles belong to.
   */
  private renderedKey = "";
  /**
   * Set when the thread the cursor is in changes while an ask is still
   * streaming. `sendFocus` defers the swap here instead of posting it
   * immediately, and `handleAsk`'s `finally` block posts it once the ask
   * settles — a student watching an answer arrive must not have the panel
   * wiped out from under them.
   */
  private pendingThreadSwap = false;
  private lastLanguageId = "python";
  /**
   * The block the cursor is literally in, `uri#label` or `uri`.
   *
   * No longer the hint ladder's key — that follows `threadKey` now, so the
   * transcript on screen and the level beside it cannot describe different
   * problems. Its one remaining reader is `lastFileKey`, which the
   * explain-first gate keys on.
   */
  private lastDocumentKey = "";
  /** The open document, ignoring which block the cursor is in. */
  private get lastFileKey(): string {
    return this.lastDocumentKey.split("#")[0];
  }
  /** The block the student is working on; drives the panel and every ask. */
  private lastFocus?: FocusScope;
  /** The digest for `lastFocus`, rebuilt whenever the focus block changes. */
  private lastDigest?: CodeDigest;
  /**
   * The text of the block `threadKey` names, which attempt tracking diffs.
   *
   * It moves with `threadKey`, not with the focus, and the two must never
   * drift apart. When it followed the focus, selecting a couple of lines
   * inside a function left the key on the function while the text collapsed
   * to the selection — same key, different text — so the tracker read it as
   * an edit and sent the model a diff of a function being replaced by two
   * lines. The student had changed nothing, and the tutor answered their next
   * question against a rewrite that never happened.
   */
  private threadBlockCode = "";
  /**
   * The full document text, for the webview's "Whole file" toggle only.
   *
   * The webview runs inside the editor, so nothing it renders crosses the
   * network — that toggle is the one legitimate reason to hold the whole
   * file in memory. `lastDigest` is what the wire actually sends; the name
   * change from `lastFullCode` is what stops this field being reached for
   * as a request payload again.
   */
  private panelFullCode = "";
  /** Suppresses a re-post when nothing the student can see has changed. */
  private lastFocusSignature = "";
  /** Last cursor line posted, 1-based. Suppresses repeat cursor messages. */
  private lastCursorLine = 0;
  private focusDebounce?: NodeJS.Timeout;
  /**
   * Files that have already been through the explain-first gate.
   *
   * Keyed on the document, not on a fingerprint of its contents: keyed on
   * contents, every edit made the file look new and the gate interrupted the
   * conversation again.
   */
  private explainedFiles = new Set<string>();
  /**
   * The ask that is paused behind the explain-first gate.
   *
   * `attempted` is the verdict on the question the student actually typed,
   * taken before `questionForMode` wrapped it. Judging the wrapper, or the
   * later "explanation + question" framing, let a give-up phrase in one half
   * score the whole ask as a refusal.
   */
  private pendingAsk?: { question: string; code: string; attempted: boolean };
  /** The snippet awaiting the student's output prediction. */
  private pendingPredict?: { snippet: string; code: string };
  /** The desk-check exercise awaiting the student's filled-in grid. */
  private pendingTrace?: { snippet: string; code: string; variables: string[] };
  /** The spaced-review exercise awaiting the student's written answer. */
  private pendingReview?: string;
  private readonly attempts = new AttemptTracker();
  /** Rotates the generic offline prompt so it doesn't repeat verbatim. */
  private offlineReplyCount = 0;
  /**
   * Bumped by every reset. A response that comes back carrying an older
   * generation belongs to a conversation the student has already cleared, so
   * it is dropped instead of re-seeding the history they just wiped.
   */
  private sessionGeneration = 0;
  /**
   * Identifies the ask currently streaming. Ctrl+Enter and the mode buttons
   * can start a second ask while the first is mid-stream; without an id the
   * webview appends both streams' deltas into one bubble.
   */
  private askSeq = 0;
  private askInFlight = false;
  /** Current hint level, mirrored to the status bar. */
  private readonly levelEmitter = new vscode.EventEmitter<number>();
  readonly onDidChangeHintLevel = this.levelEmitter.event;
  /**
   * Last streak pushed. `post` is a no-op while the view does not exist, so a
   * webview resolved after that push (the panel is opened on demand, not at
   * startup) would otherwise never learn the streak. Re-read on "ready".
   */
  private lastStreakDays = 0;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly context: vscode.ExtensionContext,
    private readonly api: ApiClient,
    private readonly firebase: FirebaseClient,
    private readonly auth: AuthManager,
    private readonly queue?: OfflineQueue
  ) {}

  /** Show or hide the offline banner in the sidebar. */
  /**
   * Tell the student why the wait got long, rather than leaving them on a
   * spinner. The backend sleeps on Render's free plan and takes ~50s to wake,
   * so the first ask after a quiet spell legitimately stalls — silence there
   * reads as a hang, and the honest explanation costs one line.
   */
  private announceColdStart() {
    this.post({
      type: "hint",
      hint:
        "The server had gone to sleep and is starting up — this can take up to a minute.\n\n" +
        "Your question is still on its way; nothing was lost.",
      hint_level: 0,
      concept_tags: [],
      mode: "waking",
    });
  }

  public postOffline(offline: boolean) {
    this.post({ type: "offline", value: offline });
  }

  /**
   * Show or hide the sign-in banner. Separate from the offline banner because
   * "the server is down" and "the server is fine but auth is broken" send the
   * student to two different places.
   */
  public postAuthTrouble(failed: boolean) {
    this.post({ type: "authTrouble", value: failed });
  }

  /**
   * Mirror the practice streak into the panel. The value comes from the same
   * progress call the status bar already makes, so this costs no extra
   * request.
   */
  public postStreak(days: number): void {
    this.lastStreakDays = days;
    this.post({ type: "streak", days });
  }

  /** A file just went clean. The panel marks the moment. */
  public postScanClean(): void {
    this.post({ type: "scanClean" });
  }

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    // Attached here rather than in the constructor: the message has nowhere to
    // go until a webview exists, and `post` is a no-op without one.
    this.api.onColdStart = () => this.announceColdStart();
    // The suppression signature describes what the LAST webview was showing,
    // and this one is showing nothing at all. Carrying it across leaves a
    // reopened sidebar stuck on "No active file" with an empty preview, an
    // empty `currentCode` and a Refresh button that routes back through the
    // same suppressed path.
    this.lastFocusSignature = "";
    this.lastCursorLine = 0;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case "ready":
          this.postAuthState();
          this.postPreferences();
          // On the very first "ready" there is no thread yet: posting one
          // would create a permanent phantom "" entry in `threads` and send an
          // empty `restoreChat` that `sendFocus` immediately supersedes.
          if (this.threadKey !== "") {
            this.postThread(this.threadKey);
          }
          await this.sendFocus();
          await this.sendBadges();
          this.postOffline(!this.api.isAvailable);
          this.postAuthTrouble(this.api.isAuthHealthy === false);
          this.postStreak(this.lastStreakDays);
          void this.checkReviewDue();
          return;
        case "persistChat":
          // Keyed on what the webview is actually showing (`renderedKey`),
          // not on the live focus: this crosses an async boundary, and the
          // cursor can have moved to another function by the time it drains.
          this.threadFor(this.renderedKey).bubbles =
            (msg.messages as unknown[] | undefined)?.slice(-MAX_PERSISTED_BUBBLES) ?? [];
          return;
        case "startReview":
          await this.startReview();
          return;
        case "askHint":
          await this.handleAskFromWebview(msg.question as string, msg.code as string, (msg.mode as TutorMode) ?? "hint");
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
        case "reviewAnswer":
          await this.handleReviewAnswer(msg.answer as string);
          return;
        case "reset":
          await this.resetSession();
          return;
        case "refreshCode":
          // Refresh is the student saying "I don't trust what I'm looking
          // at". Answering with silence because nothing changed is the one
          // reply it must never give.
          await this.sendFocus({ force: true });
          return;
        case "requestFullFile":
          this.post({ type: "fullFile", code: this.panelFullCode });
          return;
        case "signIn":
          await vscode.commands.executeCommand("edupeer.signIn");
          return;
        case "signOut":
          await vscode.commands.executeCommand("edupeer.signOut");
          return;
        case "requestPreferences":
          this.postPreferences();
          return;
        case "setPreference":
          await this.setPreference(msg.key, msg.value);
          // Echoed back rather than assumed: `update()` can be overridden by a
          // workspace or folder value, in which case the effective setting is
          // not what the student just clicked, and the toggle has to say so.
          this.postPreferences();
          return;
        case "showProgress":
          await vscode.commands.executeCommand("edupeer.showProgress");
          return;
        case "setGoal":
          await vscode.commands.executeCommand("edupeer.setGoal");
          return;
        case "openSettings":
          await vscode.commands.executeCommand(
            "workbench.action.openSettings",
            "@ext:edupeer.edupeer"
          );
          return;
        // The empty state's starter chips, and the context strip's way out of
        // having no file. Each is its own named case rather than one message
        // carrying a command id: the set of commands the panel can reach then
        // stays a property of this file, not of whatever the webview sends.
        case "startPredict":
          await vscode.commands.executeCommand("edupeer.predictOutput");
          return;
        case "startTrace":
          await vscode.commands.executeCommand("edupeer.traceCode");
          return;
        case "openFile":
          await vscode.commands.executeCommand("workbench.action.quickOpen");
          return;
        // The offline banner's Retry. It probes the backend rather than
        // re-reading the file: a button labelled Retry that retries nothing
        // is worse than no button, and the background poll is on a 30s timer
        // the student has no way to see.
        case "retryConnection":
          await this.api.health?.();
          this.postOffline(!this.api.isAvailable);
          return;
      }
    });

    // VS Code re-resolves the view whenever its host is recreated (closing and
    // reopening the sidebar does it). Without disposing on that boundary, each
    // recreation stacked another set of listeners on events that fire per
    // keystroke, and every one of them posted the whole document.
    const subs: vscode.Disposable[] = [
      vscode.window.onDidChangeActiveTextEditor(() => this.scheduleFocus()),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (
          vscode.window.activeTextEditor &&
          e.document === vscode.window.activeTextEditor.document
        ) {
          this.scheduleFocus();
        }
      }),
      vscode.window.onDidChangeTextEditorSelection(() => this.scheduleFocus()),
      this.auth.onDidChange(() => {
        this.postAuthState();
        void this.sendBadges();
      }),
      // A setting can change from the Settings UI, from another window, or
      // from a workspace file landing under a global value. The popover shows
      // toggles, and a toggle that disagrees with the editor it claims to
      // control is worse than no toggle.
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("edupeer")) this.postPreferences();
      }),
    ];

    webviewView.onDidDispose(() => {
      for (const d of subs) {
        d.dispose();
      }
      subs.length = 0;
      if (this.focusDebounce) clearTimeout(this.focusDebounce);
      if (this.view === webviewView) {
        this.view = undefined;
      }
    });
  }

  /** Releases the level emitter; called from the extension's deactivate path. */
  public dispose(): void {
    this.levelEmitter.dispose();
  }

  public reveal() {
    this.view?.show?.(true);
  }

  public async askExternal(question: string, code: string, mode: TutorMode = "hint") {
    this.reveal();
    // Re-resolving here is what makes a context-menu command on a selection
    // focus on that selection: `resolveFocus` ranks an explicit selection first.
    await this.sendFocus();
    this.post({ type: "externalAsk", question, code });
    // External asks (context menu, reflection toast) bypass the gate.
    this.explainedFiles.add(this.lastFileKey);
    await this.handleAsk(questionForMode(mode, question), code, mode);
  }

  public async resetSession() {
    // Anything already in flight now belongs to a cleared conversation.
    this.sessionGeneration++;
    // Every thread, not just the one on screen. `attempts.clear()` below takes
    // no key and the backend's /reset drops every hint level for the user, so
    // wiping a single transcript left every other function's chat on screen
    // stamped with a depth its next ask would no longer start from. The panel
    // already promises the whole session ("we're back at hint 1").
    this.threads.clear();
    this.explainedFiles.clear();
    this.pendingAsk = undefined;
    this.pendingPredict = undefined;
    this.pendingTrace = undefined;
    this.pendingReview = undefined;
    this.attempts.clear();
    this.levelEmitter.fire(0);

    // The panel clears now, not when the backend answers. Everything above
    // this line has already happened in the extension host, so the transcript
    // on screen is describing a session that no longer exists — and it used to
    // keep describing it for as long as `/reset` took, which is a Firestore
    // read, an LLM summary and a batch delete away, on a free-tier box that
    // may be asleep. The student pressed a button that clears things; it
    // clears things.
    //
    // `loading` goes with it. Reset was the one entry point that never sent
    // it, so `isLoading` stayed false in the webview, the button was never
    // disabled, and its own `if (isLoading) return` guard never fired: every
    // impatient second click started another full round trip.
    this.post({ type: "loading", value: true });
    this.post({ type: "resetCleared" });

    let summary = "";
    try {
      summary = await this.api.resetSession();
    } catch (err) {
      console.error("reset failed; queuing for when the backend returns", err);
      await this.queue?.enqueue({ kind: "reset" });
    } finally {
      this.post({ type: "loading", value: false });
    }
    // Only the summary is left to deliver. It is the one part of a reset that
    // genuinely needs the server, and the one part nothing is waiting on.
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
    // Captured before the await, for the same reason `handleAsk` captures it:
    // the cursor can move to another function while the review is being
    // fetched, and the exercise belongs to the thread that asked for it.
    const thread = this.thread;
    // Held for the same reason too — so a focus change does not clear the
    // panel out from under the spinner.
    this.askInFlight = true;
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
      thread.history.push({ role: "tutor", content: res.exercise });
      // Remembered so the student's answer is marked against the exercise,
      // not against whatever file is open in the editor.
      this.pendingReview = res.exercise;
      this.post({
        type: "hint",
        hint: res.exercise,
        hint_level: 1,
        concept_tags: res.concepts,
        mode: "review-exercise",
      });
    } finally {
      this.askInFlight = false;
      this.post({ type: "loading", value: false });
      this.flushPendingThreadSwap();
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
      // `code` is not sent: the handler never reads it when `selection` is
      // non-empty, and the caller guarantees that. It is kept as a parameter
      // because the follow-up ask below still needs the block for context —
      // and that path digests it, so it is bounded.
      const design = await this.api.getTrace(snippet, this.lastLanguageId);
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
      { echoUser: false, aboutOpenFile: false }
    );
  }

  private async handleReviewAnswer(answer: string) {
    const exercise = this.pendingReview;
    this.pendingReview = undefined;
    if (!exercise || !(answer || "").trim()) return;
    this.post({ type: "userMessage", text: answer });
    await this.handleAsk(
      frameReviewAnswer(exercise, answer),
      // The exercise is the subject, not the open file: reviews are about a
      // concept from days ago, and the editor is usually on something else.
      exercise,
      "review-exercise",
      { echoUser: false, aboutOpenFile: false }
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
      { echoUser: false, aboutOpenFile: false }
    );
  }

  private async handleAskFromWebview(question: string, code: string, mode: TutorMode) {
    // A pasted stack trace or compiler error is a lesson in reading errors,
    // not a level-1 hint.
    if (mode === "hint" && looksLikeErrorText(question)) {
      mode = "explain-error";
    }
    // Asked outright for the answer. Routed here, before the attempt gate, so
    // it neither advances nor spends a rung — and so the three of these
    // phrases that also sit in `GIVE_UP` never reach it to be scored as
    // giving up.
    if (mode === "hint" && isAnswerRequest(question)) {
      mode = "answer";
    }
    const filled = questionForMode(mode, question);
    // Judged on what the student typed, not on the canned wrapper
    // `questionForMode` may have put around it.
    const attempted = isAttempt(question);
    if (mode === "hint") {
      const fileKey = this.lastFileKey;
      if (!this.explainedFiles.has(fileKey)) {
        this.explainedFiles.add(fileKey);
        this.pendingAsk = { question: filled, code: code ?? "", attempted };
        this.post({ type: "userMessage", text: filled });
        this.post({ type: "explainFirst", prompt: EXPLAIN_FIRST_PROMPT });
        return;
      }
    }
    await this.handleAsk(filled, code, mode, { attempted });
  }

  private async handleExplainAnswer(explanation: string) {
    const pending = this.pendingAsk;
    this.pendingAsk = undefined;
    if (!pending) return;
    const text = (explanation || "").trim();
    if (text) {
      this.post({ type: "userMessage", text });
      await this.handleAsk(frameExplainedQuestion(text, pending.question), pending.code, "hint", {
        echoUser: false,
        // Either raw message on its own is enough. Judging the framed
        // "explanation + question" string instead meant a shrug in one half
        // condemned the other, in the direction the design warns against.
        attempted: isAttempt(text) || pending.attempted,
      });
    } else {
      // A blank explanation is a skip.
      await this.handleAsk(pending.question, pending.code, "hint", {
        echoUser: false,
        attempted: pending.attempted,
      });
    }
  }

  private async handleExplainSkip() {
    const pending = this.pendingAsk;
    this.pendingAsk = undefined;
    if (!pending) return;
    await this.handleAsk(pending.question, pending.code, "hint", {
      echoUser: false,
      // They typed nothing here, but the question waiting behind the gate is
      // still their own words.
      attempted: pending.attempted,
    });
  }

  private async handleAsk(
    question: string,
    code: string,
    mode: TutorMode = "hint",
    opts: {
      echoUser?: boolean;
      /**
       * When false, `code` is sent verbatim and no focus is attached: the
       * caller has already chosen the subject. A review exercise is about a
       * concept from days ago; a prediction or a trace is about the snapshot
       * its exercise started from. The editor's current focus is not what any
       * of them is asking about.
       */
      aboutOpenFile?: boolean;
      /**
       * Whether the student typed something that engaged with the problem.
       *
       * Computed by the call sites that carry a student-typed message and
       * defaulted to `false` here, because most callers do not. `handleAsk`
       * used to run `isAttempt` over whatever string it was handed, so the
       * canned questions behind "analyse selection", the Quick Fix on a
       * diagnostic and the test watcher's "Talk it through" all scored as
       * attempts - three clicks walked the ladder to pseudocode with the
       * student having typed nothing, the exact path this gate exists to
       * close.
       */
      attempted?: boolean;
    } = {}
  ) {
    if (!question || !question.trim()) {
      return;
    }
    if (this.askInFlight) {
      // Two overlapping asks interleave their stream deltas into a single
      // bubble and each advance the ladder, so the second one is refused.
      this.post({
        type: "hint",
        hint:
          "One question at a time — EduPeer is still working on the last one.\n\n" +
          "While you wait, jot down what you expect to happen and why.",
        hint_level: 0,
        concept_tags: [],
        mode: "attempt-gate",
      });
      return;
    }
    if (opts.echoUser !== false) {
      this.post({ type: "userMessage", text: question });
    }

    const aboutOpenFile = opts.aboutOpenFile !== false;
    // The digest, so a hint about one function still sees its imports and
    // what it can call — without the four hundred lines between them.
    //
    // `lastDigest` was already stripped of any seeded `bug:` marker when
    // `sendFocus` built it through `digestFor`. The fallback branch below is
    // the one place a digest is built from something that is not a
    // `TextDocument` at all — a review exercise, a prediction, a trace
    // answer, none of which ever passes through `sendFocus` — so it goes to
    // `buildDigest` directly and does its own stripping, at request time.
    const digest =
      aboutOpenFile && this.lastDigest
        ? this.lastDigest
        : buildDigest(
            stripBugMarkers(code || "", this.lastLanguageId).split("\n"),
            this.lastLanguageId,
            { start: 0, end: Math.max(0, (code || "").split("\n").length - 1) }
          );
    const attemptCode = aboutOpenFile ? this.threadBlockCode || code || "" : code || "";

    // The ladder rides the sticky thread key, so the transcript on screen and
    // the depth beside it always describe the same problem. Keying it on the
    // block the cursor is literally in collapsed the level to the file's the
    // moment a selection resolved above the enclosing symbol: 3 → 1 on select,
    // back to 3 on deselect, while the chat correctly held. Read once, before
    // the first await, for the same reason the thread is.
    const problemKey = this.threadKey;

    // Only progressive hints are gated on having actually tried something.
    const attempt =
      mode === "hint"
        ? this.attempts.evaluate(problemKey, attemptCode, Date.now(), opts.attempted === true)
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

    // Captured before the first await: the cursor can move to another block
    // while the stream is in flight, and the answer belongs to the
    // conversation that asked for it, not to whichever one is on screen when
    // it lands.
    const thread = this.thread;

    const seq = ++this.askSeq;
    const generation = this.sessionGeneration;
    this.askInFlight = true;
    this.post({ type: "loading", value: true });
    try {
      const request = {
        ...digestFields(digest),
        question,
        hint_level: 1,
        // The ladder is keyed on the problem, not the bytes, so editing the
        // code deepens the hint instead of restarting at level 1.
        problem_key: problemKey,
        language: this.lastLanguageId,
        mode,
        history: thread.history.slice(-MAX_HISTORY_TURNS),
        escalate: attempt ? attempt.escalate : true,
        edit_summary: attempt?.editSummary ?? "",
        ...(aboutOpenFile && this.lastFocus
          ? {
              focus: {
                start_line: this.lastFocus.startLine + 1,
                end_line: this.lastFocus.endLine + 1,
                label: this.lastFocus.label,
              },
            }
          : {}),
      };
      let res;
      try {
        this.post({ type: "streamStart", seq });
        res = await this.api.streamHint(request, (event) => {
          if (event.type === "delta" && generation === this.sessionGeneration) {
            this.post({ type: "streamDelta", seq, text: event.text });
          }
        });
      } catch (err) {
        this.post({ type: "streamAbort", seq });
        if (err instanceof RateLimitError) throw err;
        // Older backend or interrupted stream: fall back to the plain call.
        res = await this.api.getHint(request);
      }
      if (generation !== this.sessionGeneration) {
        // The student reset while this was in flight. Dropping it here keeps
        // the cleared history cleared and the hint depth at 0.
        return;
      }
      if (mode === "hint") {
        this.attempts.record(problemKey, attemptCode);
        this.levelEmitter.fire(res.hint_level);
      }
      thread.history.push({ role: "student", content: question });
      thread.history.push({ role: "tutor", content: res.hint });
      this.post({
        type: "hint",
        seq,
        hint: res.hint,
        hint_level: res.hint_level,
        concept_tags: res.concept_tags,
        // The mode the backend *ran*, not the one asked for: at the top of the
        // ladder a `hint` request comes back as `worked-example`, and the card
        // is titled — and its "Label the steps" action gated — from this.
        // Falls back to the request mode for a backend too old to report one.
        //
        // Only the label moves. `attempts.record` and the level event above
        // stay keyed on the request mode: re-key them here and rung 4 stops
        // spending its rung, which strands the ladder at 4 forever.
        mode: res.mode ?? mode,
      });
      await this.sendBadges();
    } catch (err: any) {
      if (generation === this.sessionGeneration) {
        this.postFailure(err, code ?? "");
      }
    } finally {
      this.askInFlight = false;
      this.post({ type: "loading", value: false });
      this.flushPendingThreadSwap();
    }
  }

  /**
   * Show a thread swap that was withheld while an ask was in flight.
   *
   * The swap is deferred rather than posted the moment the cursor moves, so
   * the panel is never wiped out from under a student watching an answer
   * arrive. Skipped when the webview is already rendering this thread: a
   * cursor that went A → B → A during the stream leaves the panel correct
   * already, and re-posting there races `persistChat`'s round trip — the
   * bubbles the host holds would not yet include the answer that just
   * streamed in, so the student would watch it vanish.
   */
  private flushPendingThreadSwap(): void {
    if (!this.pendingThreadSwap) return;
    this.pendingThreadSwap = false;
    if (this.threadKey !== this.renderedKey) {
      this.postThread(this.threadKey);
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
    // A broken sign-in means no request can carry a token, so the local tutor
    // is the only thing left to offer — same as being offline, even though the
    // banner above says something different about why.
    if (!this.api.isAvailable || err instanceof AuthError) {
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

  /**
   * Resolve the focus block and push it to the panel, if it moved.
   *
   * `force` skips the suppression check for the callers that are answering a
   * request rather than reacting to an edit.
   */
  private async sendFocus(opts: { force?: boolean } = {}) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      this.lastFocus = undefined;
      // Cleared with `lastFocus`, for the same reason: `handleAsk` reuses
      // `lastDigest` whenever `aboutOpenFile` is true and it is set, and a
      // stale digest left behind after the editor closed would answer the
      // next such ask about a file that is no longer open, instead of
      // falling back to whatever `code` that ask actually carries.
      this.lastDigest = undefined;
      this.panelFullCode = "";
      this.lastFocusSignature = "";
      this.lastCursorLine = 0;
      this.lastDocumentKey = "";
      // `threadKey` and `threadBlockCode` are left exactly as they were, for
      // the same reason and as a pair — clearing the text but not the key
      // would make the next ask diff the block against "" and report the
      // whole function as deleted. Losing the active editor is
      // not changing function — swapping it here would move the store to a
      // phantom "" bucket while the panel keeps showing the transcript it
      // already has, and anything typed while the file is gone would land in
      // a thread nothing ever shows again.
      this.post({ type: "focus", focusCode: "", fileName: "", language: "", totalLines: 0 });
      return;
    }

    const doc = editor.document;
    const languageId = doc.languageId;
    if (isSupportedLanguage(languageId)) {
      this.lastLanguageId = languageId;
    }

    const focus = await resolveFocus(doc, editor.selection);
    const focusCode = focusText(doc, focus);
    const signature = `${doc.uri.toString()}:${focus.startLine}:${focus.endLine}:${focusCode}`;
    // The old code posted the whole document on every keystroke; most of those
    // posts said nothing new.
    if (!opts.force && signature === this.lastFocusSignature) {
      // The block is unchanged, so the panel does not need re-rendering — but
      // the cursor may still have moved inside it, and the marker has to
      // follow. A full focus post here would put the whole file back on the
      // wire on every keystroke, which is what the signature exists to stop.
      const cursorLine = editor.selection.active.line + 1;
      if (cursorLine !== this.lastCursorLine) {
        this.lastCursorLine = cursorLine;
        this.post({ type: "cursor", cursorLine });
      }
      return;
    }
    this.lastCursorLine = editor.selection.active.line + 1;
    this.lastFocusSignature = signature;

    this.lastFocus = focus;
    // Display only: the panel's "Whole file" toggle renders this, and the
    // webview is in the editor. It must never become a request payload —
    // `auditRegressions` asserts that it does not.
    this.panelFullCode = doc.getText();
    // No cursor line: the conversation is about the block, not about a line.
    this.lastDigest = digestFor(doc, focus, undefined, this.lastLanguageId);
    // The ladder is per problem, and a different function is a different
    // problem — being stuck on `main` should not start at hint 3 because you
    // were stuck on `parse` a minute ago.
    //
    // A positional label changes every time the cursor moves, which would make
    // every ask a brand-new problem and pin the ladder at hint 1. Only a named
    // block is stable enough to key on.
    this.lastDocumentKey =
      focus.kind === "symbol" || focus.kind === "heuristic"
        ? `${doc.uri.toString()}#${focus.label}`
        : doc.uri.toString();

    // The conversation follows named blocks only — see the doc comment on
    // `threadKey`. A selection or a click on a blank line does not move it.
    const previousThreadKey = this.threadKey;
    const fileKey = doc.uri.toString();
    // `threadBlockCode` is the text of whatever block the key names, on every
    // branch below — never the focus's text when the two have come apart.
    if (focus.kind === "symbol" || focus.kind === "heuristic") {
      this.threadKey = this.lastDocumentKey;
      this.threadBlockCode = focusCode;
    } else if (this.threadKey !== fileKey && !this.threadKey.startsWith(`${fileKey}#`)) {
      // `threadKey` has never been set for this document (a fresh provider,
      // or the student just switched files): fall back to the file-level key
      // so there is always a valid thread, rather than keep whatever
      // function's key was left over from a different document.
      this.threadKey = fileKey;
      this.threadBlockCode = focusCode;
    } else {
      // The focus collapsed to a selection or a bare window while the
      // conversation stayed put. Re-resolve at the naked cursor to get the
      // block the key actually names, as it stands right now. Reading the
      // collapsed focus here is what made selecting two lines look like the
      // function had been replaced by them; snapshotting instead would hide a
      // genuine edit made while the selection is live, and that edit is
      // exactly what the tutor needs to answer "I tried that" against.
      const at = editor.selection.active;
      const blockFocus = await resolveFocus(doc, new vscode.Selection(at, at));
      this.threadBlockCode = focusText(doc, blockFocus);
    }
    // A different function is a different conversation. Swap the transcript
    // so the student is never reading one function's thread beside another
    // function's hint level — unless an answer is still streaming in, in
    // which case the swap is deferred to `handleAsk`'s `finally` block, once
    // the ask settles, so the panel is never wiped out from under a student
    // watching it arrive.
    if (this.threadKey !== previousThreadKey) {
      if (this.askInFlight) {
        this.pendingThreadSwap = true;
      } else {
        this.postThread(this.threadKey);
      }
    }

    this.post({
      type: "focus",
      focusCode,
      breadcrumb: focus.breadcrumb,
      startLine: focus.startLine + 1,
      endLine: focus.endLine + 1,
      cursorLine: editor.selection.active.line + 1,
      fileName: doc.fileName,
      language: isSupportedLanguage(languageId) ? languageLabel(languageId) : "",
      totalLines: doc.lineCount,
    });
  }

  /** Coalesce the keystroke storm into one resolve. */
  private scheduleFocus() {
    if (this.focusDebounce) clearTimeout(this.focusDebounce);
    this.focusDebounce = setTimeout(() => {
      void this.sendFocus();
    }, 150);
  }

  private async sendBadges() {
    const badges = await this.firebase.getBadges();
    this.post({ type: "badges", badges });
  }

  private postAuthState(): void {
    const s = this.auth.getSession();
    const signedIn = !!s && !s.isAnonymous;
    const label = signedIn ? (s!.displayName || s!.email || s!.uid) : "Not signed in";
    this.post({
      type: "authState",
      signedIn,
      label,
      // The header no longer has room to spell an address out, so the avatar
      // carries initials and the popover carries the address itself.
      email: signedIn ? (s!.email ?? "") : "",
      initials: signedIn ? accountInitials(label) : "",
    });
  }

  /**
   * Mirror the settings the popover renders as live controls.
   *
   * Only the four the panel can sensibly own. `backendUrl` is deliberately
   * absent: it is a URL, and a 268px popover is not where anyone should be
   * typing one — the popover links out to the Settings UI for it instead.
   */
  private postPreferences(): void {
    const cfg = vscode.workspace.getConfiguration("edupeer");
    this.post({
      type: "preferences",
      values: {
        inlineHints: cfg.get<boolean>("inlineHints", true),
        autoScan: cfg.get<boolean>("autoScan", true),
        // "all" is the pre-1.7 value and migrates on read, here as in
        // inlineTutor, so the popover never shows a segment that no longer
        // exists to a student who has not changed the setting since.
        lensMode: cfg.get<string>("lensMode", "top8") === "flagged" ? "flagged" : "top8",
        debounceMs: cfg.get<number>("debounceMs", 1800),
        removeFixedBugComments: cfg.get<boolean>("removeFixedBugComments", true),
      },
      backendUrl: cfg.get<string>("backendUrl", ""),
    });
  }

  /**
   * Apply one preference from the popover.
   *
   * Written to Global rather than Workspace: a student's tolerance for inline
   * hints is a property of the student, not of the folder they happen to have
   * open. Unknown keys are dropped rather than written — the webview is the
   * least trusted thing that talks to this class, and `update()` will happily
   * create a setting that no `package.json` declares.
   */
  private async setPreference(key: unknown, value: unknown): Promise<void> {
    if (typeof key !== "string" || !WRITABLE_PREFERENCES.has(key)) return;
    if (key === "debounceMs") {
      const n = Number(value);
      // Floored to match the `minimum` in package.json and the second floor
      // inlineTutor applies; a popover stepper should not be the one way to
      // get underneath both.
      if (!Number.isFinite(n)) return;
      value = Math.max(MIN_DEBOUNCE_MS, Math.round(n));
    }
    if (key === "lensMode" && value !== "top8" && value !== "flagged") return;
    await vscode.workspace
      .getConfiguration("edupeer")
      .update(key, value, vscode.ConfigurationTarget.Global);
  }

  /**
   * Post the thread for `key` and remember it as what the webview is showing.
   *
   * Every paused exercise goes with it. `restoreChat` tears the panel down to
   * the new thread's bubbles, so the card and the buttons each of these was
   * waiting on are gone from the screen — but the host went on holding the
   * ask behind them. The student's next question was then popped off as an
   * answer to a prompt they could no longer see, about a different function:
   * consumed as an explanation, never answered, and filed into the wrong
   * transcript. The webview clears its half (`composerMode`) on the same
   * message.
   */
  private postThread(key: string): void {
    this.renderedKey = key;
    this.pendingAsk = undefined;
    this.pendingPredict = undefined;
    this.pendingTrace = undefined;
    this.pendingReview = undefined;
    this.post({ type: "restoreChat", messages: this.threadFor(key).bubbles });
  }

  private post(msg: any) {
    this.view?.webview.postMessage(msg);
  }

  private getHtml(webview: vscode.Webview): string {
    const asset = (name: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", name));
    const nonce = getNonce();
    const csp = `default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <link rel="stylesheet" href="${asset("style.css")}" />
  <title>EduPeer</title>
</head>
<body>
  <!-- Two tiers, stacked in severity order and never merged: offline is
       amber and transient, a broken sign-in is danger and needs the student
       to do something. One role="status" wrapper, so two arriving at once is
       one announcement rather than two interruptions. -->
  <div class="banners" id="banners" role="status" aria-live="polite">
    <div id="offlineBanner" class="banner banner--warn" hidden>
      <span class="banner__dot" aria-hidden="true"></span>
      <span class="banner__text">Can't reach the tutor server. Retrying — hints are local for now.</span>
      <button class="banner__action" id="offlineRetry">Retry</button>
    </div>

    <div id="authBanner" class="banner banner--danger" hidden>
      <span class="banner__dot banner__dot--square" aria-hidden="true"></span>
      <span class="banner__text">Your sign-in is broken. Your streak and badges won't save until you sign in again.</span>
      <button class="banner__action" id="authFix">Fix it</button>
    </div>
  </div>

  <header class="topbar">
    <div class="topbar__row">
      <span class="brand">
        <span class="brand__mark" aria-hidden="true"></span>
        <span class="brand__name">EduPeer</span>
      </span>
      <span class="topbar__spacer"></span>
      <button id="accountBtn" class="avatar" aria-haspopup="dialog" aria-expanded="false"
              aria-controls="prefsPop" title="Account and preferences">
        <svg class="avatar__ring" viewBox="0 0 26 26" aria-hidden="true" focusable="false">
          <circle class="avatar__arc" cx="13" cy="13" r="12" stroke-dashoffset="0"></circle>
          <circle class="avatar__arc" cx="13" cy="13" r="12" stroke-dashoffset="-20.42"></circle>
          <circle class="avatar__arc" cx="13" cy="13" r="12" stroke-dashoffset="-40.84"></circle>
          <circle class="avatar__arc" cx="13" cy="13" r="12" stroke-dashoffset="-61.26"></circle>
        </svg>
        <span class="avatar__face" id="accountInitials" aria-hidden="true">?</span>
        <span class="avatar__pip" id="accountPip" aria-hidden="true"></span>
      </button>
    </div>

    <div class="pop" id="prefsPop" role="dialog" aria-label="Account and preferences" hidden>
      <div class="pop__id">
        <span class="pop__idtext">
          <span class="pop__name" id="popName">Working anonymously</span>
          <span class="pop__mail" id="popMail">Your streak and badges live on this machine only.</span>
        </span>
      </div>
      <div class="pop__signin" id="popSignInWrap">
        <button id="signInBtn" class="btn btn--primary btn--block">Sign in to keep your progress</button>
      </div>

      <div class="pop__group" role="group" aria-label="How the tutor behaves">
        <div class="pop__title">How the tutor behaves</div>
        <button class="row" role="switch" aria-checked="true" data-pref="inlineHints">
          <span class="row__label">Hints in the editor
            <span class="row__sub">Lightbulbs, underlines and ghost text</span>
          </span>
          <span class="tog" aria-hidden="true"><i></i></span>
        </button>
        <button class="row" role="switch" aria-checked="true" data-pref="autoScan">
          <span class="row__label">Scan the block as I type
            <span class="row__sub">Flags suspicious lines without being asked</span>
          </span>
          <span class="tog" aria-hidden="true"><i></i></span>
        </button>
        <button class="row" data-pref="lensMode">
          <span class="row__label">Ask-anywhere lenses
            <span class="row__sub">Top 8 by size, never one per definition</span>
          </span>
          <span class="seg" id="lensSeg" aria-hidden="true">
            <span data-value="top8">top 8</span><span data-value="flagged">flagged</span>
          </span>
        </button>
        <div class="row row--static">
          <span class="row__label" id="debounceLabel">Wait before hinting</span>
          <span class="step" role="group" aria-labelledby="debounceLabel">
            <button class="step__btn" id="debounceDown" aria-label="Wait less before hinting">−</button>
            <b id="debounceValue">1800 ms</b>
            <button class="step__btn" id="debounceUp" aria-label="Wait longer before hinting">+</button>
          </span>
        </div>
        <button class="row" role="switch" aria-checked="true" data-pref="removeFixedBugComments">
          <span class="row__label">Delete <code>bug:</code> comments once fixed
            <span class="row__sub">The only edit EduPeer makes to your file</span>
          </span>
          <span class="tog" aria-hidden="true"><i></i></span>
        </button>
      </div>

      <div class="pop__group">
        <button class="row" id="popProgress"><span class="row__label">My progress</span><span class="row__chev" aria-hidden="true">›</span></button>
        <button class="row" id="popGoal"><span class="row__label">Set a learning goal</span><span class="row__chev" aria-hidden="true">›</span></button>
        <button class="row" id="popSettings">
          <span class="row__label">Where EduPeer connects<span class="row__sub" id="popBackend"></span></span>
          <span class="row__chev" aria-hidden="true">↗</span>
        </button>
      </div>

      <div class="pop__group">
        <button class="row row--danger" id="popReset"><span class="row__label">Start a fresh session</span><span class="row__chev" aria-hidden="true">›</span></button>
        <button class="row" id="signOutBtn" hidden><span class="row__label">Sign out</span></button>
      </div>

      <div class="confirm" id="resetConfirm" hidden>
        <p><strong>Start a fresh session?</strong> This clears every conversation and takes you back to hint 1. Your badges and streak stay.</p>
        <div>
          <button class="btn btn--danger btn--sm" id="resetGo">Start fresh</button>
          <button class="btn btn--ghost btn--sm" id="resetCancel">Keep going</button>
        </div>
      </div>
    </div>
  </header>

  <!-- One row that answers "what is EduPeer looking at" — file, symbol, line
       range, language — because that is the question the editor eight pixels
       away cannot answer. The preview itself is a disclosure, collapsed by
       default: a second copy of code the student is already looking at does
       not earn 18vh of a 320px panel. -->
  <section class="ctx">
    <div class="ctx__bar">
      <button class="ctx__row" id="collapseCode" aria-expanded="false" aria-controls="ctxCode"
              title="Show or hide the code preview" disabled>
        <span class="ctx__dot" id="ctxDot" aria-hidden="true"></span>
        <span class="ctx__file" id="fileName">no file open</span>
        <span class="ctx__sep" id="ctxSep" aria-hidden="true" hidden>›</span>
        <span class="ctx__symbol" id="ctxSymbol"></span>
        <span id="focusRange" class="ctx__range"></span>
        <span id="langChip" class="chip" hidden></span>
        <span class="ctx__chev" aria-hidden="true">⌄</span>
      </button>
      <button id="ctxOpen" class="btn btn--ghost btn--sm">Open a file</button>
      <button id="reviewBtn" class="btn btn--accent btn--sm" hidden title="A spaced-review exercise is ready">Review</button>
    </div>
    <div class="ctx__code" id="ctxCode" hidden>
      <pre id="codeSnippet" class="ctx__pre" tabindex="0"></pre>
      <div class="ctx__foot" id="scopeRow">
        <span class="ctx__more" id="ctxMore"></span>
        <span class="topbar__spacer"></span>
        <button id="scopeToggle" class="btn btn--ghost btn--sm" aria-pressed="false" hidden>Whole file</button>
        <button id="refreshCode" class="btn btn--ghost btn--sm" title="Re-read the active file">Refresh</button>
      </div>
    </div>
  </section>

  <section class="chat" id="chat" role="log" aria-live="polite" aria-label="Tutor conversation"></section>

  <div class="thinking" id="loading" hidden>
    <span class="thinking__dots" aria-hidden="true"><i></i><i></i><i></i></span>
    <span>EduPeer is thinking…</span>
  </div>

  <footer class="composer">
    <!-- The strip names how the next submission will be read, and carries the
         way out. It is always rendered, including in the default mode, because
         it is teaching a mechanic the student has to be able to trust. -->
    <div class="mode" id="modeStrip">
      <span class="mode__arrow" aria-hidden="true">↳</span>
      <span class="mode__label" id="modeLabel">sent as a question</span>
      <button class="mode__exit" id="modeExit" hidden>back to a question ✕</button>
    </div>
    <label class="visually-hidden" for="input">Your question</label>
    <textarea id="input" rows="3" aria-describedby="modeLabel" placeholder="What's going wrong?"></textarea>
    <div class="composer__actions">
      <button id="send" class="btn btn--primary">Ask<span class="btn__hint">↵</span></button>
      <button id="quiz" class="btn btn--ghost" title="Answer one question about why your fix works">Quiz me</button>
      <button id="reset" class="btn btn--ghost" title="Clear the conversation and start at hint 1">Reset</button>
    </div>
    <span class="visually-hidden" id="modeStatus" role="status" aria-live="polite"></span>
  </footer>

  <!-- Gamification lives here, under the composer: last in reading order
       rather than above a tutor that has not spoken yet, but permanently
       visible, which the collapsed <details> in the top bar never was. -->
  <footer class="ledger">
    <span class="ledger__streak" id="streakChip" hidden>streak <span id="streakDays">0</span></span>
    <span class="ledger__dot" id="ledgerSep" aria-hidden="true" hidden>·</span>
    <button class="ledger__badges" id="badgesWrap" aria-expanded="false" aria-controls="badgesSheet" disabled>
      <span id="badgeCount">No badges yet</span>
    </button>
    <span class="topbar__spacer"></span>
    <button class="ledger__link" id="ledgerProgress">progress ›</button>
  </footer>

  <!-- Over the chat, not pushing it down: opening the badge list must not
       move the conversation the student is reading. -->
  <div class="sheet" id="badgesSheet" role="dialog" aria-label="Badges" hidden>
    <div class="sheet__head">
      <span class="sheet__title">Badges</span>
      <button class="sheet__close" id="badgesClose" aria-label="Close badges">✕</button>
    </div>
    <div class="badges__list" id="badges" role="list"></div>
  </div>

  <script nonce="${nonce}" src="${asset("markdown.js")}"></script>
  <script nonce="${nonce}" src="${asset("main.js")}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  return crypto.randomBytes(24).toString("base64");
}

/** The settings the popover may write. Anything else the webview asks for is
 *  dropped — `update()` creates undeclared keys without complaint. */
const WRITABLE_PREFERENCES = new Set([
  "inlineHints",
  "autoScan",
  "lensMode",
  "debounceMs",
  "removeFixedBugComments",
]);

/** Matches the `minimum` in package.json and inlineTutor's own floor. */
const MIN_DEBOUNCE_MS = 600;

/**
 * One or two letters for the avatar.
 *
 * Two initials when the label reads like a name, one when it is an address or
 * a bare uid. Deliberately not clever about it: a student called "de la Cruz"
 * getting "DL" is a smaller failure than a regex that returns nothing at all,
 * and the full label is one hover away in the popover.
 */
export function accountInitials(label: string): string {
  const trimmed = (label || "").trim();
  if (!trimmed) return "";
  // An address has no meaningful second word — "ahmed@karzo.com" would give
  // "AK", initials for a domain the student does not think of as their name.
  const source = trimmed.includes("@") ? trimmed.split("@")[0] : trimmed;
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  const letters = parts
    .map((p) => p.match(/[\p{L}\p{N}]/u)?.[0] ?? "")
    .filter(Boolean);
  if (!letters.length) return "";
  return (letters.length > 1 ? letters[0] + letters[letters.length - 1] : letters[0])
    .toLocaleUpperCase();
}
