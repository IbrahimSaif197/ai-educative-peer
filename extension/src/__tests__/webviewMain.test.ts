/**
 * @jest-environment jsdom
 */

/**
 * Tests for media/main.js, the webview controller.
 *
 * The markup is not duplicated here: it is taken from the provider's own
 * getHtml(), so if the HTML and the script ever drift apart these tests fail
 * rather than passing against a stale copy.
 */

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { EduPeerSidebarProvider } from "../sidebarProvider";

const mock = vscode as any;
const MEDIA = path.join(__dirname, "..", "..", "media");

/** Messages the webview sent back to the extension. */
let sent: any[] = [];
let saved: any;

function providerHtml(): string {
  let html = "";
  const provider = new EduPeerSidebarProvider(
    mock.Uri.file("/ext"),
    { globalState: { get: (_k: string, f: any) => f, update: async () => undefined } } as any,
    {} as any,
    {} as any,
    { getSession: () => undefined, onDidChange: jest.fn() } as any,
    undefined
  );
  provider.resolveWebviewView({
    webview: {
      options: {},
      set html(value: string) {
        html = value;
      },
      get html() {
        return html;
      },
      cspSource: "vscode-webview:",
      asWebviewUri: (u: any) => u,
      postMessage: () => Promise.resolve(true),
      onDidReceiveMessage: () => ({ dispose: jest.fn() }),
    },
    show: jest.fn(),
    onDidDispose: jest.fn(() => ({ dispose: jest.fn() })),
  } as any);
  return html;
}

function load() {
  sent = [];
  saved = undefined;

  const html = providerHtml();
  const body = /<body>([\s\S]*)<\/body>/.exec(html)![1].replace(/<script[\s\S]*?<\/script>/g, "");
  document.body.innerHTML = body;

  (global as any).acquireVsCodeApi = () => ({
    postMessage: (msg: any) => sent.push(msg),
    setState: (state: any) => (saved = state),
    getState: () => saved,
  });

  const run = (file: string) =>
    // eslint-disable-next-line no-new-func
    new Function(fs.readFileSync(path.join(MEDIA, file), "utf8")).call(window);

  run("markdown.js");
  run("main.js");
}

/** Deliver a message from the extension to the webview. */
function post(msg: any) {
  window.dispatchEvent(new MessageEvent("message", { data: msg }));
}

const $ = (selector: string) => document.querySelector(selector);
const $$ = (selector: string) => Array.from(document.querySelectorAll(selector));
const el = (id: string) => document.getElementById(id)!;
const lastSent = (type: string) => [...sent].reverse().find((m) => m.type === type);

const turns = () => $$(".turn");
const lastTurn = () => turns().at(-1)!;

beforeEach(() => {
  mock.__reset();
  load();
});

describe("startup", () => {
  it("tells the extension it is ready", () => {
    expect(lastSent("ready")).toBeDefined();
  });

  it("shows an invitation rather than a blank panel", () => {
    expect($(".empty")!.textContent).toContain("Stuck on something?");
  });

  it("renders a placeholder when no file is open", () => {
    expect(el("codeSnippet").textContent).toContain("No file open");
  });

  it("hides the hint stepper until a hint arrives", () => {
    expect((el("stepper") as HTMLElement).hidden).toBe(true);
  });
});

describe("restoring a transcript", () => {
  it("rebuilds every stored turn", () => {
    post({
      type: "restoreChat",
      messages: [
        { role: "student", text: "why does it crash?" },
        { role: "tutor", text: "What does len() return?", eyebrow: "Hint 1" },
      ],
    });
    expect(turns()).toHaveLength(2);
    expect($(".turn--student")!.textContent).toContain("why does it crash?");
  });

  it("falls back to the empty state when there is nothing stored", () => {
    post({ type: "restoreChat", messages: [] });
    expect($(".empty")).not.toBeNull();
  });

  it("drops the empty state once a turn arrives", () => {
    post({ type: "userMessage", text: "hello" });
    expect($(".empty")).toBeNull();
  });
});

describe("the code preview", () => {
  it("renders one numbered row per line", () => {
    post({ type: "activeCode", code: "a = 1\nb = 2\n", fileName: "/tmp/demo.py", language: "Python" });
    expect($$("#codeSnippet .ln")).toHaveLength(3);
  });

  it("shows the file name without its directory", () => {
    post({ type: "activeCode", code: "x", fileName: "/home/me/demo.py", language: "Python" });
    expect(el("fileName").textContent).toBe("demo.py");
  });

  it("shows the language chip", () => {
    post({ type: "activeCode", code: "x", fileName: "a.py", language: "Python" });
    expect((el("langChip") as HTMLElement).hidden).toBe(false);
    expect(el("langChip").textContent).toBe("Python");
  });

  it("hides the chip for an unsupported language", () => {
    post({ type: "activeCode", code: "x", fileName: "a.md", language: "" });
    expect((el("langChip") as HTMLElement).hidden).toBe(true);
  });

  it("caps the preview and says how much it dropped", () => {
    const code = Array.from({ length: 260 }, (_, i) => `line ${i}`).join("\n");
    post({ type: "activeCode", code, fileName: "big.py", language: "Python" });
    expect($$("#codeSnippet .ln")).toHaveLength(201);
    expect(el("codeSnippet").textContent).toContain("60 more lines");
  });

  it("collapses and restores on the toggle", () => {
    const button = el("collapseCode") as HTMLButtonElement;
    button.click();
    expect((el("codeSnippet") as HTMLElement).hidden).toBe(true);
    expect(button.textContent).toBe("Show");
    button.click();
    expect((el("codeSnippet") as HTMLElement).hidden).toBe(false);
    expect(button.textContent).toBe("Hide");
  });
});

describe("rendering a hint", () => {
  it("labels the depth in the eyebrow", () => {
    post({ type: "hint", hint: "Think about the bound.", hint_level: 2, concept_tags: [], mode: "hint" });
    expect(lastTurn().querySelector(".turn__eyebrow")!.textContent).toBe("Hint 2");
  });

  it("fills the stepper up to the current depth", () => {
    post({ type: "hint", hint: "h", hint_level: 2, concept_tags: [], mode: "hint" });
    const on = $$(".stepper__step.is-on");
    expect(on).toHaveLength(2);
    expect((el("stepper") as HTMLElement).hidden).toBe(false);
  });

  it("renders concept tags", () => {
    post({
      type: "hint",
      hint: "h",
      hint_level: 1,
      concept_tags: ["loops", "off-by-one"],
      mode: "hint",
    });
    expect($$(".tag").map((t) => t.textContent)).toEqual(["loops", "off-by-one"]);
  });

  it("renders markdown rather than raw text", () => {
    post({
      type: "hint",
      hint: "Try this:\n\n```\nfor i in range(n):\n```",
      hint_level: 3,
      concept_tags: [],
      mode: "hint",
    });
    expect(lastTurn().querySelector("pre code")).not.toBeNull();
    expect(lastTurn().textContent).not.toContain("```");
  });

  it("names the tutor move for a non-hint mode", () => {
    post({ type: "hint", hint: "h", hint_level: 1, concept_tags: [], mode: "worked-example" });
    expect(lastTurn().querySelector(".turn__eyebrow")!.textContent).toBe("Worked example");
  });

  it("offers translation and worked-example actions at depth three", () => {
    post({ type: "hint", hint: "h", hint_level: 3, concept_tags: [], mode: "hint" });
    const labels = $$(".actions button").map((b) => b.textContent);
    expect(labels).toEqual(["Submit my translation", "Show a worked example"]);
  });

  it("offers step labelling after a worked example", () => {
    post({ type: "hint", hint: "1. do a thing", hint_level: 1, concept_tags: [], mode: "worked-example" });
    expect($$(".actions button").map((b) => b.textContent)).toEqual(["Label the steps"]);
  });

  it("asks for a worked example when that action is clicked", () => {
    post({ type: "hint", hint: "h", hint_level: 3, concept_tags: [], mode: "hint" });
    ($$(".actions button")[1] as HTMLButtonElement).click();
    expect(lastSent("askHint").mode).toBe("worked-example");
  });
});

describe("modes that withhold", () => {
  it("flags the attempt gate and pulses the stepper instead of advancing", () => {
    post({ type: "hint", hint: "h", hint_level: 1, concept_tags: [], mode: "hint" });
    post({ type: "hint", hint: "not yet", hint_level: 0, concept_tags: [], mode: "attempt-gate" });
    expect(lastTurn().classList.contains("is-flagged")).toBe(true);
    expect(el("stepper").classList.contains("is-held")).toBe(true);
    expect($$(".stepper__step.is-on")).toHaveLength(1);
  });

  it("flags a rate-limited reply", () => {
    post({ type: "hint", hint: "slow down", hint_level: 0, concept_tags: [], mode: "rate-limited" });
    expect(lastTurn().classList.contains("is-flagged")).toBe(true);
    expect(lastTurn().querySelector(".turn__eyebrow")!.textContent).toBe("Slow down");
  });

  it("flags an offline nudge", () => {
    post({ type: "hint", hint: "offline nudge", hint_level: 0, concept_tags: [], mode: "offline" });
    expect(lastTurn().querySelector(".turn__eyebrow")!.textContent).toBe("Offline nudge");
  });
});

describe("streaming", () => {
  it("opens a bubble with a caret", () => {
    post({ type: "streamStart" });
    expect($(".caret")).not.toBeNull();
  });

  it("appends each delta", () => {
    post({ type: "streamStart" });
    post({ type: "streamDelta", text: "Look " });
    post({ type: "streamDelta", text: "here." });
    expect(lastTurn().textContent).toContain("Look here.");
  });

  it("replaces the streaming bubble with the final hint", () => {
    post({ type: "streamStart" });
    post({ type: "streamDelta", text: "partial" });
    post({ type: "hint", hint: "the whole thing", hint_level: 1, concept_tags: [], mode: "hint" });
    expect($(".caret")).toBeNull();
    expect(turns()).toHaveLength(1);
    expect(lastTurn().textContent).toContain("the whole thing");
  });

  it("removes the bubble when the stream is abandoned", () => {
    post({ type: "streamStart" });
    post({ type: "streamAbort" });
    expect(turns()).toHaveLength(0);
  });
});

describe("the composer", () => {
  it("sends the typed question", () => {
    post({ type: "activeCode", code: "x = 1", fileName: "a.py", language: "Python" });
    (el("input") as HTMLTextAreaElement).value = "why does it crash?";
    (el("send") as HTMLButtonElement).click();
    const msg = lastSent("askHint");
    expect(msg.question).toBe("why does it crash?");
    expect(msg.code).toBe("x = 1");
    expect(msg.mode).toBe("hint");
  });

  it("clears the box after sending", () => {
    (el("input") as HTMLTextAreaElement).value = "q";
    (el("send") as HTMLButtonElement).click();
    expect((el("input") as HTMLTextAreaElement).value).toBe("");
  });

  it("ignores an empty question", () => {
    (el("input") as HTMLTextAreaElement).value = "   ";
    (el("send") as HTMLButtonElement).click();
    expect(lastSent("askHint")).toBeUndefined();
  });

  it("sends on ctrl+enter", () => {
    (el("input") as HTMLTextAreaElement).value = "q";
    el("input").dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true })
    );
    expect(lastSent("askHint")).toBeDefined();
  });

  it("does not send on a bare enter", () => {
    (el("input") as HTMLTextAreaElement).value = "q";
    el("input").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(lastSent("askHint")).toBeUndefined();
  });

  it("asks for a reflection quiz", () => {
    (el("quiz") as HTMLButtonElement).click();
    expect(lastSent("askHint").mode).toBe("reflect");
  });

  it("requests a reset", () => {
    (el("reset") as HTMLButtonElement).click();
    expect(lastSent("reset")).toBeDefined();
  });
});

describe("confidence", () => {
  const chips = () => $$(".conf") as HTMLButtonElement[];

  it("marks the selected chip", () => {
    chips()[1].click();
    expect(chips()[1].getAttribute("aria-pressed")).toBe("true");
    expect(chips()[0].getAttribute("aria-pressed")).toBe("false");
  });

  it("deselects when the same chip is clicked again", () => {
    chips()[1].click();
    chips()[1].click();
    expect(chips()[1].getAttribute("aria-pressed")).toBe("false");
  });

  it("rides along with the question", () => {
    chips()[2].click();
    (el("input") as HTMLTextAreaElement).value = "q";
    (el("send") as HTMLButtonElement).click();
    expect(lastSent("askHint").confidence).toBe(3);
  });

  it("resets after sending", () => {
    chips()[2].click();
    (el("input") as HTMLTextAreaElement).value = "q";
    (el("send") as HTMLButtonElement).click();
    expect(chips()[2].getAttribute("aria-pressed")).toBe("false");
  });

  it("is not sent for a non-hint mode", () => {
    chips()[2].click();
    post({ type: "hint", hint: "h", hint_level: 3, concept_tags: [], mode: "hint" });
    ($$(".actions button")[0] as HTMLButtonElement).click(); // switch to translate
    (el("input") as HTMLTextAreaElement).value = "my code";
    (el("send") as HTMLButtonElement).click();
    expect(lastSent("askHint").confidence).toBe(0);
  });
});

describe("guided exercises", () => {
  it("shows the explain-first gate with a skip action", () => {
    post({ type: "explainFirst", prompt: "What do you think this does?" });
    expect(lastTurn().querySelector(".turn__eyebrow")!.textContent).toBe("Explain first");
    expect($$(".actions button").map((b) => b.textContent)).toEqual(["Skip and get my hint"]);
  });

  it("sends the explanation rather than a new question", () => {
    post({ type: "explainFirst", prompt: "p" });
    (el("input") as HTMLTextAreaElement).value = "it averages a list";
    (el("send") as HTMLButtonElement).click();
    expect(lastSent("explainAnswer").explanation).toBe("it averages a list");
    expect(lastSent("askHint")).toBeUndefined();
  });

  it("skips the gate on request", () => {
    post({ type: "explainFirst", prompt: "p" });
    ($(".actions button") as HTMLButtonElement).click();
    expect(lastSent("explainSkip")).toBeDefined();
  });

  it("sends a prediction rather than a question", () => {
    post({ type: "predictFirst", snippet: "print(x)" });
    (el("input") as HTMLTextAreaElement).value = "it prints 3";
    (el("send") as HTMLButtonElement).click();
    expect(lastSent("predictAnswer").prediction).toBe("it prints 3");
  });

  it("builds a trace grid of the requested size", () => {
    post({
      type: "traceTable",
      snippet: "for i in range(3):",
      variables: ["i", "total"],
      steps: 3,
      prompt: "Trace the loop.",
    });
    expect($$(".trace__grid th").map((h) => h.textContent)).toEqual(["#", "i", "total"]);
    expect($$(".trace__cell")).toHaveLength(6);
  });

  it("labels each cell for screen readers", () => {
    post({ type: "traceTable", snippet: "s", variables: ["i"], steps: 2, prompt: "p" });
    const labels = $$(".trace__cell").map((c) => c.getAttribute("aria-label"));
    expect(labels).toEqual(["i after step 1", "i after step 2"]);
  });

  it("submits the filled grid as rows", () => {
    post({ type: "traceTable", snippet: "s", variables: ["i", "total"], steps: 2, prompt: "p" });
    const cells = $$(".trace__cell") as HTMLInputElement[];
    cells[0].value = "0";
    cells[1].value = "0";
    cells[2].value = "1";
    cells[3].value = "";
    ($(".trace .btn--primary") as HTMLButtonElement).click();
    expect(lastSent("traceAnswer").rows).toEqual([
      ["0", "0"],
      ["1", ""],
    ]);
  });

  it("removes the grid once submitted", () => {
    post({ type: "traceTable", snippet: "s", variables: ["i", "j"], steps: 1, prompt: "p" });
    ($(".trace .btn--primary") as HTMLButtonElement).click();
    expect($(".trace")).toBeNull();
  });
});

describe("panel chrome", () => {
  it("toggles the offline banner", () => {
    post({ type: "offline", value: true });
    expect((el("offlineBanner") as HTMLElement).hidden).toBe(false);
    post({ type: "offline", value: false });
    expect((el("offlineBanner") as HTMLElement).hidden).toBe(true);
  });

  it("shows the thinking indicator and disables Ask while loading", () => {
    post({ type: "loading", value: true });
    expect((el("loading") as HTMLElement).hidden).toBe(false);
    expect((el("send") as HTMLButtonElement).disabled).toBe(true);
    post({ type: "loading", value: false });
    expect((el("send") as HTMLButtonElement).disabled).toBe(false);
  });

  it("counts badges and lists them", () => {
    post({ type: "badges", badges: ["First Question", "Polyglot"] });
    expect(el("badgeCount").textContent).toBe("2 badges");
    expect($$(".badge")).toHaveLength(2);
  });

  it("uses the singular for one badge", () => {
    post({ type: "badges", badges: ["First Question"] });
    expect(el("badgeCount").textContent).toBe("1 badge");
  });

  it("hides the disclosure when there are no badges", () => {
    post({ type: "badges", badges: [] });
    expect((el("badgesWrap") as HTMLElement).hidden).toBe(true);
    expect(el("badgeCount").textContent).toBe("No badges yet");
  });

  it("switches the auth button between sign in and sign out", () => {
    post({ type: "authState", signedIn: true, label: "ada@uni.edu" });
    expect(el("authBtn").textContent).toBe("Sign out");
    expect(el("accountLabel").textContent).toBe("ada@uni.edu");
    (el("authBtn") as HTMLButtonElement).click();
    expect(lastSent("signOut")).toBeDefined();
  });

  it("asks to sign in when signed out", () => {
    post({ type: "authState", signedIn: false, label: "Not signed in" });
    (el("authBtn") as HTMLButtonElement).click();
    expect(lastSent("signIn")).toBeDefined();
  });

  it("reveals the review button and starts a review", () => {
    post({ type: "reviewDue", concepts: ["loops"] });
    const button = el("reviewBtn") as HTMLButtonElement;
    expect(button.hidden).toBe(false);
    button.click();
    expect(lastSent("startReview")).toBeDefined();
    expect(button.hidden).toBe(true);
  });

  it("refreshes the active file on request", () => {
    (el("refreshCode") as HTMLButtonElement).click();
    expect(lastSent("refreshCode")).toBeDefined();
  });
});

describe("errors and reset", () => {
  it("renders an error turn", () => {
    post({ type: "error", message: "Backend error (500)" });
    expect(lastTurn().classList.contains("is-error")).toBe(true);
    expect(lastTurn().textContent).toContain("Backend error (500)");
  });

  it("clears the transcript and shows the session summary", () => {
    post({ type: "userMessage", text: "q" });
    post({ type: "resetDone", summary: "- you practised loops" });
    const texts = turns().map((t) => t.textContent);
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain("you practised loops");
    expect(texts[1]).toContain("back at hint 1");
  });

  it("resets the stepper and the confidence chips", () => {
    post({ type: "hint", hint: "h", hint_level: 3, concept_tags: [], mode: "hint" });
    ($$(".conf")[1] as HTMLButtonElement).click();
    post({ type: "resetDone", summary: "" });
    expect((el("stepper") as HTMLElement).hidden).toBe(true);
    expect($$(".conf")[1].getAttribute("aria-pressed")).toBe("false");
  });
});

describe("persistence", () => {
  it("mirrors every turn to the extension", () => {
    post({ type: "userMessage", text: "q" });
    expect(lastSent("persistChat").messages).toHaveLength(1);
  });

  it("saves to webview state as well", () => {
    post({ type: "userMessage", text: "q" });
    expect(saved.turns).toHaveLength(1);
  });
});

describe("safety", () => {
  it("renders a student turn as text, never as markup", () => {
    post({ type: "userMessage", text: "<img src=x onerror=alert(1)>" });
    expect($(".turn--student")!.querySelector("img")).toBeNull();
    expect($(".turn--student")!.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("renders model output as text, never as markup", () => {
    post({
      type: "hint",
      hint: "<script>alert(1)</script>",
      hint_level: 1,
      concept_tags: [],
      mode: "hint",
    });
    expect(lastTurn().querySelector("script")).toBeNull();
    expect(lastTurn().textContent).toContain("<script>alert(1)</script>");
  });

  it("renders a concept tag as text", () => {
    post({
      type: "hint",
      hint: "h",
      hint_level: 1,
      concept_tags: ["<b>bold</b>"],
      mode: "hint",
    });
    expect($(".tag")!.querySelector("b")).toBeNull();
  });

  it("renders a trace variable name as text", () => {
    post({
      type: "traceTable",
      snippet: "s",
      variables: ["<b>i</b>", "total"],
      steps: 1,
      prompt: "p",
    });
    expect($(".trace__grid th:nth-child(2)")!.querySelector("b")).toBeNull();
  });
});

describe("the loading guard covers every entry point", () => {
  const startLoading = () => post({ type: "loading", value: true });

  it("disables the ask, quiz, reset and review buttons together", () => {
    startLoading();
    expect((el("send") as HTMLButtonElement).disabled).toBe(true);
    expect((el("quiz") as HTMLButtonElement).disabled).toBe(true);
    expect((el("reset") as HTMLButtonElement).disabled).toBe(true);
    expect((el("reviewBtn") as HTMLButtonElement).disabled).toBe(true);
  });

  it("re-enables them when the ask finishes", () => {
    startLoading();
    post({ type: "loading", value: false });
    expect((el("send") as HTMLButtonElement).disabled).toBe(false);
    expect((el("quiz") as HTMLButtonElement).disabled).toBe(false);
    expect((el("reset") as HTMLButtonElement).disabled).toBe(false);
  });

  it("ignores Ctrl+Enter while an ask is in flight", () => {
    // Only sendBtn.disabled used to be checked, so the keyboard shortcut
    // started a second stream that painted into the first one's bubble.
    (el("input") as HTMLTextAreaElement).value = "second question";
    startLoading();
    el("input").dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true })
    );
    expect(lastSent("askHint")).toBeUndefined();
  });

  it("ignores the reflection quiz button while an ask is in flight", () => {
    startLoading();
    el("quiz").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(lastSent("askHint")).toBeUndefined();
  });

  it("ignores reset while an ask is in flight", () => {
    startLoading();
    el("reset").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(lastSent("reset")).toBeUndefined();
  });

  it("still sends once the ask has finished", () => {
    startLoading();
    post({ type: "loading", value: false });
    (el("input") as HTMLTextAreaElement).value = "now please";
    el("send").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(lastSent("askHint").question).toBe("now please");
  });
});

describe("stream sequencing", () => {
  it("appends deltas that match the current stream", () => {
    post({ type: "streamStart", seq: 1 });
    post({ type: "streamDelta", seq: 1, text: "hello" });
    expect(lastTurn().textContent).toContain("hello");
  });

  it("ignores a delta from a superseded stream", () => {
    post({ type: "streamStart", seq: 1 });
    post({ type: "streamStart", seq: 2 });
    post({ type: "streamDelta", seq: 1, text: "STALE" });
    post({ type: "streamDelta", seq: 2, text: "fresh" });
    expect(lastTurn().textContent).toContain("fresh");
    expect(lastTurn().textContent).not.toContain("STALE");
  });

  it("ignores an abort from a superseded stream", () => {
    post({ type: "streamStart", seq: 1 });
    post({ type: "streamStart", seq: 2 });
    post({ type: "streamDelta", seq: 2, text: "keep me" });
    post({ type: "streamAbort", seq: 1 });
    expect(lastTurn().textContent).toContain("keep me");
  });

  it("removes the bubble on an abort of the current stream", () => {
    const before = turns().length;
    post({ type: "streamStart", seq: 1 });
    post({ type: "streamDelta", seq: 1, text: "half" });
    post({ type: "streamAbort", seq: 1 });
    expect(turns()).toHaveLength(before);
  });

  it("hides the streaming bubble from the live region", () => {
    // The chat is role=log aria-live=polite, so an unmuted streaming bubble
    // re-announces the whole partial hint on every token.
    post({ type: "streamStart", seq: 1 });
    expect(lastTurn().getAttribute("aria-hidden")).toBe("true");
  });

  it("marks the streaming body so raw text keeps its line breaks", () => {
    post({ type: "streamStart", seq: 1 });
    expect($(".turn__body--streaming")).not.toBeNull();
  });

  it("announces the finished turn normally", () => {
    post({ type: "streamStart", seq: 1 });
    post({ type: "streamDelta", seq: 1, text: "partial" });
    post({ type: "hint", seq: 1, hint: "done", hint_level: 1, concept_tags: [], mode: "hint" });
    expect(lastTurn().getAttribute("aria-hidden")).toBeNull();
    expect(lastTurn().textContent).toContain("done");
  });
});
