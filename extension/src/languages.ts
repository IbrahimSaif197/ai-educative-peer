/**
 * Languages EduPeer can tutor. Keys are VS Code languageIds and match the
 * backend registry in backend/languages.py.
 */

export interface LanguageInfo {
  /** Human-readable name shown in messages and the sidebar chip. */
  label: string;
  /**
   * Matches "definition-like" lines (functions/classes) that get a
   * standing "💡 Get a hint" CodeLens.
   */
  lensRegex: RegExp;
  /**
   * Matches a line that belongs to the file's header: an import, an include,
   * a package or namespace declaration. `codeDigest` keeps the header band so
   * the tutor can see what the block depends on, however far down the file
   * the block is.
   */
  importRegex: RegExp;
  /** Line-comment token, used to find seeded `bug:` markers. */
  lineComment: string;
  /** Block-comment delimiters, for the languages whose demos use them. */
  blockComment?: [string, string];
}

export const SUPPORTED_LANGUAGES: Record<string, LanguageInfo> = {
  python: {
    label: "Python",
    lensRegex: /^\s*(def|class)\s+\w+/,
    importRegex: /^\s*(import\s+\w|from\s+[\w.]+\s+import\b)/,
    lineComment: "#",
  },
  javascript: {
    label: "JavaScript",
    lensRegex: /^\s*(export\s+)?(async\s+)?(function\s+\w+|class\s+\w+|(const|let|var)\s+\w+\s*=\s*(async\s*)?(\([^)]*\)|\w+)\s*=>)/,
    importRegex: /^\s*(import\b|export\s+.*\bfrom\b|(const|let|var)\s+.*\brequire\s*\()/,
    lineComment: "//",
    blockComment: ["/*", "*/"],
  },
  java: {
    label: "Java",
    lensRegex: /^\s*(public|private|protected|static|final|abstract|class|interface|enum)\b.*(\{|\))\s*\{?\s*$/,
    importRegex: /^\s*(import|package)\s+[\w.*]+\s*;/,
    lineComment: "//",
    blockComment: ["/*", "*/"],
  },
  c: {
    label: "C",
    lensRegex: /^[A-Za-z_][\w\s\*]*\s[\w\*]+\s*\([^;]*\)\s*\{?\s*$/,
    importRegex: /^\s*#\s*(include|define|pragma)\b/,
    lineComment: "//",
    blockComment: ["/*", "*/"],
  },
  cpp: {
    label: "C++",
    lensRegex: /^\s*(class|struct)\s+\w+|^[A-Za-z_][\w\s\*&:<>,]*\s[\w\*&:]+\s*\([^;]*\)\s*(const)?\s*\{?\s*$/,
    importRegex: /^\s*(#\s*(include|define|pragma)\b|using\s+namespace\b)/,
    lineComment: "//",
    blockComment: ["/*", "*/"],
  },
  csharp: {
    label: "C#",
    lensRegex: /^\s*(public|private|protected|internal|static|class|interface|struct|enum)\b.*(\{|\))\s*\{?\s*$/,
    importRegex: /^\s*(using|namespace)\s+[\w.]+/,
    lineComment: "//",
    blockComment: ["/*", "*/"],
  },
  typescript: {
    label: "TypeScript",
    lensRegex: /^\s*(export\s+)?(async\s+)?(function\s+\w+|class\s+\w+|interface\s+\w+|(const|let|var)\s+\w+\s*=\s*(async\s*)?(\([^)]*\)|\w+)\s*=>)/,
    importRegex: /^\s*(import\b|export\s+.*\bfrom\b|(const|let|var)\s+.*\brequire\s*\()/,
    lineComment: "//",
    blockComment: ["/*", "*/"],
  },
  go: {
    label: "Go",
    lensRegex: /^\s*func\s+(\(\w+ [^)]+\)\s*)?\w+\s*\(/,
    importRegex: /^\s*(import\b|package\s+\w|\s*"[\w./-]+"\s*$)/,
    lineComment: "//",
    blockComment: ["/*", "*/"],
  },
  rust: {
    label: "Rust",
    lensRegex: /^\s*(pub\s+)?(async\s+)?(fn\s+\w+|struct\s+\w+|enum\s+\w+|impl\b|trait\s+\w+)/,
    importRegex: /^\s*(use\s+\w|mod\s+\w|extern\s+crate\b)/,
    lineComment: "//",
    blockComment: ["/*", "*/"],
  },
  sql: {
    label: "SQL",
    lensRegex: /^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|WITH)\b/i,
    importRegex: /(?!)/,
    lineComment: "--",
  },
};

export const SUPPORTED_LANGUAGE_IDS = Object.keys(SUPPORTED_LANGUAGES);

export function isSupportedLanguage(languageId: string): boolean {
  return languageId in SUPPORTED_LANGUAGES;
}

export function languageLabel(languageId: string): string {
  return SUPPORTED_LANGUAGES[languageId]?.label ?? languageId;
}

export function supportedLanguageList(): string {
  return SUPPORTED_LANGUAGE_IDS.map((id) => SUPPORTED_LANGUAGES[id].label).join(", ");
}
