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
}

export const SUPPORTED_LANGUAGES: Record<string, LanguageInfo> = {
  python: {
    label: "Python",
    lensRegex: /^\s*(def|class)\s+\w+/,
  },
  javascript: {
    label: "JavaScript",
    lensRegex: /^\s*(export\s+)?(async\s+)?(function\s+\w+|class\s+\w+|(const|let|var)\s+\w+\s*=\s*(async\s*)?(\([^)]*\)|\w+)\s*=>)/,
  },
  java: {
    label: "Java",
    lensRegex: /^\s*(public|private|protected|static|final|abstract|class|interface|enum)\b.*(\{|\))\s*\{?\s*$/,
  },
  c: {
    label: "C",
    lensRegex: /^[A-Za-z_][\w\s\*]*\s[\w\*]+\s*\([^;]*\)\s*\{?\s*$/,
  },
  cpp: {
    label: "C++",
    lensRegex: /^\s*(class|struct)\s+\w+|^[A-Za-z_][\w\s\*&:<>,]*\s[\w\*&:]+\s*\([^;]*\)\s*(const)?\s*\{?\s*$/,
  },
  csharp: {
    label: "C#",
    lensRegex: /^\s*(public|private|protected|internal|static|class|interface|struct|enum)\b.*(\{|\))\s*\{?\s*$/,
  },
  typescript: {
    label: "TypeScript",
    lensRegex: /^\s*(export\s+)?(async\s+)?(function\s+\w+|class\s+\w+|interface\s+\w+|(const|let|var)\s+\w+\s*=\s*(async\s*)?(\([^)]*\)|\w+)\s*=>)/,
  },
  go: {
    label: "Go",
    lensRegex: /^\s*func\s+(\(\w+ [^)]+\)\s*)?\w+\s*\(/,
  },
  rust: {
    label: "Rust",
    lensRegex: /^\s*(pub\s+)?(async\s+)?(fn\s+\w+|struct\s+\w+|enum\s+\w+|impl\b|trait\s+\w+)/,
  },
  sql: {
    label: "SQL",
    lensRegex: /^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|WITH)\b/i,
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
