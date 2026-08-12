import {
  SUPPORTED_LANGUAGES,
  SUPPORTED_LANGUAGE_IDS,
  isSupportedLanguage,
  languageLabel,
  supportedLanguageList,
} from "../languages";

describe("language registry", () => {
  it("supports the ten tutoring languages", () => {
    expect(SUPPORTED_LANGUAGE_IDS.sort()).toEqual(
      ["c", "cpp", "csharp", "go", "java", "javascript",
       "python", "rust", "sql", "typescript"].sort()
    );
  });

  it("recognises supported languageIds", () => {
    expect(isSupportedLanguage("python")).toBe(true);
    expect(isSupportedLanguage("cpp")).toBe(true);
    expect(isSupportedLanguage("ruby")).toBe(false);
    expect(isSupportedLanguage("")).toBe(false);
  });

  it("maps ids to display labels", () => {
    expect(languageLabel("cpp")).toBe("C++");
    expect(languageLabel("csharp")).toBe("C#");
  });

  it("lists all labels for user-facing messages", () => {
    const list = supportedLanguageList();
    expect(list).toContain("Python");
    expect(list).toContain("C++");
  });
});

describe("lensRegex definition detection", () => {
  const match = (lang: string, line: string) =>
    SUPPORTED_LANGUAGES[lang].lensRegex.test(line);

  it("python: def and class", () => {
    expect(match("python", "def add(a, b):")).toBe(true);
    expect(match("python", "class Dog:")).toBe(true);
    expect(match("python", "x = 1")).toBe(false);
  });

  it("javascript: functions, classes and arrow functions", () => {
    expect(match("javascript", "function add(a, b) {")).toBe(true);
    expect(match("javascript", "const add = (a, b) => {")).toBe(true);
    expect(match("javascript", "export async function main() {")).toBe(true);
    expect(match("javascript", "class Dog {")).toBe(true);
    expect(match("javascript", "let x = 1;")).toBe(false);
  });

  it("java: method and class headers", () => {
    expect(match("java", "public class Main {")).toBe(true);
    expect(match("java", "public static void main(String[] args) {")).toBe(true);
    expect(match("java", "int x = 1;")).toBe(false);
  });

  it("c: function definitions but not calls or prototypes", () => {
    expect(match("c", "int main(void) {")).toBe(true);
    expect(match("c", "void swap(int *a, int *b)")).toBe(true);
    expect(match("c", "int add(int a, int b);")).toBe(false);
    expect(match("c", "    printf(\"hello\");")).toBe(false);
  });

  it("cpp: classes and functions", () => {
    expect(match("cpp", "class Dog {")).toBe(true);
    expect(match("cpp", "int main() {")).toBe(true);
    expect(match("cpp", "std::vector<int> makeList(int n) {")).toBe(true);
    expect(match("cpp", "x++;")).toBe(false);
  });

  it("csharp: class and method headers", () => {
    expect(match("csharp", "public class Program {")).toBe(true);
    expect(match("csharp", "static void Main(string[] args) {")).toBe(true);
    expect(match("csharp", "int x = 1;")).toBe(false);
  });
});

describe("every language knows what one of its import lines looks like", () => {
  const cases: Array<[string, string]> = [
    ["python", "from stats import mean"],
    ["javascript", "import { mean } from './stats.js';"],
    ["typescript", "import type { Stats } from './stats';"],
    ["java", "import java.util.List;"],
    ["csharp", "using System.Collections.Generic;"],
    ["c", "#include <stdio.h>"],
    ["cpp", "#include <vector>"],
    ["go", "import \"fmt\""],
    ["rust", "use std::collections::HashMap;"],
    // Fix round 1: cases the code review found broken by execution.
    ["java", "import static org.junit.Assert.*;"],
    ["c", "#ifndef FOO_H"],
    ["cpp", "#ifndef FOO_H"],
    ["go", ")"],
    ["rust", "pub use crate::foo::Bar;"],
    ["rust", "pub mod foo;"],
  ];

  it.each(cases)("%s recognises %s", (id, line) => {
    expect(SUPPORTED_LANGUAGES[id].importRegex.test(line)).toBe(true);
  });

  it("does not mistake a function definition for an import", () => {
    expect(SUPPORTED_LANGUAGES.python.importRegex.test("def area(r):")).toBe(false);
    expect(SUPPORTED_LANGUAGES.java.importRegex.test("public class Stats {")).toBe(false);
  });

  it("does not mistake a definition for an import, in every language the fix round touched", () => {
    // "static" is now part of the Java pattern and "pub" is now part of the
    // Rust pattern, so these specifically check that the looser regexes
    // still require the import/use/mod keyword itself, not just a neighbour.
    expect(SUPPORTED_LANGUAGES.java.importRegex.test("public static void main(String[] args) {")).toBe(false);
    expect(SUPPORTED_LANGUAGES.c.importRegex.test("int main(void) {")).toBe(false);
    expect(SUPPORTED_LANGUAGES.cpp.importRegex.test("class Dog {")).toBe(false);
    expect(SUPPORTED_LANGUAGES.go.importRegex.test("func main() {")).toBe(false);
    expect(SUPPORTED_LANGUAGES.rust.importRegex.test("pub fn main() {")).toBe(false);
  });

  it("gives SQL a pattern that matches nothing, because it has no imports", () => {
    expect(SUPPORTED_LANGUAGES.sql.importRegex.test("SELECT * FROM t;")).toBe(false);
  });
});
