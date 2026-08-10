import * as fs from "fs";
import * as path from "path";

import {
  MAX_HINT_LEVEL,
  codeFingerprint,
  formatExceptionQuestion,
  frameExplainedQuestion,
  framePrediction,
  frameSubgoalLabels,
  frameTraceTable,
  frameTranslation,
  looksLikeErrorText,
  questionForMode,
} from "../pedagogy";

describe("MAX_HINT_LEVEL matches the backend", () => {
  // The ladder's top is declared twice - once per language - because a VS Code
  // extension and a FastAPI service share no build step. A comment asking the
  // next person to change both is not a mechanism; this is. If the two drift,
  // the panel and the server disagree about how deep the student is, which is
  // exactly the class of bug that shipped a status bar reading "hint 3/3"
  // beside a panel showing four filled rungs.
  const modelsPy = path.join(__dirname, "..", "..", "..", "backend", "models.py");

  it("finds the backend declaration", () => {
    expect(fs.existsSync(modelsPy)).toBe(true);
    expect(fs.readFileSync(modelsPy, "utf8")).toMatch(/^MAX_HINT_LEVEL\s*=\s*\d+$/m);
  });

  it("agrees with backend/models.py", () => {
    const match = fs.readFileSync(modelsPy, "utf8").match(/^MAX_HINT_LEVEL\s*=\s*(\d+)$/m);
    expect(Number(match![1])).toBe(MAX_HINT_LEVEL);
  });
});

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

describe("frameTraceTable", () => {
  const SNIPPET = "for i in range(3):\n    total += i";

  it("renders a header row from the variable names", () => {
    const text = frameTraceTable(SNIPPET, ["i", "total"], [["0", "0"]]);
    expect(text).toContain("step | i | total");
  });

  it("numbers the rows from 1", () => {
    const text = frameTraceTable(SNIPPET, ["i"], [["0"], ["1"]]);
    expect(text).toContain("1 | 0");
    expect(text).toContain("2 | 1");
  });

  it("marks blank cells so the tutor can see what they skipped", () => {
    const text = frameTraceTable(SNIPPET, ["i", "total"], [["0", ""]]);
    expect(text).toContain("1 | 0 | ?");
  });

  it("marks whitespace-only cells as unanswered too", () => {
    expect(frameTraceTable(SNIPPET, ["i"], [["   "]])).toContain("1 | ?");
  });

  it("fills in a short row rather than losing a column", () => {
    expect(frameTraceTable(SNIPPET, ["i", "total"], [["0"]])).toContain("1 | 0 | ?");
  });

  it("survives a missing row", () => {
    expect(() =>
      frameTraceTable(SNIPPET, ["i"], [undefined as unknown as string[]])
    ).not.toThrow();
  });

  it("includes the snippet being traced", () => {
    expect(frameTraceTable(SNIPPET, ["i"], [["0"]])).toContain("total += i");
  });

  it("ends by asking where the trace diverges", () => {
    expect(frameTraceTable(SNIPPET, ["i"], [["0"]])).toContain("Where does my trace go wrong?");
  });
});

describe("frameSubgoalLabels", () => {
  it("presents the labels as the student's own", () => {
    const text = frameSubgoalLabels("1. set up a counter\n2. add each item");
    expect(text).toContain("what I think each step");
    expect(text).toContain("set up a counter");
  });

  it("trims surrounding whitespace", () => {
    expect(frameSubgoalLabels("  labels  ")).toContain("labels");
    expect(frameSubgoalLabels("  labels  ")).not.toContain("  labels  ");
  });
});

describe("questionForMode with the new modes", () => {
  it("frames subgoal labels", () => {
    expect(questionForMode("subgoal-label", "step 1 counts")).toContain("step 1 counts");
  });

  it("returns nothing for empty subgoal labels", () => {
    expect(questionForMode("subgoal-label", "   ")).toBe("");
  });
});
