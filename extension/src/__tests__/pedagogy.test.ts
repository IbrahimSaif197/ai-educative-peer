import {
  codeFingerprint,
  formatExceptionQuestion,
  frameExplainedQuestion,
  framePrediction,
  frameTranslation,
  looksLikeErrorText,
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

describe("looksLikeErrorText", () => {
  it.each([
    ['Traceback (most recent call last):\n  File "a.py", line 3\nZeroDivisionError: division by zero'],
    ["TypeError: Cannot read properties of undefined (reading 'x')\n    at main (/app/index.js:4:12)"],
    ["Exception in thread \"main\" java.lang.NullPointerException\n\tat Demo.main(Demo.java:7)"],
    ["main.c:12:5: error: expected ';' before 'return'"],
    ["error CS1002: ; expected"],
    ["Segmentation fault (core dumped)"],
  ])("detects %s", (text) => {
    expect(looksLikeErrorText(text)).toBe(true);
  });

  it("does not flag ordinary questions", () => {
    expect(looksLikeErrorText("why does my loop print 9 instead of 10?")).toBe(false);
  });

  it("does not flag ordinary code", () => {
    expect(looksLikeErrorText("for i in range(10):\n    print(i)")).toBe(false);
  });
});

describe("framePrediction", () => {
  it("includes snippet and prediction", () => {
    const q = framePrediction("print(1//2)", "prints 0.5");
    expect(q).toContain("print(1//2)");
    expect(q).toContain("My prediction: prints 0.5");
  });
});

describe("formatExceptionQuestion", () => {
  it("includes description, frame and variables", () => {
    const q = formatExceptionQuestion(
      "ZeroDivisionError",
      "divide",
      "calc.py:3",
      [{ name: "b", value: "0" }]
    );
    expect(q).toContain("ZeroDivisionError");
    expect(q).toContain("divide");
    expect(q).toContain("b = 0");
  });

  it("caps variables at 15", () => {
    const vars = Array.from({ length: 30 }, (_, i) => ({ name: `v${i}`, value: "1" }));
    const q = formatExceptionQuestion("E", "f", "a.py:1", vars);
    expect(q).toContain("v14 =");
    expect(q).not.toContain("v15 =");
  });
});
