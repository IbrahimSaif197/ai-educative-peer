const vscode = {
  window: {
    showWarningMessage: jest.fn(),
    showInformationMessage: jest.fn(),
    showErrorMessage: jest.fn(),
    activeTextEditor: undefined as any,
    onDidChangeActiveTextEditor: jest.fn(() => ({ dispose: jest.fn() })),
    registerWebviewViewProvider: jest.fn(() => ({ dispose: jest.fn() })),
  },
  workspace: {
    getConfiguration: jest.fn(() => ({
      get: jest.fn((key: string, fallback: any) => fallback),
    })),
    onDidChangeTextDocument: jest.fn(() => ({ dispose: jest.fn() })),
    onDidChangeConfiguration: jest.fn(() => ({ dispose: jest.fn() })),
  },
  commands: {
    registerCommand: jest.fn(() => ({ dispose: jest.fn() })),
    executeCommand: jest.fn(),
  },
  Uri: {
    joinPath: jest.fn((...parts: any[]) => ({ fsPath: parts.join("/"), toString: () => parts.join("/") })),
    parse: jest.fn((s: string) => ({ fsPath: s })),
  },
  EventEmitter: jest.fn().mockImplementation(() => ({
    event: jest.fn(),
    fire: jest.fn(),
    dispose: jest.fn(),
  })),
  ExtensionContext: jest.fn(),
};

module.exports = vscode;
