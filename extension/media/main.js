(function () {
  const vscode = acquireVsCodeApi();

  const el = (id) => document.getElementById(id);
  const chatEl = el("chat");
  const inputEl = el("input");
  const sendBtn = el("send");
  const quizBtn = el("quiz");
  const resetBtn = el("reset");
  const refreshBtn = el("refreshCode");
  const collapseBtn = el("collapseCode");
  const codeEl = el("codeSnippet");
  const fileNameEl = el("fileName");
  const langChipEl = el("langChip");
  const loadingEl = el("loading");
  const badgesEl = el("badges");
  const badgeCountEl = el("badgeCount");
  const badgesWrapEl = el("badgesWrap");
  const accountBtn = el("accountBtn");
  const accountInitialsEl = el("accountInitials");
  const accountPipEl = el("accountPip");
  const prefsPop = el("prefsPop");
  const popNameEl = el("popName");
  const popMailEl = el("popMail");
  const popSignInWrap = el("popSignInWrap");
  const signInBtn = el("signInBtn");
  const signOutBtn = el("signOutBtn");
  const lensSegEl = el("lensSeg");
  const debounceValueEl = el("debounceValue");
  const popBackendEl = el("popBackend");
  const resetConfirmEl = el("resetConfirm");
  const streakChipEl = el("streakChip");
  const streakDaysEl = el("streakDays");
  const ledgerSepEl = el("ledgerSep");
  const ledgerProgressEl = el("ledgerProgress");
  const badgesSheetEl = el("badgesSheet");
  const badgesCloseEl = el("badgesClose");
  const reviewBtn = el("reviewBtn");
  const offlineBannerEl = el("offlineBanner");
  const authBannerEl = el("authBanner");
  const offlineRetryEl = el("offlineRetry");
  const authFixEl = el("authFix");
  const ctxDotEl = el("ctxDot");
  const ctxSepEl = el("ctxSep");
  const ctxSymbolEl = el("ctxSymbol");
  const ctxCodeEl = el("ctxCode");
  const ctxMoreEl = el("ctxMore");
  const ctxOpenEl = el("ctxOpen");
  const composerEl = document.querySelector(".composer");
  const modeStripEl = el("modeStrip");
  const modeLabelEl = el("modeLabel");
  const modeExitEl = el("modeExit");
  const modeStatusEl = el("modeStatus");

  const MAX_PREVIEW_LINES = 200;

  /**
   * Everything that changes with the composer mode, in one table.
   *
   * The strip label, the placeholder and the button verb used to be passed
   * separately at each of eleven call sites, which is how the placeholder
   * came to say "describe your error" while the mode was `translate`. They
   * cannot drift now because they are one row.
   *
   * `tone` defaults to "show": in every mode except the default the student
   * is producing material rather than asking for it, which is why those modes
   * wear mint rather than coral.
   */
  const COMPOSER = {
    hint: {
      strip: "sent as a question",
      verb: "Ask",
      ph: "What's going wrong?",
      tone: "ask",
    },
    translate: {
      strip: "read as a translation",
      verb: "Submit translation",
      ph: "Write the pseudocode from rung 3 as real code…",
    },
    explain: {
      strip: "read as your explanation",
      verb: "Submit",
      ph: "Say what you think this code does…",
    },
    predict: {
      strip: "read as a prediction",
      verb: "Submit prediction",
      ph: "What do you expect this to print?",
    },
    reflect: {
      strip: "read as a quiz answer",
      verb: "Submit answer",
      ph: "Answer the question above…",
    },
    "subgoal-label": {
      strip: "read as step labels",
      verb: "Submit labels",
      ph: "What does each numbered step accomplish?",
    },
    review: {
      strip: "read as review work",
      verb: "Submit review",
      ph: "Write your code and what you expect it to do…",
    },
  };

  /** Eyebrow text per tutor move: what the tutor is doing, in two words. */
  const MODE_LABEL = {
    // Hint cards used to carry no eyebrow, because the old ladder label read
    // "hint 2" right beside where "hint" would have gone. The meter that
    // replaced it reads out a depth, not a mode, so the two no longer say the
    // same thing and the stance is worth naming.
    hint: "Asking",
    reflect: "Reflection",
    translate: "Translation check",
    "worked-example": "Worked example",
    "explain-error": "Reading the error",
    "explain-concept": "Concept",
    "predict-output": "Prediction check",
    "review-exercise": "Review",
    "subgoal-label": "Step labels",
    "trace-check": "Trace check",
    answer: "Answer",
    "attempt-gate": "Same depth",
    "rate-limited": "Slow down",
    offline: "Offline nudge",
    waking: "Waking the server",
  };

  /** Modes that are the tutor withholding rather than teaching. */
  const FLAGGED_MODES = new Set(["attempt-gate", "rate-limited", "offline", "waking"]);

  /**
   * The stance each mode takes, which is what decides how its card is drawn.
   *
   * Fifteen modes, four families. The axis is the tutor's stance — is it
   * asking, showing, telling, or refusing? — because that is the axis the
   * product is about. A new mode picks a family and inherits a treatment
   * instead of inventing a sixteenth one, so mode-specific *text* stays a
   * table (MODE_LABEL above) and mode-specific *styling* stops existing.
   *
   * Family D is not listed: FLAGGED_MODES already is that set, and having it
   * twice is how the two would drift apart.
   */
  const FAMILY = {
    // A — asking. The body is a question and ends in a question mark.
    hint: "ask",
    reflect: "ask",
    "predict-output": "ask",
    "trace-check": "ask",
    "review-exercise": "ask",
    // B — showing. This family owns the code block, the numbered list and the
    // trace grid: the only places the tutor puts material on screen.
    "worked-example": "show",
    translate: "show",
    "subgoal-label": "show",
    "explain-concept": "show",
    "explain-error": "show",
    // C — telling. One mode, and the end of a thread by construction.
    answer: "tell",
  };

  function familyFor(mode) {
    if (FLAGGED_MODES.has(mode)) return "withhold";
    return FAMILY[mode] || "ask";
  }

  /** Modes that occupy a rung on the hint ladder, so the card shows its depth. */
  const LADDER_MODES = new Set(["hint", "worked-example"]);

  const MAX_LEVEL = 4;
  /** Steps the "wait before hinting" stepper moves in, and its floor. Both are
   *  re-applied in the extension host; these only keep the UI honest. */
  const DEBOUNCE_STEP = 200;
  const DEBOUNCE_MIN = 600;
  const DEBOUNCE_MAX = 5000;

  let currentCode = "";
  /** The symbol the context strip is currently naming, for the empty state. */
  let focusSymbol = "";
  /** Sign-in is failing. Outlives the banner, on the avatar pip. */
  let authBroken = false;
  let signedIn = false;
  /** The rung the current thread has reached, mirrored onto the avatar ring.
   *  It is the only always-visible readout of the thing EduPeer is about. */
  let currentLevel = 0;
  /** Last values posted by the host. The popover renders from these rather
   *  than from its own DOM, so a setting changed elsewhere repaints it. */
  let prefs = {};
  // What the next composer submission means.
  let composerMode = "hint";
  let expectReflectAnswer = false;
  // Set when the student starts a review, so an unsolicited review-exercise
  // bubble (e.g. restored from history) does not hijack the composer.
  let expectReviewAnswer = false;
  let streamingTurn = null;
  // True while an ask is in flight. Only the send button was disabled before,
  // so Ctrl+Enter and the mode buttons could start a second stream whose
  // deltas landed in the first one's bubble.
  let isLoading = false;
  // Rendered turns, mirrored to the extension so they survive a reload.
  let turns = [];
  // True only while "restoreChat" is rebuilding a saved transcript — lets
  // buildTurn() mark those turns so their entrance (and every meter's grow)
  // don't all fire at once. See buildTurn() and the "restoreChat" case below.
  let isRestoring = false;

  // ------------------------------------------------------------------ chat

  function persist() {
    vscode.setState({ turns });
    vscode.postMessage({ type: "persistChat", messages: turns });
  }

  function clearChat() {
    while (chatEl.firstChild) chatEl.removeChild(chatEl.firstChild);
  }

  function showEmptyState() {
    clearChat();
    const wrap = document.createElement("div");
    wrap.className = "empty";
    const title = document.createElement("strong");
    title.textContent = "Stuck on something?";
    const head = document.createElement("div");
    head.className = "empty__head";
    head.appendChild(title);
    const sub = document.createElement("p");
    sub.className = "empty__sub";
    sub.textContent = focusSymbol
      ? `I'm looking at ${focusSymbol}. Tell me what's going wrong.`
      : "Tell me what's going wrong. I answer with a question, so you keep the part where you work it out.";
    head.appendChild(sub);
    wrap.appendChild(head);

    // The contract, stated before it is experienced. A student who does not
    // know the tutor answers questions with questions reads the first reply
    // as a failure rather than as the mechanic.
    const rules = document.createElement("ol");
    rules.className = "empty__rules";
    for (const text of [
      "You get a question back, never working code.",
      "Four rungs of depth. Each one is spent by trying, not by asking twice.",
      "Rung four is a worked example \u2014 the deepest help there is.",
    ]) {
      const rule = document.createElement("li");
      rule.textContent = text;
      rules.appendChild(rule);
    }
    wrap.appendChild(rules);
    wrap.appendChild(buildStarters());

    chatEl.appendChild(wrap);
  }

  /**
   * Three ways in, so the student picks a move instead of guessing a sentence.
   *
   * Each chip runs what its command already runs. The first has no command
   * because the composer *is* the affordance for it: pasting an error is the
   * panel's default mode, and the chip just puts the cursor there.
   */
  function buildStarters() {
    const starts = document.createElement("div");
    starts.className = "empty__starts";
    const label = document.createElement("div");
    label.className = "empty__label";
    label.textContent = "Start with";
    starts.appendChild(label);

    const row = document.createElement("div");
    row.className = "empty__chips";
    const chips = [
      ["Paste an error", () => { setComposerMode("hint"); inputEl.focus(); }],
      ["Predict the output", () => vscode.postMessage({ type: "startPredict" })],
      ["Trace it by hand", () => vscode.postMessage({ type: "startTrace" })],
    ];
    for (const [text, onClick] of chips) {
      const chip = document.createElement("button");
      chip.className = "chip chip--action";
      chip.textContent = text;
      chip.addEventListener("click", onClick);
      row.appendChild(chip);
    }
    starts.appendChild(row);
    return starts;
  }

  /** Remove whichever placeholder is showing — the empty state or the sign-in card. */
  function dropPlaceholder() {
    const placeholder = chatEl.querySelector(".empty, .signin");
    if (placeholder) placeholder.remove();
  }

  /**
   * The signed-out invitation. Same words as the sign-in page, because this is
   * the click that opens it — but the panel's own theme colours, since the
   * webview follows the workbench and the hosted page does not.
   */
  function showSignInState() {
    clearChat();
    const wrap = document.createElement("div");
    wrap.className = "signin";
    const title = document.createElement("strong");
    title.textContent = "Ready to get unstuck?";
    const sub = document.createElement("p");
    sub.textContent = "Sign in to keep your hints, badges and progress.";
    const button = document.createElement("button");
    button.className = "btn btn--primary";
    button.textContent = "Sign in";
    button.addEventListener("click", () => vscode.postMessage({ type: "signIn" }));
    wrap.appendChild(title);
    wrap.appendChild(sub);
    wrap.appendChild(button);
    // The chips stay: what a signed-out student can do is unchanged, and
    // hiding them would make signing in look like a precondition for asking.
    wrap.appendChild(buildStarters());
    chatEl.appendChild(wrap);
  }

  /** Only swap the placeholder — never a conversation the student is reading. */
  function refreshPlaceholder() {
    if (turns.length) return;
    if (signedIn) showEmptyState();
    else showSignInState();
  }

  /**
   * The rung meter: four bars of increasing height, spent up to `level`.
   *
   * Height is depth, so how far in the student is reads without counting.
   * The next bar is outlined rather than filled, which is what "the next rung
   * costs something" looks like, and the fourth stays dashed until it is
   * reached because rung 4 is a worked example — a different kind of help,
   * not simply more of it.
   */
  function buildRungMeter(level, held) {
    const meter = document.createElement("div");
    meter.className = held ? "rung is-held" : "rung";

    const bars = document.createElement("span");
    bars.className = "rung__bars";
    bars.setAttribute("aria-hidden", "true");
    for (let i = 1; i <= MAX_LEVEL; i++) {
      const bar = document.createElement("span");
      bar.className = "rung__bar";
      bar.dataset.rung = String(i);
      if (i <= level) bar.classList.add("is-spent");
      if (i === level) bar.classList.add("is-current");
      if (i === level + 1) bar.classList.add("is-next");
      if (i === MAX_LEVEL) bar.classList.add("is-final");
      bars.appendChild(bar);
    }
    meter.appendChild(bars);

    // Two visible readings, one for each width the panel is actually used at.
    // Both are hidden from assistive tech: the sentence below is what gets
    // announced, so the depth is stated once rather than token by token.
    const read = document.createElement("span");
    read.className = "rung__read";
    read.setAttribute("aria-hidden", "true");
    read.textContent = rungRead(level, held);
    meter.appendChild(read);

    const short = document.createElement("span");
    short.className = "rung__short";
    short.setAttribute("aria-hidden", "true");
    short.textContent = held ? `still ${level}/${MAX_LEVEL}` : `${level}/${MAX_LEVEL}`;
    meter.appendChild(short);

    const spoken = document.createElement("span");
    spoken.className = "visually-hidden";
    spoken.textContent = rungLabel(level, held);
    meter.appendChild(spoken);

    return meter;
  }

  /** The visible line beside the bars, at any width above 220px. */
  function rungRead(level, held) {
    if (held) return `rung ${level} of ${MAX_LEVEL} · held`;
    if (level >= MAX_LEVEL) return "deepest help — no rung 5";
    return `rung ${level} of ${MAX_LEVEL} · next costs an attempt`;
  }

  /**
   * What a screen reader hears: one sentence, so the meter is announced as a
   * fact about depth rather than as four unlabelled graphics.
   */
  function rungLabel(level, held) {
    const parts = [`Hint depth: rung ${level} of ${MAX_LEVEL}.`];
    if (level >= MAX_LEVEL) {
      parts.push("This is the worked example — the deepest help there is.");
    } else {
      const left = MAX_LEVEL - 1 - level;
      if (left === 0) parts.push("The next rung is the worked example.");
      else if (left === 1) parts.push("One rung remains before the worked example.");
      else parts.push(`${left} rungs remain before the worked example.`);
      parts.push("The next rung costs an attempt.");
    }
    if (held) {
      parts.push(
        `Held at rung ${level} — edit your code or explain your reasoning to go deeper.`
      );
    }
    return parts.join(" ");
  }

  function buildTurn(turn) {
    dropPlaceholder();
    const wrap = document.createElement("div");
    wrap.className = `turn turn--${turn.role === "student" ? "student" : "tutor"}`;
    if (turn.role === "error") wrap.classList.add("is-error");
    // One class per family. `turn.flagged` is the pre-1.7 shape: a transcript
    // persisted by an older build restores through this fallback rather than
    // coming back unclassified.
    else if (turn.role !== "student") {
      wrap.classList.add(`turn--${turn.family || (turn.flagged ? "withhold" : "ask")}`);
    }
    // A restored transcript rebuilds every turn in one pass; without this,
    // N cards would fire their entrance and every meter its grow, all at
    // once. Live turns are unaffected — isRestoring is only ever true while
    // the "restoreChat" handler below is looping.
    if (isRestoring) wrap.classList.add("is-restored");

    // The eyebrow and the meter share one head row, so what the tutor is
    // doing and how deep it is sit on the same line. The depth belongs with
    // the hint it describes; it used to be pinned above the composer,
    // describing a hint that could be several turns up.
    if (turn.eyebrow || turn.level >= 1) {
      const head = document.createElement("div");
      head.className = "turn__head";
      if (turn.eyebrow) {
        const eyebrow = document.createElement("div");
        eyebrow.className = "turn__eyebrow";
        eyebrow.textContent = turn.eyebrow;
        head.appendChild(eyebrow);
      }
      if (turn.level >= 1) head.appendChild(buildRungMeter(turn.level, !!turn.held));
      wrap.appendChild(head);
    }

    const body = document.createElement("div");
    body.className = "turn__body";
    if (turn.role === "student") {
      body.textContent = turn.text;
    } else {
      window.renderMarkdown(turn.text, body);
    }
    wrap.appendChild(body);

    if (turn.tags && turn.tags.length) {
      const tags = document.createElement("div");
      tags.className = "tags";
      for (const name of turn.tags) {
        const tag = document.createElement("span");
        tag.className = "tag";
        tag.textContent = name;
        tags.appendChild(tag);
      }
      wrap.appendChild(tags);
    }

    chatEl.appendChild(wrap);
    scrollToEnd();
    return { wrap, body };
  }

  function addTurn(turn) {
    const nodes = buildTurn(turn);
    turns.push(turn);
    persist();
    return nodes;
  }

  function scrollToEnd() {
    chatEl.scrollTop = chatEl.scrollHeight;
  }

  function removeStreamingTurn() {
    if (streamingTurn) {
      streamingTurn.wrap.remove();
      streamingTurn = null;
    }
  }

  function removeActionRows() {
    chatEl.querySelectorAll(".actions").forEach((row) => row.remove());
  }

  /**
   * Buttons that act on the card above them — "Submit my translation",
   * "Label the steps".
   *
   * They go *inside* that card. As a sibling with a left pad they sat between
   * the card and the composer and read as belonging to the composer, and a
   * screen reader reached them after the card had already been left. Inside,
   * they are in reading order and visibly attached to the thing they act on.
   */
  function addActionRow(buttons) {
    const row = document.createElement("div");
    row.className = "actions";
    for (const { label, onClick } of buttons) {
      const btn = document.createElement("button");
      btn.className = "btn btn--ghost btn--sm";
      btn.textContent = label;
      btn.addEventListener("click", () => {
        row.remove();
        onClick();
      });
      row.appendChild(btn);
    }
    const cards = chatEl.querySelectorAll(".turn--tutor");
    (cards[cards.length - 1] || chatEl).appendChild(row);
    scrollToEnd();
  }

  // ---------------------------------------------------------------- badges

  /**
   * The badge count in the ledger, and the sheet behind it.
   *
   * The count is always on screen, including at zero. As a collapsed
   * <details> above a tutor that had not spoken yet, it was the first thing
   * in reading order and visible none of the time; here it is the last thing
   * and visible all of it. The list opens over the chat rather than pushing
   * it down, so opening it never moves the conversation being read.
   */
  function renderBadges(list) {
    while (badgesEl.firstChild) badgesEl.removeChild(badgesEl.firstChild);
    const items = list || [];
    badgeCountEl.textContent = items.length
      ? `${items.length} badge${items.length === 1 ? "" : "s"}`
      : "No badges yet";
    badgesWrapEl.disabled = items.length === 0;
    badgesWrapEl.setAttribute(
      "aria-label",
      items.length
        ? `${items.length} badge${items.length === 1 ? "" : "s"}, collapsed \u2014 expand to list them`
        : "No badges yet"
    );
    if (!items.length) closeBadges();
    for (const name of items) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.setAttribute("role", "listitem");
      badge.textContent = name;
      badgesEl.appendChild(badge);
    }
  }

  function openBadges() {
    badgesSheetEl.hidden = false;
    badgesWrapEl.setAttribute("aria-expanded", "true");
    badgesCloseEl.focus();
  }

  function closeBadges() {
    if (badgesSheetEl.hidden) return;
    badgesSheetEl.hidden = true;
    badgesWrapEl.setAttribute("aria-expanded", "false");
  }

  badgesWrapEl.addEventListener("click", () => {
    if (badgesSheetEl.hidden) openBadges();
    else {
      closeBadges();
      badgesWrapEl.focus();
    }
  });

  badgesCloseEl.addEventListener("click", () => {
    closeBadges();
    badgesWrapEl.focus();
  });

  ledgerProgressEl.addEventListener("click", () =>
    vscode.postMessage({ type: "showProgress" })
  );

  // ----------------------------------------------------------- code preview

  const focusRangeEl = el("focusRange");
  const scopeToggleEl = el("scopeToggle");

  /** The block every ask is about, whatever the preview happens to show. */
  let focusCode = "";
  let focusStartLine = 1;
  let cursorLine = 0;
  let showingWholeFile = false;

  function renderLines(code, firstLine, markLine) {
    while (codeEl.firstChild) codeEl.removeChild(codeEl.firstChild);
    if (!code) {
      // Nothing here says "no file open" any more: the context strip says it
      // once, in the component that can also offer to fix it. This one was
      // the second of the two, inside a disclosure that is closed and
      // disabled whenever it would have applied.
      ctxMoreEl.textContent = "";
      return;
    }
    const lines = code.split("\n");
    const shown = lines.slice(0, MAX_PREVIEW_LINES);
    shown.forEach((text, offset) => {
      const number = firstLine + offset;
      const row = document.createElement("span");
      row.className = number === markLine ? "ln is-cursor" : "ln";
      const gutter = document.createElement("span");
      gutter.className = "ln__no";
      gutter.textContent = String(number);
      const body = document.createElement("span");
      body.className = "ln__text";
      body.textContent = text || " ";
      row.appendChild(gutter);
      row.appendChild(body);
      codeEl.appendChild(row);
    });
    // The 200-line cap is a fact about the preview, not a line of code, so it
    // reads in the disclosure's footer beside the controls that act on it,
    // rather than as a fake last line of the file.
    const over = lines.length - shown.length;
    ctxMoreEl.textContent = over > 0 ? `${over} more lines` : "";
  }

  scopeToggleEl.addEventListener("click", () => {
    showingWholeFile = !showingWholeFile;
    scopeToggleEl.setAttribute("aria-pressed", String(showingWholeFile));
    scopeToggleEl.textContent = showingWholeFile ? "Just this block" : "Whole file";
    if (showingWholeFile) {
      vscode.postMessage({ type: "requestFullFile" });
    } else {
      renderLines(focusCode, focusStartLine, cursorLine);
    }
  });

  // The whole row is the disclosure. It starts closed: the editor is eight
  // pixels away, so a second copy of the same code does not earn 18vh of a
  // 320px panel by default. What the row does earn is the one thing the
  // editor cannot answer - which block EduPeer is actually looking at.
  collapseBtn.addEventListener("click", () => {
    setCtxOpen(ctxCodeEl.hidden);
  });

  function setCtxOpen(open) {
    ctxCodeEl.hidden = !open;
    collapseBtn.setAttribute("aria-expanded", String(open));
  }

  ctxOpenEl.addEventListener("click", () => vscode.postMessage({ type: "openFile" }));

  /**
   * Paint the context row from a focus message.
   *
   * The breadcrumb arrives as one string ("demo.py \u203a last_index"), but its
   * two halves truncate in opposite orders: the symbol is what the ask is
   * about, so it is the last thing to go, and one ellipsised string would
   * drop it first.
   */
  function paintContext(msg) {
    const hasFile = !!(msg.fileName || msg.breadcrumb);
    const crumb = msg.breadcrumb || (msg.fileName ? msg.fileName.split(/[\\/]/).pop() : "");
    const [file, ...rest] = crumb.split(" \u203a ");
    const symbol = rest.join(" \u203a ");

    fileNameEl.textContent = hasFile ? file : "no file open";
    fileNameEl.title = msg.fileName || "";
    ctxSymbolEl.textContent = symbol;
    ctxSepEl.hidden = !symbol;
    focusSymbol = symbol;
    ctxDotEl.classList.toggle("is-live", hasFile);
    // Nothing to disclose, and nothing to say about a file that is not there:
    // the strip states it once, in one component, and offers the fix. The
    // panel used to say it twice, in two.
    collapseBtn.disabled = !hasFile;
    ctxOpenEl.hidden = hasFile;
    if (!hasFile) setCtxOpen(false);

    focusRangeEl.textContent =
      msg.startLine && msg.endLine
        ? msg.startLine === msg.endLine
          ? `${msg.startLine}`
          : `${msg.startLine}\u2013${msg.endLine}`
        : "";
    langChipEl.textContent = msg.language || "";
    langChipEl.hidden = !msg.language;
  }

  // ---------------------------------------------------------- trace exercise

  function renderTraceExercise(msg) {
    dropPlaceholder();
    addTurn({
      role: "tutor",
      text: msg.prompt || "Work through this line by line and fill in each value.",
      eyebrow: "Trace it yourself",
    });

    const variables = msg.variables || [];
    const steps = Math.max(1, Number(msg.steps) || 1);

    const panel = document.createElement("div");
    panel.className = "trace";

    const hint = document.createElement("div");
    hint.className = "trace__prompt";
    hint.textContent = "Fill in each variable's value after every step. Leave a cell blank if you're unsure.";
    panel.appendChild(hint);

    const table = document.createElement("table");
    table.className = "trace__grid";

    const head = document.createElement("tr");
    const stepHead = document.createElement("th");
    stepHead.textContent = "#";
    head.appendChild(stepHead);
    for (const name of variables) {
      const th = document.createElement("th");
      th.textContent = name;
      head.appendChild(th);
    }
    table.appendChild(head);

    const inputs = [];
    for (let step = 0; step < steps; step++) {
      const row = document.createElement("tr");
      const label = document.createElement("td");
      label.className = "trace__step";
      label.textContent = String(step + 1);
      row.appendChild(label);

      const rowInputs = [];
      variables.forEach((name, column) => {
        const cell = document.createElement("td");
        const input = document.createElement("input");
        input.type = "text";
        input.className = "trace__cell";
        input.setAttribute("aria-label", `${name} after step ${step + 1}`);
        cell.appendChild(input);
        row.appendChild(cell);
        rowInputs[column] = input;
      });
      inputs.push(rowInputs);
      table.appendChild(row);
    }
    panel.appendChild(table);

    const submit = document.createElement("button");
    submit.className = "btn btn--primary";
    submit.textContent = "Check my trace";
    submit.addEventListener("click", () => {
      const rows = inputs.map((row) => row.map((input) => input.value));
      panel.remove();
      addTurn({ role: "student", text: "Here's my trace." });
      vscode.postMessage({ type: "traceAnswer", rows });
    });
    panel.appendChild(submit);

    chatEl.appendChild(panel);
    scrollToEnd();
  }

  // -------------------------------------------------------------- composer

  /**
   * Put the composer into a mode, and say so.
   *
   * One argument: the strip, the placeholder and the verb all come from the
   * COMPOSER row, so a call site cannot supply a placeholder that disagrees
   * with the mode it is setting.
   */
  function setComposerMode(mode) {
    const spec = COMPOSER[mode] || COMPOSER.hint;
    const changed = composerMode !== mode;
    composerMode = mode;

    inputEl.placeholder = spec.ph;
    modeLabelEl.textContent = spec.strip;
    sendBtn.firstChild.textContent = spec.verb;

    const producing = (spec.tone || "show") === "show";
    modeStripEl.classList.toggle("is-show", producing);
    // On the composer rather than on <body>: the two elements this recolours
    // are both inside it, and a class on <body> outlives a webview re-init.
    composerEl.classList.toggle("is-producing", producing);
    // The way out only exists when there is something to leave.
    modeExitEl.hidden = !producing;
    // Quiz me asks a fresh question, which is not what a student halfway
    // through answering one wants offered.
    quizBtn.hidden = producing;

    // Announced as a status rather than by moving focus: entering a mode is
    // news, not an interruption. The strip is also the textarea's
    // aria-describedby, so tabbing into the field repeats it in context.
    if (changed) {
      modeStatusEl.textContent = producing
        ? `Your next message will be ${spec.strip.replace(/^read as /, "read as ")}.`
        : "Your next message will be sent as a question.";
    }
  }

  /** Leave whatever mode the composer is in, without submitting. */
  function exitComposerMode() {
    if (composerMode === "hint") return;
    setComposerMode("hint");
    inputEl.focus();
  }

  function send() {
    if (isLoading) return;
    const text = inputEl.value.trim();

    if (composerMode === "explain") {
      removeActionRows();
      setComposerMode("hint");
      vscode.postMessage({ type: "explainAnswer", explanation: text });
      inputEl.value = "";
      return;
    }
    if (composerMode === "predict") {
      if (!text) return;
      setComposerMode("hint");
      vscode.postMessage({ type: "predictAnswer", prediction: text });
      inputEl.value = "";
      return;
    }
    if (composerMode === "review") {
      if (!text) return;
      setComposerMode("hint");
      vscode.postMessage({ type: "reviewAnswer", answer: text });
      inputEl.value = "";
      return;
    }
    if (!text) return;

    const mode = composerMode === "hint" ? "hint" : composerMode;
    setComposerMode("hint");
    vscode.postMessage({
      type: "askHint",
      question: text,
      code: currentCode,
      mode,
    });
    inputEl.value = "";
  }

  sendBtn.addEventListener("click", send);

  inputEl.addEventListener("keydown", (event) => {
    // Enter sends; Shift+Enter is how you get a newline. Ctrl/Cmd+Enter still
    // works for anyone who learned it that way.
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  });

  quizBtn.addEventListener("click", () => {
    if (isLoading) return;
    expectReflectAnswer = true;
    vscode.postMessage({ type: "askHint", question: "", code: currentCode, mode: "reflect" });
  });

  resetBtn.addEventListener("click", () => {
    if (isLoading) return;
    // Both ways in ask the same question. Reset is the one destructive control
    // in the panel and it sits a pixel from Ask down here, so having the
    // footer fire on the first click while the popover asked first would have
    // made the confirm decorative.
    if (!popoverOpen()) openPopover();
    resetConfirmEl.hidden = false;
    el("resetGo").focus();
  });
  refreshBtn.addEventListener("click", () => vscode.postMessage({ type: "refreshCode" }));
  modeExitEl.addEventListener("click", exitComposerMode);

  // Each banner carries a destination, because a banner that only states a
  // problem leaves the student with nowhere to go. Offline retries by
  // re-reading the file, which is the cheapest round-trip the panel has; a
  // broken sign-in sends them to the thing that fixes it.
  offlineRetryEl.addEventListener("click", () =>
    vscode.postMessage({ type: "refreshCode" })
  );
  authFixEl.addEventListener("click", () => vscode.postMessage({ type: "signIn" }));
  // ------------------------------------------------- account + preferences

  /** Light the first `currentLevel` of the four arcs on the avatar. */
  function paintRing() {
    const arcs = accountBtn.querySelectorAll(".avatar__arc");
    for (let i = 0; i < arcs.length; i++) {
      arcs[i].classList.toggle("is-on", i < currentLevel);
    }
    const depth = currentLevel > 0 ? `, hint ${currentLevel} of ${MAX_LEVEL}` : "";
    accountBtn.setAttribute(
      "aria-label",
      `${signedIn ? popNameEl.textContent : "Not signed in"} — account and preferences${depth}`
    );
  }

  /**
   * The dot on the avatar: the whole call to action for an anonymous student,
   * now that the header no longer spends a button on it, and the thing that
   * outlives a dismissed auth banner.
   */
  function paintPip() {
    accountPipEl.hidden = signedIn && !authBroken;
    accountPipEl.classList.toggle("is-danger", authBroken);
  }

  function setLevel(level) {
    currentLevel = Math.max(0, Math.min(MAX_LEVEL, Number(level) || 0));
    paintRing();
  }

  function popoverOpen() {
    return !prefsPop.hidden;
  }

  /**
   * The rows a keyboard can currently reach.
   *
   * `:not([hidden])` alone is not enough: Sign in is hidden by its wrapper
   * rather than by its own attribute, so a signed-in student opening the
   * popover would have focus sent to a button inside a `display:none` block —
   * which browsers decline, leaving nothing focused and the arrow keys doing
   * nothing.
   */
  function menuItems() {
    return Array.from(prefsPop.querySelectorAll("button:not([hidden]):not(:disabled)")).filter(
      (node) => !node.closest("[hidden]")
    );
  }

  function openPopover() {
    // Asked for fresh every time: a setting can have changed in the Settings
    // UI or another window since this was last painted.
    vscode.postMessage({ type: "requestPreferences" });
    resetConfirmEl.hidden = true;
    prefsPop.hidden = false;
    accountBtn.setAttribute("aria-expanded", "true");
    const first = menuItems()[0];
    if (first) first.focus();
  }

  function closePopover(refocus) {
    if (!popoverOpen()) return;
    prefsPop.hidden = true;
    resetConfirmEl.hidden = true;
    accountBtn.setAttribute("aria-expanded", "false");
    if (refocus) accountBtn.focus();
  }

  accountBtn.addEventListener("click", () => {
    if (popoverOpen()) closePopover(false);
    else openPopover();
  });

  // Escape closes whatever is open, innermost first: the popover, then the
  // badge sheet, then the composer mode. Only one per press, so a student in
  // a translation mode with the popover open does not lose both at once.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (popoverOpen()) {
      e.preventDefault();
      closePopover(true);
      return;
    }
    if (!badgesSheetEl.hidden) {
      e.preventDefault();
      closeBadges();
      badgesWrapEl.focus();
      return;
    }
    if (composerMode !== "hint") {
      e.preventDefault();
      exitComposerMode();
    }
  });

  document.addEventListener("mousedown", (e) => {
    if (!popoverOpen()) return;
    if (prefsPop.contains(e.target) || accountBtn.contains(e.target)) return;
    closePopover(false);
  });

  // Arrow keys walk the menu, as a menu is expected to.
  prefsPop.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const items = menuItems();
    if (!items.length) return;
    e.preventDefault();
    const at = items.indexOf(document.activeElement);
    const next = e.key === "ArrowDown" ? at + 1 : at - 1;
    items[(next + items.length) % items.length].focus();
  });

  function setPref(key, value) {
    vscode.postMessage({ type: "setPreference", key, value });
  }

  prefsPop.querySelectorAll("[data-pref]").forEach((row) => {
    const key = row.getAttribute("data-pref");
    row.addEventListener("click", () => {
      if (key === "lensMode") {
        setPref(key, prefs.lensMode === "all" ? "flagged" : "all");
      } else {
        setPref(key, !prefs[key]);
      }
    });
  });

  el("debounceDown").addEventListener("click", () =>
    setPref("debounceMs", Math.max(DEBOUNCE_MIN, (prefs.debounceMs || 0) - DEBOUNCE_STEP))
  );
  el("debounceUp").addEventListener("click", () =>
    setPref("debounceMs", Math.min(DEBOUNCE_MAX, (prefs.debounceMs || 0) + DEBOUNCE_STEP))
  );

  signInBtn.addEventListener("click", () => {
    closePopover(false);
    vscode.postMessage({ type: "signIn" });
  });
  signOutBtn.addEventListener("click", () => {
    closePopover(false);
    vscode.postMessage({ type: "signOut" });
  });
  el("popProgress").addEventListener("click", () => {
    closePopover(false);
    vscode.postMessage({ type: "showProgress" });
  });
  el("popGoal").addEventListener("click", () => {
    closePopover(false);
    vscode.postMessage({ type: "setGoal" });
  });
  el("popSettings").addEventListener("click", () => {
    closePopover(false);
    vscode.postMessage({ type: "openSettings" });
  });

  // Reset asks first. It is the one destructive control in the panel, and it
  // used to sit a pixel from the primary action with no confirm at all.
  el("popReset").addEventListener("click", () => {
    resetConfirmEl.hidden = false;
    el("resetGo").focus();
  });
  el("resetCancel").addEventListener("click", () => {
    resetConfirmEl.hidden = true;
    el("popReset").focus();
  });
  el("resetGo").addEventListener("click", () => {
    closePopover(false);
    if (isLoading) return;
    vscode.postMessage({ type: "reset" });
  });

  function renderPreferences(values, backendUrl) {
    prefs = values || {};
    prefsPop.querySelectorAll("[data-pref]").forEach((row) => {
      const key = row.getAttribute("data-pref");
      if (key === "lensMode") return;
      const on = !!prefs[key];
      row.setAttribute("aria-checked", String(on));
      const tog = row.querySelector(".tog");
      if (tog) tog.setAttribute("data-on", String(on));
    });
    const mode = prefs.lensMode === "flagged" ? "flagged" : "all";
    lensSegEl.querySelectorAll("[data-value]").forEach((seg) => {
      seg.setAttribute("data-on", String(seg.getAttribute("data-value") === mode));
    });
    const ms = Number(prefs.debounceMs) || DEBOUNCE_MIN;
    debounceValueEl.textContent = `${ms} ms`;
    el("debounceDown").disabled = ms <= DEBOUNCE_MIN;
    el("debounceUp").disabled = ms >= DEBOUNCE_MAX;
    popBackendEl.textContent = (backendUrl || "").replace(/^https?:\/\//, "");
  }
  reviewBtn.addEventListener("click", () => {
    if (isLoading) return;
    reviewBtn.hidden = true;
    expectReviewAnswer = true;
    vscode.postMessage({ type: "startReview" });
  });

  // ------------------------------------------------------ message handling

  function handleHint(msg) {
    removeStreamingTurn();
    const mode = msg.mode || "hint";
    const level = Number(msg.hint_level) || 0;
    // The ring follows the ladder, and only the ladder: a concept explanation
    // or a prediction check is not a rung and must not light one.
    if (LADDER_MODES.has(mode)) setLevel(level);

    // Asked again without editing: the gate card carries its own meter, at the
    // depth the thread is actually at, with the held bracket on it. It used to
    // reach backwards into the previous card and force a reflow so the nudge
    // would replay — which meant three consecutive gates left two cards
    // silent and one animating, and reduced motion left all three silent. The
    // bracket is a resting style now, so a card that is held simply looks it.
    const held = mode === "attempt-gate";

    addTurn({
      role: "tutor",
      text: msg.hint,
      eyebrow: MODE_LABEL[mode] || mode,
      level: held ? currentLevel : LADDER_MODES.has(mode) ? level : 0,
      held,
      tags: msg.concept_tags || [],
      family: familyFor(mode),
    });

    if (mode === "hint" && level === 3) {
      addActionRow([
        {
          label: "Submit my translation",
          onClick: () =>
            setComposerMode("translate"),
        },
      ]);
    }

    if (mode === "worked-example") {
      addActionRow([
        {
          label: "Label the steps",
          onClick: () =>
            setComposerMode("subgoal-label"),
        },
      ]);
    }

    if (mode === "reflect" && expectReflectAnswer) {
      expectReflectAnswer = false;
      setComposerMode("reflect");
    }

    // A review exercise asks the student to write code and predict its
    // behaviour. Without a composer mode for the answer, whatever they typed
    // was submitted as a fresh Socratic question about the open file.
    if (mode === "review-exercise" && expectReviewAnswer) {
      expectReviewAnswer = false;
      setComposerMode("review");
    }
  }

  window.addEventListener("message", (event) => {
    const msg = event.data;
    switch (msg.type) {
      case "restoreChat": {
        const restored = Array.isArray(msg.messages) ? msg.messages : [];
        turns = [];
        clearChat();
        isRestoring = true;
        for (const turn of restored) {
          buildTurn(turn);
          turns.push(turn);
        }
        isRestoring = false;
        refreshPlaceholder();
        // The transcript on screen is now a different conversation, so the
        // composer must be too. clearChat() removed the explain-first card and
        // its Skip button, but composerMode outlived them: the next thing the
        // student typed was posted as an explanation of the function they had
        // just left, and their real question was never asked. Same reset
        // "resetDone" does, for the same reason.
        setComposerMode("hint");
        expectReflectAnswer = false;
        expectReviewAnswer = false;
        // The render cache has to move with it too, or hiding and showing the
        // panel repaints the previous function's transcript until "ready"
        // corrects it.
        vscode.setState({ turns });
        break;
      }

      case "focus":
        focusCode = msg.focusCode || "";
        focusStartLine = msg.startLine || 1;
        cursorLine = msg.cursorLine || 0;
        currentCode = focusCode;
        showingWholeFile = false;
        scopeToggleEl.setAttribute("aria-pressed", "false");
        scopeToggleEl.textContent = "Whole file";
        scopeToggleEl.hidden = !msg.totalLines;
        renderLines(focusCode, focusStartLine, cursorLine);
        {
          // The empty state names the block when there is one, so a student
          // who has not asked yet can see where the panel is pointed. Only
          // when the block actually changes, though: `focus` arrives on every
          // cursor move, and rebuilding the placeholder each time would
          // replay its entrance animation while they were typing.
          const wasSymbol = focusSymbol;
          paintContext(msg);
          // Re-render the empty state only if it is already the one showing.
          // Which placeholder belongs on screen is authState's call, and
          // `focus` can arrive before any authState has — going through
          // refreshPlaceholder() here would show the signed-out card to a
          // student whose sign-in simply had not been reported yet.
          if (focusSymbol !== wasSymbol && chatEl.querySelector(".empty")) {
            showEmptyState();
          }
        }
        break;

      case "cursor": {
        const line = Number(msg.cursorLine) || 0;
        cursorLine = line;
        const rows = codeEl.querySelectorAll(".ln");
        rows.forEach((row) => {
          const no = row.querySelector(".ln__no");
          row.classList.toggle("is-cursor", !!no && Number(no.textContent) === line);
        });
        break;
      }

      case "fullFile":
        // A reply can arrive after the student has already toggled back to
        // the focus block (e.g. a quick on/off); without this guard it would
        // silently repaint the preview with the whole file even though the
        // button already reads "Whole file".
        if (!showingWholeFile) break;
        // The preview widens; `currentCode` deliberately does not, so an ask
        // stays about the block even while the whole file is on screen.
        renderLines(msg.code || "", 1, cursorLine);
        break;

      case "userMessage":
        addTurn({ role: "student", text: msg.text });
        break;

      case "streamStart": {
        removeStreamingTurn();
        dropPlaceholder();
        const wrap = document.createElement("div");
        wrap.className = "turn turn--tutor";
        // The chat is an aria-live log, so an unmuted streaming bubble makes a
        // screen reader re-announce the whole partial hint on every token. The
        // finished turn that replaces it is announced once, which is right.
        wrap.setAttribute("aria-hidden", "true");
        const body = document.createElement("div");
        body.className = "turn__body turn__body--streaming";
        const text = document.createElement("span");
        const caret = document.createElement("span");
        caret.className = "caret";
        body.appendChild(text);
        body.appendChild(caret);
        wrap.appendChild(body);
        chatEl.appendChild(wrap);
        streamingTurn = { wrap, text, seq: msg.seq };
        scrollToEnd();
        break;
      }

      case "streamDelta":
        // A delta from a superseded ask must not paint into the current
        // bubble; the extension refuses overlapping asks, but a late delta
        // from an aborted one can still arrive.
        if (streamingTurn && msg.seq === streamingTurn.seq) {
          // Only follow the stream if the student is already at the bottom —
          // yanking the view back while they are reading an earlier hint is
          // the thing that makes streaming panels unusable.
          const atBottom =
            chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 40;
          streamingTurn.text.textContent += msg.text || "";
          if (atBottom) scrollToEnd();
        }
        break;

      case "streamAbort":
        if (!streamingTurn || msg.seq === streamingTurn.seq) {
          removeStreamingTurn();
        }
        break;

      case "hint":
        handleHint(msg);
        break;

      case "traceTable":
        renderTraceExercise(msg);
        break;

      case "predictFirst":
        addTurn({
          role: "tutor",
          text:
            "Without running it, what does this print or do?\n\n```\n" +
            (msg.snippet || "") +
            "\n```",
          eyebrow: "Predict the output",
        });
        setComposerMode("predict");
        break;

      case "explainFirst":
        addTurn({ role: "tutor", text: msg.prompt, eyebrow: "Explain first" });
        addActionRow([
          {
            label: "Skip and get my hint",
            onClick: () => {
              setComposerMode("hint");
              vscode.postMessage({ type: "explainSkip" });
            },
          },
        ]);
        setComposerMode("explain");
        break;

      case "error":
        removeStreamingTurn();
        addTurn({ role: "error", text: msg.message, eyebrow: "Something went wrong" });
        break;

      case "loading":
        isLoading = !!msg.value;
        loadingEl.hidden = !isLoading;
        sendBtn.disabled = isLoading;
        quizBtn.disabled = isLoading;
        resetBtn.disabled = isLoading;
        reviewBtn.disabled = isLoading;
        break;

      case "offline":
        offlineBannerEl.hidden = !msg.value;
        break;

      case "authTrouble":
        authBannerEl.hidden = !msg.value;
        // The pip is the part that survives the banner being dismissed: a
        // student who closes the banner has not fixed anything, and the way
        // to fix it is behind the avatar.
        authBroken = !!msg.value;
        paintPip();
        break;

      case "streak": {
        const days = Number(msg.days) || 0;
        streakDaysEl.textContent = String(days);
        streakChipEl.setAttribute("aria-label", `${days} day practice streak`);
        streakChipEl.hidden = days <= 0;
        // The separator belongs to the streak, not to the row: with no streak
        // the ledger would otherwise open on a bare middle dot.
        ledgerSepEl.hidden = days <= 0;
        break;
      }

      case "badges":
        renderBadges(msg.badges);
        break;

      case "scanClean":
        document.body.classList.add("is-celebrating");
        setTimeout(() => document.body.classList.remove("is-celebrating"), 900);
        break;

      case "authState":
        signedIn = !!msg.signedIn;
        popNameEl.textContent = signedIn ? msg.label : "Working anonymously";
        popMailEl.textContent = signedIn
          ? msg.email || msg.label
          : "Your streak and badges live on this machine only.";
        popMailEl.title = signedIn ? msg.email || msg.label : "";
        accountInitialsEl.textContent = signedIn ? msg.initials || "?" : "?";
        accountInitialsEl.classList.toggle("is-anon", !signedIn);
        paintPip();
        popSignInWrap.hidden = signedIn;
        signOutBtn.hidden = !signedIn;
        paintRing();
        refreshPlaceholder();
        break;

      case "preferences":
        renderPreferences(msg.values, msg.backendUrl);
        break;

      case "reviewDue":
        reviewBtn.hidden = false;
        break;

      // The clear and the summary arrive separately now. The clear is local
      // and instant; the summary is an LLM call the student is not waiting on.
      case "resetCleared":
        turns = [];
        clearChat();
        setComposerMode("hint");
        expectReflectAnswer = false;
        expectReviewAnswer = false;
        setLevel(0);
        addTurn({
          role: "tutor",
          text: "Session reset. We're back at hint 1.",
          eyebrow: "Fresh start",
        });
        break;

      case "resetDone":
        // `resetCleared` already did the clearing. What is left is the note,
        // and only when the backend had one to give. It lands after the fresh
        // start line rather than before it, because that is the order the two
        // actually happen in now — and because `addTurn` appends, so placing
        // it earlier would put the DOM out of step with `turns`, which is what
        // `restoreChat` replays.
        if (msg.summary) {
          addTurn({ role: "tutor", text: msg.summary, eyebrow: "What you learned" });
        }
        break;

      case "externalAsk":
        // Nothing to do. `askExternal` calls sendFocus() before posting this,
        // so the "focus" message has already set both the preview and
        // `currentCode` to the block on screen. Setting `currentCode` from
        // `msg.code` here would point the next typed follow-up at code the
        // student never saw — the callers pass whole documents and raw
        // selections, not the resolved focus block.
        break;
    }
  });

  // Paint something immediately from webview state, then let the extension
  // replace it with the durable copy once it answers "ready". getState() is
  // synchronous and local, so this runs on every webview init — sidebar
  // hidden/shown, moved to another container, extension host reload — not
  // just the "restoreChat" round-trip above. Same flag, same reason: without
  // it every card here would fire its entrance and every meter would re-grow
  // all at once.
  const saved = vscode.getState();
  if (saved && Array.isArray(saved.turns) && saved.turns.length) {
    turns = saved.turns;
    isRestoring = true;
    for (const turn of turns) buildTurn(turn);
    isRestoring = false;
  } else {
    showEmptyState();
  }
  renderLines("", 1, 0);

  vscode.postMessage({ type: "ready" });
})();
