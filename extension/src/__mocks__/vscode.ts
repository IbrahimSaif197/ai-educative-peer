/**
 * A working subset of the VS Code API, enough to unit-test the modules that
 * import it.
 *
 * Where behaviour matters (EventEmitter, MockRange/Position arithmetic, the
 * disposable contract) this is a real implementation rather than a stub, so
 * tests exercise the module under test instead of a fake. Where only the call
 * matters, it is a jest.fn() the test can assert on.
 *
 * Call `__reset()` in beforeEach: the module is cached per test file, so
 * without it, recorded calls and registered handlers leak between tests.
 */

// --------------------------------------------------------------- primitives

class Position {
  constructor(public readonly line: number, public readonly character: number) {}
}

class MockRange {
  readonly start: Position;
  readonly end: Position;
  constructor(
    startLine: number | Position,
    startChar?: number | Position,
    endLine?: number,
    endChar?: number
  ) {
    if (startLine instanceof Position) {
      this.start = startLine;
      this.end = startChar as Position;
    } else {
      this.start = new Position(startLine as number, startChar as number);
      this.end = new Position(endLine as number, endChar as number);
    }
  }

  /** Matches vscode.Range: true when start and end are the same position. */
  get isEmpty(): boolean {
    return (
      this.start.line === this.end.line && this.start.character === this.end.character
    );
  }
}

class MockSelection extends MockRange {
  get active(): Position {
    return this.end;
  }
}

class ThemeColor {
  constructor(public readonly id: string) {}
}

class MarkdownString {
  value: string;
  isTrusted: boolean | { enabledCommands: readonly string[] } = false;
  constructor(value?: string, public readonly supportThemeIcons?: boolean) {
    this.value = value ?? "";
  }
  appendMarkdown(text: string): MarkdownString {
    this.value += text;
    return this;
  }
}

class Hover {
  constructor(public readonly contents: MarkdownString) {}
}

class CodeLens {
  constructor(public readonly range: MockRange, public readonly command?: any) {}
}

const CodeActionKind = { QuickFix: "quickfix" };

class CodeAction {
  command?: any;
  diagnostics?: any[];
  constructor(public readonly title: string, public readonly kind?: string) {}
}

const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 };

/** Mirrors vscode.SymbolKind's numbering; focusScope filters on these. */
const SymbolKind = {
  File: 0, Module: 1, Namespace: 2, Package: 3, Class: 4, Method: 5,
  Property: 6, Field: 7, Constructor: 8, Enum: 9, Interface: 10,
  Function: 11, Variable: 12, Constant: 13, String: 14, Number: 15,
  Boolean: 16, Array: 17, Object: 18, Key: 19, Null: 20, EnumMember: 21,
  Struct: 22, Event: 23, Operator: 24, TypeParameter: 25,
};

class Diagnostic {
  source?: string;
  code?: string;
  constructor(
    public readonly range: MockRange,
    public readonly message: string,
    public readonly severity?: number
  ) {}
}

const DecorationRangeBehavior = {
  OpenOpen: 0,
  ClosedClosed: 1,
  OpenClosed: 2,
  ClosedOpen: 3,
};
const OverviewRulerLane = { Left: 1, Center: 2, Right: 4, Full: 7 };
const StatusBarAlignment = { Left: 1, Right: 2 };
const ViewColumn = { One: 1, Two: 2, Three: 3 };

/** Real listener behaviour — several tests depend on events actually firing. */
class EventEmitter<T> {
  private listeners: Array<(value: T) => void> = [];
  readonly event = (listener: (value: T) => void) => {
    this.listeners.push(listener);
    return {
      dispose: () => {
        this.listeners = this.listeners.filter((l) => l !== listener);
      },
    };
  };
  fire(value: T): void {
    for (const listener of [...this.listeners]) listener(value);
  }
  dispose(): void {
    this.listeners = [];
  }
}

// ------------------------------------------------------------------ recorder

/** Everything a test might want to inspect after exercising a module. */
const __state = {
  commands: new Map<string, (...args: any[]) => any>(),
  decorationTypes: [] as any[],
  diagnosticCollections: [] as any[],
  statusBarItems: [] as any[],
  webviewPanels: [] as any[],
  codeLensProviders: [] as any[],
  hoverProviders: [] as any[],
  codeActionProviders: [] as any[],
  webviewViewProviders: new Map<string, any>(),
  /** The handler registered for `vscode://` links, so tests can fire one. */
  uriHandler: undefined as { handleUri(uri: any): void } | undefined,
  debugTrackerFactories: [] as any[],
  /** Queued answers for showInformationMessage, consumed in order. */
  infoMessageAnswers: [] as Array<string | undefined>,
  /** Queued answers for showInputBox. */
  inputBoxAnswers: [] as Array<string | undefined>,
  configuration: {} as Record<string, any>,
  listeners: {
    activeEditor: [] as Array<(e: any) => void>,
    textDocument: [] as Array<(e: any) => void>,
    closeTextDocument: [] as Array<(e: any) => void>,
    selection: [] as Array<(e: any) => void>,
    configuration: [] as Array<(e: any) => void>,
  },
};

const disposable = () => ({ dispose: jest.fn() });

function push<T>(list: T[], item: T) {
  list.push(item);
  return disposable();
}

// -------------------------------------------------------------------- window

const mockWindow = {
  activeTextEditor: undefined as any,
  visibleTextEditors: [] as any[],

  showInformationMessage: jest.fn((..._args: any[]) =>
    Promise.resolve(__state.infoMessageAnswers.shift())
  ),
  showWarningMessage: jest.fn((..._args: any[]) => Promise.resolve(undefined)),
  showErrorMessage: jest.fn((..._args: any[]) => Promise.resolve(undefined)),
  showInputBox: jest.fn((..._args: any[]) =>
    Promise.resolve(__state.inputBoxAnswers.shift())
  ),

  onDidChangeActiveTextEditor: jest.fn((fn: any) => push(__state.listeners.activeEditor, fn)),
  onDidChangeTextEditorSelection: jest.fn((fn: any) => push(__state.listeners.selection, fn)),

  createTextEditorDecorationType: jest.fn((options: any) => {
    const type = { options, dispose: jest.fn() };
    __state.decorationTypes.push(type);
    return type;
  }),

  createStatusBarItem: jest.fn((alignment: number, priority: number) => {
    const item = {
      alignment,
      priority,
      text: "",
      tooltip: "",
      command: undefined as any,
      backgroundColor: undefined as any,
      show: jest.fn(),
      hide: jest.fn(),
      dispose: jest.fn(),
    };
    __state.statusBarItems.push(item);
    return item;
  }),

  createWebviewPanel: jest.fn(
    (viewType: string, title: string, column: number, options: any) => {
      const panel = {
        viewType,
        title,
        column,
        options,
        webview: { html: "" },
        dispose: jest.fn(),
      };
      __state.webviewPanels.push(panel);
      return panel;
    }
  ),

  registerWebviewViewProvider: jest.fn((viewType: string, provider: any, options?: any) => {
    __state.webviewViewProviders.set(viewType, { provider, options });
    return disposable();
  }),

  registerUriHandler: jest.fn((handler: any) => {
    __state.uriHandler = handler;
    return disposable();
  }),
};

// ----------------------------------------------------------------- workspace

const workspace = {
  getConfiguration: jest.fn((_section?: string) => ({
    get: jest.fn((key: string, fallback: any) =>
      key in __state.configuration ? __state.configuration[key] : fallback
    ),
  })),
  onDidChangeTextDocument: jest.fn((fn: any) => push(__state.listeners.textDocument, fn)),
  onDidCloseTextDocument: jest.fn((fn: any) => push(__state.listeners.closeTextDocument, fn)),
  onDidChangeConfiguration: jest.fn((fn: any) => push(__state.listeners.configuration, fn)),
  openTextDocument: jest.fn((uri: any) =>
    Promise.resolve(__makeDocument("line one\nline two\nline three", "python", String(uri)))
  ),
};

// ------------------------------------------------------------------ commands

const commands = {
  registerCommand: jest.fn((id: string, handler: (...args: any[]) => any) => {
    __state.commands.set(id, handler);
    return disposable();
  }),
  executeCommand: jest.fn((..._args: any[]) => Promise.resolve(undefined)),
};

// ----------------------------------------------------------------- languages

const languages = {
  createDiagnosticCollection: jest.fn((name: string) => {
    const entries = new Map<string, any[]>();
    const collection = {
      name,
      set: jest.fn((uri: any, diags: any[]) => entries.set(String(uri), diags)),
      get: jest.fn((uri: any) => entries.get(String(uri))),
      delete: jest.fn((uri: any) => entries.delete(String(uri))),
      clear: jest.fn(() => entries.clear()),
      dispose: jest.fn(),
    };
    __state.diagnosticCollections.push(collection);
    return collection;
  }),
  registerCodeLensProvider: jest.fn((selector: any, provider: any) =>
    push(__state.codeLensProviders, { selector, provider })
  ),
  registerHoverProvider: jest.fn((selector: any, provider: any) =>
    push(__state.hoverProviders, { selector, provider })
  ),
  registerCodeActionsProvider: jest.fn((selector: any, provider: any, meta?: any) =>
    push(__state.codeActionProviders, { selector, provider, meta })
  ),
};

// --------------------------------------------------------------------- debug

const debug = {
  registerDebugAdapterTrackerFactory: jest.fn((selector: string, factory: any) =>
    push(__state.debugTrackerFactories, { selector, factory })
  ),
};

// ----------------------------------------------------------------------- env

const env = {
  openExternal: jest.fn((..._args: any[]) => Promise.resolve(true)),
  clipboard: { writeText: jest.fn(() => Promise.resolve()) },
};

// ----------------------------------------------------------------------- Uri

const Uri = {
  joinPath: (base: any, ...parts: string[]) => {
    const joined = [String(base?.path ?? base ?? ""), ...parts].join("/");
    return { path: joined, fsPath: joined, toString: () => joined };
  },
  parse: (value: string) => ({ path: value, fsPath: value, toString: () => value }),
  file: (value: string) => ({ path: value, fsPath: value, toString: () => `file://${value}` }),
};

// ------------------------------------------------------------------- helpers

/** Build a TextDocument stand-in from source text. */
function __makeDocument(text: string, languageId = "python", path = "/tmp/demo.py") {
  const lines = text.split("\n");
  return {
    languageId,
    fileName: path,
    lineCount: lines.length,
    version: 1,
    uri: { toString: () => `file://${path}`, fsPath: path, path },
    getText: (range?: MockRange) => {
      if (!range) return text;
      return lines.slice(range.start.line, range.end.line + 1).join("\n");
    },
    lineAt: (line: number) => ({ text: lines[line] ?? "" }),
  };
}

function __makeEditor(document: any, line = 0, character = 0) {
  const position = new Position(line, character);
  return {
    document,
    selection: new MockSelection(position, position),
    setDecorations: jest.fn(),
    revealRange: jest.fn(),
  };
}

/** Invoke a command the way VS Code would. Throws if it was never registered. */
function __runCommand(id: string, ...args: any[]): any {
  const handler = __state.commands.get(id);
  if (!handler) throw new Error(`command not registered: ${id}`);
  return handler(...args);
}

function __reset(): void {
  __state.commands.clear();
  __state.decorationTypes.length = 0;
  __state.diagnosticCollections.length = 0;
  __state.statusBarItems.length = 0;
  __state.webviewPanels.length = 0;
  __state.codeLensProviders.length = 0;
  __state.hoverProviders.length = 0;
  __state.codeActionProviders.length = 0;
  __state.webviewViewProviders.clear();
  __state.uriHandler = undefined;
  __state.debugTrackerFactories.length = 0;
  __state.infoMessageAnswers.length = 0;
  __state.inputBoxAnswers.length = 0;
  __state.configuration = {};
  for (const key of Object.keys(__state.listeners) as Array<
    keyof typeof __state.listeners
  >) {
    __state.listeners[key].length = 0;
  }
  mockWindow.activeTextEditor = undefined;
  mockWindow.visibleTextEditors = [];
  jest.clearAllMocks();
}

module.exports = {
  Position,
  Range: MockRange,
  Selection: MockSelection,
  ThemeColor,
  MarkdownString,
  Hover,
  CodeLens,
  CodeAction,
  CodeActionKind,
  Diagnostic,
  DiagnosticSeverity,
  SymbolKind,
  DecorationRangeBehavior,
  OverviewRulerLane,
  StatusBarAlignment,
  ViewColumn,
  EventEmitter,
  window: mockWindow,
  workspace,
  commands,
  languages,
  debug,
  env,
  Uri,
  ExtensionContext: jest.fn(),
  __state,
  __reset,
  __makeDocument,
  __makeEditor,
  __runCommand,
};
