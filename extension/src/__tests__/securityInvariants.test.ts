/**
 * Source-level guards for security properties that are cheap to regress and
 * expensive to test behaviourally.
 *
 * These assert on the source text rather than running the code: the webview
 * and hover paths need far more of the VS Code API than the test mock
 * provides, and the properties here are structural anyway.
 */

import * as fs from "fs";
import * as path from "path";

const SRC = path.join(__dirname, "..");
const MEDIA = path.join(__dirname, "..", "..", "media");

function read(...parts: string[]): string {
  return fs.readFileSync(path.join(...parts), "utf8");
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("hover markdown trust", () => {
  const source = stripComments(read(SRC, "inlineTutor.ts"));

  it("never blanket-trusts a MarkdownString", () => {
    // A blanket-trusted MarkdownString renders any `command:` link inside it,
    // and model-authored scan questions are appended to this one.
    expect(source).not.toMatch(/isTrusted\s*=\s*true/);
  });

  it("allow-lists only EduPeer's own commands", () => {
    const match = /enabledCommands:\s*\[([^\]]*)\]/.exec(source);
    expect(match).not.toBeNull();
    const commands = match![1].match(/"[^"]+"/g) ?? [];
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      expect(command).toMatch(/^"edupeer\./);
    }
  });

  it("does not expose the document-opening command to hover markdown", () => {
    // discussLines takes a URI and reads that file; it must not be reachable
    // from a link the model could talk its way into emitting.
    const match = /enabledCommands:\s*\[([^\]]*)\]/.exec(source);
    expect(match![1]).not.toContain("discussLines");
  });
});

describe("sidebar webview policy", () => {
  const source = read(SRC, "sidebarProvider.ts");

  it("sets a content security policy with a script nonce", () => {
    expect(source).toContain("default-src 'none'");
    expect(source).toContain("script-src 'nonce-");
  });

  it("does not allow inline styles", () => {
    expect(source).not.toContain("'unsafe-inline'");
  });

  it("draws the nonce from a cryptographic source", () => {
    expect(source).toContain("crypto.randomBytes");
    expect(source).not.toMatch(/Math\.random/);
  });

  it("restricts webview resources to the media directory", () => {
    expect(source).toContain("localResourceRoots");
  });
});

describe("webview scripts", () => {
  it("never assign markup as a string", () => {
    for (const file of ["main.js", "markdown.js"]) {
      const source = stripComments(read(MEDIA, file));
      expect(source).not.toMatch(/\.(inner|outer)HTML\s*=/);
      expect(source).not.toContain("insertAdjacentHTML");
      expect(source).not.toContain("document.write");
      expect(source).not.toMatch(/\beval\s*\(/);
    }
  });
});

describe("progress dashboard", () => {
  const source = read(SRC, "progressPanel.ts");

  it("blocks scripts outright in its content security policy", () => {
    expect(source).toContain("default-src 'none'");
    // No script-src at all, so default-src 'none' denies every script.
    expect(source).not.toContain("script-src");
  });

  it("escapes every interpolation of backend-supplied text", () => {
    // Anything the backend sends must pass through escapeHtml before it lands
    // in the HTML string this file builds.
    const risky = [
      "${progress.goal.text}",
      "${item.concept}",
      "${s.text}",
      "${s.date}",
      "${day.date}",
      "${b}",
      "${data.samples}",
      "${data.overconfident}",
      "${data.underconfident}",
    ];
    for (const fragment of risky) {
      expect(source).not.toContain(fragment);
    }
  });
});
