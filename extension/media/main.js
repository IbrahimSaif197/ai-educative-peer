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
  const reviewBtn = el("reviewBtn");
  const offlineBannerEl = el("offlineBanner");
  const authBannerEl = el("authBanner");

  const DEFAULT_PLACEHOLDER = "Describe your error or ask a question…";
  const MAX_PREVIEW_LINES = 200;

  /** Eyebrow text per tutor move. Hint mode is level-dependent. */
  const MODE_LABEL = {
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

  /** Modes that occupy a rung on the hint ladder, so the card shows its depth. */
  const LADDER_MODES = new Set(["hint", "worked-example"]);

  const MAX_LEVEL = 4;
  /** Steps the "wait before hinting" stepper moves in, and its floor. Both are
   *  re-applied in the extension host; these only keep the UI honest. */
  const DEBOUNCE_STEP = 200;
  const DEBOUNCE_MIN = 600;
  const DEBOUNCE_MAX = 5000;

  let currentCode = "";
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
  // buildTurn() mark those turns so their entrance (and their ladders'
  // dot-fill/dot-ring) don't all fire at once. See buildTurn() and the
  // "restoreChat" case below.
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
    wrap.appendChild(title);
    wrap.appendChild(
      document.createTextNode(
        "Open a file and tell me what's going wrong. I ask questions rather than hand over answers, " +
          "so you keep the part where you work it out."
      )
    );
    chatEl.appendChild(wrap);
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
    chatEl.appendChild(wrap);
  }

  /** Only swap the placeholder — never a conversation the student is reading. */
  function refreshPlaceholder() {
    if (turns.length) return;
    if (signedIn) showEmptyState();
    else showSignInState();
  }

  function buildTurn(turn) {
    dropPlaceholder();
    const wrap = document.createElement("div");
    wrap.className = `turn turn--${turn.role === "student" ? "student" : "tutor"}`;
    if (turn.role === "error") wrap.classList.add("is-error");
    if (turn.flagged) wrap.classList.add("is-flagged");
    // A restored transcript rebuilds every turn in one pass; without this,
    // N cards would fire their entrance (and every ladder its dot-fill and
    // dot-ring) all at once. Live turns are unaffected — isRestoring is only
    // ever true while the "restoreChat" handler below is looping.
    if (isRestoring) wrap.classList.add("is-restored");

    if (turn.eyebrow) {
      const eyebrow = document.createElement("div");
      eyebrow.className = "turn__eyebrow";
      eyebrow.textContent = turn.eyebrow;
      wrap.appendChild(eyebrow);
    }

    // The depth belongs with the hint it describes. It used to sit pinned
    // above the composer, describing a hint that could be several turns up.
    if (turn.level >= 1) {
      const ladder = document.createElement("div");
      ladder.className = "ladder";
      const label = document.createElement("span");
      label.className = "ladder__label";
      label.textContent = `hint ${turn.level}`;
      ladder.appendChild(label);
      // Tracked so the held state (below) has a single dot to put its static
      // ring on: the last filled one, i.e. the current depth.
      let lastOnDot = null;
      for (let i = 1; i <= 4; i++) {
        const dot = document.createElement("span");
        const on = i <= turn.level;
        dot.className = on ? "ladder__dot is-on" : "ladder__dot";
        dot.style.setProperty("--dot-index", String(i - 1));
        if (on) lastOnDot = dot;
        ladder.appendChild(dot);
      }
      if (lastOnDot) lastOnDot.classList.add("ladder__dot--anchor");
      wrap.appendChild(ladder);
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
    chatEl.appendChild(row);
    scrollToEnd();
  }

  // ---------------------------------------------------------------- badges

  function renderBadges(list) {
    while (badgesEl.firstChild) badgesEl.removeChild(badgesEl.firstChild);
    const items = list || [];
    badgeCountEl.textContent = items.length
      ? `${items.length} badge${items.length === 1 ? "" : "s"}`
      : "No badges yet";
    badgesWrapEl.hidden = items.length === 0;
    for (const name of items) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = name;
      badgesEl.appendChild(badge);
    }
  }

  // ----------------------------------------------------------- code preview

  const focusRangeEl = el("focusRange");
  const scopeToggleEl = el("scopeToggle");
  const scopeRowEl = el("scopeRow");

  /** The block every ask is about, whatever the preview happens to show. */
  let focusCode = "";
  let focusStartLine = 1;
  let cursorLine = 0;
  let showingWholeFile = false;

  function renderLines(code, firstLine, markLine) {
    while (codeEl.firstChild) codeEl.removeChild(codeEl.firstChild);
    if (!code) {
      const line = document.createElement("span");
      line.className = "ln ln--empty";
      line.textContent = "No file open";
      codeEl.appendChild(line);
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
    if (lines.length > shown.length) {
      const more = document.createElement("span");
      more.className = "ln ln--empty";
      more.textContent = `… ${lines.length - shown.length} more lines`;
      codeEl.appendChild(more);
    }
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

  collapseBtn.addEventListener("click", () => {
    const collapsed = !codeEl.hidden;
    codeEl.hidden = collapsed;
    // The scope row (range + "Whole file" toggle) describes the preview, so
    // it has nothing to act on once the preview itself is hidden.
    scopeRowEl.hidden = collapsed;
    collapseBtn.textContent = collapsed ? "Show" : "Hide";
    collapseBtn.setAttribute("aria-expanded", String(!collapsed));
  });

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

  function setComposerMode(mode, placeholder) {
    composerMode = mode;
    inputEl.placeholder = placeholder || DEFAULT_PLACEHOLDER;
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

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && popoverOpen()) {
      e.preventDefault();
      closePopover(true);
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

    addTurn({
      role: "tutor",
      text: msg.hint,
      eyebrow: mode === "hint" ? undefined : MODE_LABEL[mode] || mode,
      level: LADDER_MODES.has(mode) ? level : 0,
      tags: msg.concept_tags || [],
      flagged: FLAGGED_MODES.has(mode),
    });

    if (mode === "attempt-gate") {
      // Asked again without editing. The ladder reports that it is holding
      // rather than advancing — the same signal the old composer stepper gave,
      // now on the card that owns the depth.
      const ladders = chatEl.querySelectorAll(".ladder");
      const last = ladders[ladders.length - 1];
      if (last) {
        last.classList.remove("is-held");
        // Reflow so the animation restarts on consecutive holds.
        void last.offsetWidth;
        last.classList.add("is-held");
      }
    }

    if (mode === "hint" && level === 3) {
      addActionRow([
        {
          label: "Submit my translation",
          onClick: () =>
            setComposerMode("translate", "Paste your code translation of the pseudocode…"),
        },
      ]);
    }

    if (mode === "worked-example") {
      addActionRow([
        {
          label: "Label the steps",
          onClick: () =>
            setComposerMode("subgoal-label", "What does each numbered step accomplish?"),
        },
      ]);
    }

    if (mode === "reflect" && expectReflectAnswer) {
      expectReflectAnswer = false;
      setComposerMode("reflect", "Type your answer to the quiz question…");
    }

    // A review exercise asks the student to write code and predict its
    // behaviour. Without a composer mode for the answer, whatever they typed
    // was submitted as a fresh Socratic question about the open file.
    if (mode === "review-exercise" && expectReviewAnswer) {
      expectReviewAnswer = false;
      setComposerMode("review", "Write your code and what you expect it to do…");
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
        fileNameEl.textContent =
          msg.breadcrumb || (msg.fileName ? msg.fileName.split(/[\\/]/).pop() : "No active file");
        fileNameEl.title = msg.fileName || "";
        focusRangeEl.textContent =
          msg.startLine && msg.endLine
            ? msg.startLine === msg.endLine
              ? `line ${msg.startLine}`
              : `lines ${msg.startLine}–${msg.endLine}`
            : "";
        langChipEl.textContent = msg.language || "";
        langChipEl.hidden = !msg.language;
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
        setComposerMode("predict", "Type your prediction…");
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
        setComposerMode("explain", "Type what you think the code does…");
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
        break;

      case "streak": {
        const days = Number(msg.days) || 0;
        streakDaysEl.textContent = String(days);
        streakChipEl.setAttribute("aria-label", `${days} day practice streak`);
        streakChipEl.hidden = days <= 0;
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
        // The pip is the whole call to action for an anonymous student, now
        // that the header no longer spends a button on it.
        accountPipEl.hidden = signedIn;
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
  // it every card here would fire its entrance and every ladder would
  // re-fire dot-fill/dot-ring all at once.
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
