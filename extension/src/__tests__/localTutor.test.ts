import {
  localLineHint,
  localRuleCount,
  matchLocalRule,
  offlineTutorReply,
} from "../localTutor";
import { SUPPORTED_LANGUAGE_IDS } from "../languages";

describe("matchLocalRule", () => {
  it("catches assignment where a comparison belongs in Python", () => {
    const rule = matchLocalRule("if count = 1:", "python");
    expect(rule?.concept).toBe("comparison");
  });

  it("catches a mutable default argument", () => {
    expect(matchLocalRule("def add(item, bucket=[]):", "python")?.concept).toBe("mutability");
  });

  it("catches loose equality in JavaScript", () => {
    expect(matchLocalRule("if (a == b) {", "javascript")?.concept).toBe("equality");
  });

  it("catches unfreed memory in C", () => {
    expect(matchLocalRule("int *p = malloc(10);", "c")?.concept).toBe("memory-allocation");
  });

  it("catches a comparison against NULL in SQL", () => {
    expect(matchLocalRule("WHERE name = NULL", "sql")?.concept).toBe("null-handling");
  });

  it("catches unwrap in Rust", () => {
    expect(matchLocalRule("let v = maybe.unwrap();", "rust")?.concept).toBe("option");
  });

  it("falls back to shared rules for an unknown language", () => {
    expect(matchLocalRule("while (true) {", "haskell")?.concept).toBe("while-loop");
  });

  it("ignores blank lines", () => {
    expect(matchLocalRule("   ", "python")).toBeUndefined();
  });

  it("returns undefined when nothing matches", () => {
    expect(matchLocalRule("import os", "python")).toBeUndefined();
  });

  it("prefers the language rule over a shared one", () => {
    // Both the JS equality rule and no shared rule apply; language first.
    expect(matchLocalRule("if (x == null) {", "javascript")?.concept).toBe("equality");
  });

  it("never gives away a fix", () => {
    const lines = ["if x = 1:", "int *p = malloc(4);", "SELECT * FROM t"];
    for (const line of lines) {
      const rule =
        matchLocalRule(line, "python") ??
        matchLocalRule(line, "c") ??
        matchLocalRule(line, "sql");
      expect(rule?.question).toMatch(/\?$/);
    }
  });

  it("keeps questions short enough for an inline decoration", () => {
    for (const languageId of SUPPORTED_LANGUAGE_IDS) {
      const line = "while (true) {";
      const rule = matchLocalRule(line, languageId);
      if (rule) expect(rule.question.split(" ").length).toBeLessThanOrEqual(14);
    }
  });
});

describe("localLineHint", () => {
  it("returns the matching question and concept", () => {
    expect(localLineHint("if x = 1:", "python")).toEqual({
      hint: "Is that comparing two values, or assigning one?",
      concept: "comparison",
    });
  });

  it("returns an empty hint when no rule fits", () => {
    expect(localLineHint("pass", "python")).toEqual({ hint: "", concept: "general" });
  });
});

describe("localRuleCount", () => {
  it("gives every supported language its own rules on top of the shared ones", () => {
    for (const languageId of SUPPORTED_LANGUAGE_IDS) {
      expect(localRuleCount(languageId)).toBeGreaterThan(localRuleCount("unknown-language"));
    }
  });
});

describe("offlineTutorReply", () => {
  it("says plainly that it is not the real tutor", () => {
    expect(offlineTutorReply("x = 1", "python")).toContain("offline");
  });

  it("uses a matching rule from anywhere in the file", () => {
    const code = "import os\n\nif count = 1:\n    pass\n";
    expect(offlineTutorReply(code, "python")).toContain("comparing two values");
  });

  it("falls back to a metacognitive prompt when nothing matches", () => {
    expect(offlineTutorReply("import os\n", "python", 0)).toContain(
      "Read the failing line out loud"
    );
  });

  it("rotates the generic prompt so it does not repeat verbatim", () => {
    const first = offlineTutorReply("import os", "python", 0);
    const second = offlineTutorReply("import os", "python", 1);
    expect(first).not.toBe(second);
  });

  it("wraps a negative seed back into range", () => {
    expect(() => offlineTutorReply("import os", "python", -3)).not.toThrow();
  });

  it("always ends with the tutor's closing question", () => {
    expect(offlineTutorReply("x = 1", "python").trim()).toMatch(
      /What do you think should happen next\?$/
    );
  });

  it("handles empty code", () => {
    expect(offlineTutorReply("", "python")).toContain("offline");
  });
});
