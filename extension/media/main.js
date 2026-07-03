(function () {
  const vscode = acquireVsCodeApi();

  const chatEl = document.getElementById("chat");
  const inputEl = document.getElementById("input");
  const sendBtn = document.getElementById("send");
  const resetBtn = document.getElementById("reset");
  const refreshBtn = document.getElementById("refreshCode");
  const codeEl = document.getElementById("codeSnippet");
  const fileNameEl = document.getElementById("fileName");
  const langChipEl = document.getElementById("langChip");
  const loadingEl = document.getElementById("loading");
  const badgesEl = document.getElementById("badges");
  const accountLabelEl = document.getElementById("accountLabel");
  const authBtn = document.getElementById("authBtn");
  const quizBtn = document.getElementById("quiz");
  let signedIn = false;

  const DEFAULT_PLACEHOLDER = "Describe your error or ask a question...";
  // What the next composer submission means: a normal hint ask, the answer to
  // the explain-first prompt, a pseudocode translation, or a reflect answer.
  let composerMode = "hint";
  // Set when the reflect quiz question is on its way, so the reply that follows
  // is treated as the student's quiz answer.
  let expectReflectAnswer = false;

  const MODE_META = {
    reflect: "Reflection quiz",
    translate: "Translation feedback",
    "worked-example": "Worked example",
    "explain-error": "Reading the error",
    "explain-concept": "Concept explained",
    "predict-output": "Output prediction",
    "review-exercise": "Review exercise",
  };

  authBtn.addEventListener("click", () => {
    vscode.postMessage({ type: signedIn ? "signOut" : "signIn" });
  });

  let currentCode = "";

  const prev = vscode.getState();
  if (prev && prev.messages) {
    prev.messages.forEach(renderBubble);
  }

  function persist() {
    const bubbles = Array.from(chatEl.querySelectorAll(".bubble")).map((b) => ({
      role: b.classList.contains("user") ? "user" : b.classList.contains("error") ? "error" : "ai",
      text: b.dataset.text || b.textContent,
      meta: b.dataset.meta || "",
      tags: b.dataset.tags ? JSON.parse(b.dataset.tags) : [],
    }));
    vscode.setState({ messages: bubbles });
  }

  function renderBubble(msg) {
    const div = document.createElement("div");
    div.className = "bubble " + msg.role;
    div.dataset.text = msg.text;
    const textNode = document.createElement("div");
    textNode.textContent = msg.text;
    div.appendChild(textNode);
    if (msg.meta) {
      div.dataset.meta = msg.meta;
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = msg.meta;
      div.appendChild(meta);
    }
    if (msg.tags && msg.tags.length) {
      div.dataset.tags = JSON.stringify(msg.tags);
      const tags = document.createElement("div");
      tags.className = "tags";
      msg.tags.forEach((t) => {
        const span = document.createElement("span");
        span.className = "tag";
        span.textContent = t;
        tags.appendChild(span);
      });
      div.appendChild(tags);
    }
    chatEl.appendChild(div);
    chatEl.scrollTop = chatEl.scrollHeight;
  }

  function renderBadges(list) {
    badgesEl.innerHTML = "";
    if (!list || list.length === 0) {
      const empty = document.createElement("span");
      empty.className = "badge";
      empty.textContent = "No badges yet";
      empty.style.opacity = "0.6";
      badgesEl.appendChild(empty);
      return;
    }
    list.forEach((name) => {
      const el = document.createElement("span");
      el.className = "badge";
      el.textContent = name;
      badgesEl.appendChild(el);
    });
  }

  function setComposerMode(mode, placeholder) {
    composerMode = mode;
    inputEl.placeholder = placeholder || DEFAULT_PLACEHOLDER;
  }

  function removeActionRows() {
    chatEl.querySelectorAll(".action-row").forEach((el) => el.remove());
  }

  function addActionRow(buttons) {
    const row = document.createElement("div");
    row.className = "action-row";
    buttons.forEach(({ label, onClick }) => {
      const btn = document.createElement("button");
      btn.className = "small-btn";
      btn.textContent = label;
      btn.addEventListener("click", () => {
        row.remove();
        onClick();
      });
      row.appendChild(btn);
    });
    chatEl.appendChild(row);
    chatEl.scrollTop = chatEl.scrollHeight;
  }

  function send() {
    const q = inputEl.value.trim();
    if (composerMode === "explain") {
      removeActionRows();
      setComposerMode("hint");
      vscode.postMessage({ type: "explainAnswer", explanation: q });
      inputEl.value = "";
      return;
    }
    if (!q) return;
    const mode = composerMode === "hint" ? "hint" : composerMode;
    setComposerMode("hint");
    vscode.postMessage({ type: "askHint", question: q, code: currentCode, mode });
    inputEl.value = "";
  }

  sendBtn.addEventListener("click", send);

  quizBtn.addEventListener("click", () => {
    expectReflectAnswer = true;
    vscode.postMessage({ type: "askHint", question: "", code: currentCode, mode: "reflect" });
  });
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      send();
    }
  });

  resetBtn.addEventListener("click", () => {
    vscode.postMessage({ type: "reset" });
  });

  refreshBtn.addEventListener("click", () => {
    vscode.postMessage({ type: "refreshCode" });
  });

  window.addEventListener("message", (event) => {
    const msg = event.data;
    switch (msg.type) {
      case "activeCode":
        currentCode = msg.code || "";
        codeEl.textContent = currentCode || "(no active file)";
        fileNameEl.textContent = msg.fileName
          ? msg.fileName.split(/[\\/]/).pop()
          : "No active file";
        langChipEl.textContent = msg.language || "";
        langChipEl.classList.toggle("hidden", !msg.language);
        break;
      case "userMessage":
        renderBubble({ role: "user", text: msg.text });
        persist();
        break;
      case "hint": {
        const mode = msg.mode || "hint";
        renderBubble({
          role: "ai",
          text: msg.hint,
          meta: mode === "hint" ? `Hint level ${msg.hint_level}` : MODE_META[mode] || mode,
          tags: msg.concept_tags || [],
        });
        if (mode === "hint" && msg.hint_level === 3) {
          addActionRow([
            {
              label: "✍️ Submit my translation",
              onClick: () =>
                setComposerMode(
                  "translate",
                  "Paste your code translation of the pseudocode..."
                ),
            },
            {
              label: "📘 Show a worked example",
              onClick: () =>
                vscode.postMessage({
                  type: "askHint",
                  question: "",
                  code: currentCode,
                  mode: "worked-example",
                }),
            },
          ]);
        }
        if (mode === "reflect" && expectReflectAnswer) {
          expectReflectAnswer = false;
          setComposerMode("reflect", "Type your answer to the quiz question...");
        }
        persist();
        break;
      }
      case "explainFirst":
        renderBubble({ role: "ai", text: msg.prompt, meta: "Explain first" });
        addActionRow([
          {
            label: "Skip and get my hint",
            onClick: () => {
              setComposerMode("hint");
              vscode.postMessage({ type: "explainSkip" });
            },
          },
        ]);
        setComposerMode("explain", "Type what you think the code does...");
        persist();
        break;
      case "error":
        renderBubble({ role: "error", text: `Error: ${msg.message}` });
        persist();
        break;
      case "loading":
        loadingEl.classList.toggle("hidden", !msg.value);
        break;
      case "badges":
        renderBadges(msg.badges || []);
        break;
      case "authState":
        signedIn = !!msg.signedIn;
        accountLabelEl.textContent = msg.label;
        authBtn.textContent = signedIn ? "Sign out" : "Sign in";
        break;
      case "resetDone":
        chatEl.innerHTML = "";
        setComposerMode("hint");
        expectReflectAnswer = false;
        persist();
        renderBubble({ role: "ai", text: "Session reset. Hint level starts over at 1." });
        persist();
        break;
      case "externalAsk":
        currentCode = msg.code || currentCode;
        codeEl.textContent = currentCode;
        break;
    }
  });

  vscode.postMessage({ type: "ready" });
})();
