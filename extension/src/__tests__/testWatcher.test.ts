import { TEST_COMMAND_RE, appendBounded, failureTail } from "../testWatcher";

describe("TEST_COMMAND_RE", () => {
  it.each([
    "pytest tests/",
    "npm test",
    "npm run test",
    "yarn test",
    "python -m unittest discover",
    "go test ./...",
    "cargo test",
    "dotnet test",
    "npx jest --watch",
  ])("matches %s", (cmd) => {
    expect(TEST_COMMAND_RE.test(cmd)).toBe(true);
  });

  it.each(["npm install", "git status", "python main.py", "ls -la"])(
    "does not match %s",
    (cmd) => {
      expect(TEST_COMMAND_RE.test(cmd)).toBe(false);
    }
  );
});

describe("appendBounded", () => {
  it("keeps only the newest characters when over the cap", () => {
    const out = appendBounded("a".repeat(10), "b".repeat(10), 12);
    expect(out).toHaveLength(12);
    expect(out.endsWith("b".repeat(10))).toBe(true);
  });

  it("appends normally under the cap", () => {
    expect(appendBounded("abc", "def", 100)).toBe("abcdef");
  });
});

describe("failureTail", () => {
  it("returns the last non-empty lines", () => {
    const output = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    const tail = failureTail(output, 5);
    expect(tail.split("\n")).toHaveLength(5);
    expect(tail).toContain("line 99");
  });

  it("drops blank lines", () => {
    expect(failureTail("a\n\n\nb\n", 10)).toBe("a\nb");
  });
});
