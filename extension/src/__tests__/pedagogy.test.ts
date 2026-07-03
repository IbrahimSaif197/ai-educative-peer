import {
  codeFingerprint,
  frameExplainedQuestion,
  frameTranslation,
  questionForMode,
} from "../pedagogy";

describe("codeFingerprint", () => {
  it("is stable for the same input", () => {
    expect(codeFingerprint("x = 1")).toBe(codeFingerprint("x = 1"));
  });

  it("differs for different input", () => {
    expect(codeFingerprint("x = 1")).not.toBe(codeFingerprint("x = 2"));
  });
});

describe("frameExplainedQuestion", () => {
  it("combines explanation and question", () => {
    const framed = frameExplainedQuestion("it loops over items", "why does it crash?");
    expect(framed).toContain("My understanding of the code: it loops over items");
    expect(framed).toContain("My question: why does it crash?");
  });
});

describe("questionForMode", () => {
  it("frames translate input", () => {
    expect(questionForMode("translate", "for x in xs: pass")).toBe(
      frameTranslation("for x in xs: pass")
    );
  });

  it("returns empty for translate without input", () => {
    expect(questionForMode("translate", "  ")).toBe("");
  });

  it("supplies canned question for reflect", () => {
    expect(questionForMode("reflect", "")).toContain("Quiz me");
  });

  it("supplies canned question for worked-example", () => {
    expect(questionForMode("worked-example", "")).toContain("worked example");
  });

  it("passes through student text unchanged for reflect answers", () => {
    expect(questionForMode("reflect", "because indexes start at 0")).toBe(
      "because indexes start at 0"
    );
  });

  it("returns empty for hint mode without input", () => {
    expect(questionForMode("hint", "")).toBe("");
  });
});
