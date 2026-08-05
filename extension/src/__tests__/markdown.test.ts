/**
 * Tests for media/markdown.js.
 *
 * The renderer is browser code, and this project has no jsdom, so rather than
 * pull in a test-only dependency we give it just enough DOM to run: the six
 * methods it actually touches. That keeps the real parsing and node-building
 * logic under test, including the guarantee that it never assigns innerHTML.
 */

import * as fs from "fs";
import * as path from "path";

class FakeNode {
  childNodes: FakeNode[] = [];
  parentNode: FakeNode | null = null;
  private ownText = "";

  constructor(readonly nodeName: string, text = "") {
    this.ownText = text;
  }

  get isText(): boolean {
    return this.nodeName === "#text";
  }

  get firstChild(): FakeNode | undefined {
    return this.childNodes[0];
  }

  appendChild(child: FakeNode): FakeNode {
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  removeChild(child: FakeNode): FakeNode {
    const index = this.childNodes.indexOf(child);
    if (index >= 0) this.childNodes.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  get textContent(): string {
    if (this.isText) return this.ownText;
    return this.childNodes.map((c) => c.textContent).join("");
  }

  set textContent(value: string) {
    if (this.isText) {
      this.ownText = value;
      return;
    }
    this.childNodes = [];
    this.appendChild(new FakeNode("#text", value));
  }
}

const fakeDocument = {
  createElement: (tag: string) => new FakeNode(tag.toLowerCase()),
  createTextNode: (text: string) => new FakeNode("#text", text),
};

const fakeWindow: { renderMarkdown?: (text: string, container: FakeNode) => FakeNode } = {};

const source = fs.readFileSync(
  path.join(__dirname, "..", "..", "media", "markdown.js"),
  "utf8"
);
// eslint-disable-next-line no-new-func
new Function("window", "document", source)(fakeWindow, fakeDocument);
const renderMarkdown = fakeWindow.renderMarkdown!;

/**
 * Serialise the tree so assertions can talk about structure, not internals.
 * Text nodes are escaped, exactly as a real DOM would render them — otherwise
 * literal text like "<img>" would look indistinguishable from an element.
 */
function serialize(node: FakeNode): string {
  if (node.isText) {
    return node.textContent.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  const inner = node.childNodes.map(serialize).join("");
  return `<${node.nodeName}>${inner}</${node.nodeName}>`;
}

function render(markdown: string): FakeNode {
  const container = new FakeNode("div");
  renderMarkdown(markdown, container);
  return container;
}

function html(markdown: string): string {
  return render(markdown).childNodes.map(serialize).join("");
}

describe("paragraphs", () => {
  it("wraps plain text in a paragraph", () => {
    expect(html("Hello there")).toBe("<p>Hello there</p>");
  });

  it("splits on a blank line", () => {
    expect(html("One\n\nTwo")).toBe("<p>One</p><p>Two</p>");
  });

  it("keeps a soft line break inside a paragraph", () => {
    expect(html("One\nTwo")).toBe("<p>One<br></br>Two</p>");
  });

  it("renders nothing for empty input", () => {
    expect(html("")).toBe("");
  });

  it("renders nothing for whitespace only", () => {
    expect(html("   \n\n  ")).toBe("");
  });

  it("clears the container before rendering again", () => {
    const container = new FakeNode("div");
    renderMarkdown("first", container);
    renderMarkdown("second", container);
    expect(container.textContent).toBe("second");
  });
});

describe("emphasis", () => {
  it("renders bold", () => {
    expect(html("a **bold** b")).toBe("<p>a <strong>bold</strong> b</p>");
  });

  it("renders underscore bold", () => {
    expect(html("__bold__")).toBe("<p><strong>bold</strong></p>");
  });

  it("renders italic", () => {
    expect(html("an *italic* word")).toBe("<p>an <em>italic</em> word</p>");
  });

  it("leaves an underscore inside a name alone", () => {
    expect(html("call snake_case_name now")).toBe("<p>call snake_case_name now</p>");
  });

  it("leaves a lone asterisk alone", () => {
    expect(html("2 * 3 = 6")).toBe("<p>2 * 3 = 6</p>");
  });

  it("nests emphasis inside bold", () => {
    expect(html("**very *very* bold**")).toBe(
      "<p><strong>very <em>very</em> bold</strong></p>"
    );
  });
});

describe("code", () => {
  it("renders inline code", () => {
    expect(html("use `range(n)` here")).toBe("<p>use <code>range(n)</code> here</p>");
  });

  it("keeps markup inside inline code literal", () => {
    expect(html("`**not bold**`")).toBe("<p><code>**not bold**</code></p>");
  });

  it("renders a fenced block", () => {
    expect(html("```\nfor i in range(3):\n    print(i)\n```")).toBe(
      "<pre><code>for i in range(3):\n    print(i)</code></pre>"
    );
  });

  it("ignores the language tag on a fence", () => {
    expect(html("```python\nx = 1\n```")).toBe("<pre><code>x = 1</code></pre>");
  });

  it("closes an unterminated fence at the end of the text", () => {
    expect(html("```\nx = 1")).toBe("<pre><code>x = 1</code></pre>");
  });

  it("keeps prose around a fence in separate paragraphs", () => {
    expect(html("Before\n\n```\ncode\n```\n\nAfter")).toBe(
      "<p>Before</p><pre><code>code</code></pre><p>After</p>"
    );
  });
});

describe("lists", () => {
  it("renders a bullet list", () => {
    expect(html("- one\n- two")).toBe("<ul><li>one</li><li>two</li></ul>");
  });

  it("accepts asterisk bullets", () => {
    expect(html("* one\n* two")).toBe("<ul><li>one</li><li>two</li></ul>");
  });

  it("renders a numbered list", () => {
    expect(html("1. first\n2. second")).toBe("<ol><li>first</li><li>second</li></ol>");
  });

  it("accepts the 1) form", () => {
    expect(html("1) first\n2) second")).toBe("<ol><li>first</li><li>second</li></ol>");
  });

  it("renders emphasis inside list items", () => {
    expect(html("- a `b` c")).toBe("<ul><li>a <code>b</code> c</li></ul>");
  });

  it("separates a list from following prose", () => {
    expect(html("- one\n\nAfter")).toBe("<ul><li>one</li></ul><p>After</p>");
  });
});

describe("links", () => {
  it("keeps the label and drops the destination", () => {
    expect(html("see [the docs](https://example.com)")).toBe("<p>see the docs</p>");
  });

  it("leaves a bare url as text", () => {
    expect(html("https://example.com")).toBe("<p>https://example.com</p>");
  });
});

describe("safety", () => {
  it("never assigns markup as a string", () => {
    expect(source).not.toMatch(/\.(inner|outer)HTML\s*=/);
    expect(source).not.toContain("insertAdjacentHTML");
    expect(source).not.toContain("document.write");
  });

  it("renders markup in the model's output as literal text", () => {
    const container = render("<script>alert(1)</script>");
    // It lands as a text node, so the DOM never contains a script element.
    expect(container.textContent).toContain("<script>alert(1)</script>");
    expect(serialize(container)).not.toContain("<script>");
    expect(serialize(container)).toContain("&lt;script&gt;");
  });

  it("renders an img tag as literal text", () => {
    expect(serialize(render("<img src=x onerror=alert(1)>"))).not.toContain("<img");
  });

  it("drops a javascript: destination and keeps only the label", () => {
    const rendered = html("[click](javascript:alert(1))");
    expect(rendered).toContain("click");
    expect(rendered).not.toContain("javascript:");
    expect(rendered).not.toContain("<a>");
  });

  it("terminates on adversarial emphasis nesting", () => {
    const start = Date.now();
    html("*".repeat(2000));
    expect(Date.now() - start).toBeLessThan(2000);
  });
});
