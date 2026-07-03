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
