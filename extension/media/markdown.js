/**
 * A small Markdown renderer for tutor replies.
 *
 * Level-3 hints are pseudocode and worked examples are numbered lists, so
 * rendering them as flat text loses the structure the pedagogy depends on.
 * This covers exactly what the tutor prompts can emit: fenced code, inline
 * code, bold, italic, and both kinds of list.
 *
 * Every node is created with createElement/createTextNode. Nothing here ever
 * assigns innerHTML, so model output cannot inject markup into the panel.
 */
(function () {
  const FENCE = /^\s*```/;
  const BULLET = /^\s*[-*+]\s+(.*)$/;
  const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;

  // Ordered by precedence: code wins over emphasis so `**x**` inside backticks
  // stays literal.
  const INLINE = [
    { re: /`([^`\n]+)`/, tag: "code", recurse: false },
    // Lazy, and permits inner asterisks, so "**very *very* bold**" nests
    // rather than losing the outer bold to the inner italic.
    { re: /\*\*(.+?)\*\*/, tag: "strong", recurse: true },
    { re: /__(.+?)__/, tag: "strong", recurse: true },
    { re: /(?<![\w*])\*([^*\n]+)\*(?![\w*])/, tag: "em", recurse: true },
    { re: /(?<![\w_])_([^_\n]+)_(?![\w_])/, tag: "em", recurse: true },
    // Links render as their text: the panel has no safe way to open a URL the
    // model invented, and a bare label reads fine.
    { re: /\[([^\]\n]+)\]\([^)\n]*\)/, tag: null, recurse: true },
  ];

  function appendInline(parent, text) {
    let rest = text;
    let guard = 0;
    while (rest && guard++ < 500) {
      let best = null;
      for (const rule of INLINE) {
        const match = rule.re.exec(rest);
        if (match && (best === null || match.index < best.match.index)) {
          best = { rule, match };
        }
      }
      if (!best) break;

      const { rule, match } = best;
      if (match.index > 0) {
        parent.appendChild(document.createTextNode(rest.slice(0, match.index)));
      }
      const inner = match[1];
      if (rule.tag === null) {
        appendInline(parent, inner);
      } else {
        const el = document.createElement(rule.tag);
        if (rule.recurse) {
          appendInline(el, inner);
        } else {
          el.textContent = inner;
        }
        parent.appendChild(el);
      }
      rest = rest.slice(match.index + match[0].length);
    }
    if (rest) {
      parent.appendChild(document.createTextNode(rest));
    }
  }

  function appendParagraph(parent, lines) {
    const text = lines.join("\n").trim();
    if (!text) return;
    const p = document.createElement("p");
    // Soft line breaks inside a paragraph are meaningful in tutor replies.
    text.split("\n").forEach((line, index) => {
      if (index > 0) p.appendChild(document.createElement("br"));
      appendInline(p, line);
    });
    parent.appendChild(p);
  }

  function appendList(parent, items, ordered) {
    const list = document.createElement(ordered ? "ol" : "ul");
    for (const item of items) {
      const li = document.createElement("li");
      appendInline(li, item);
      list.appendChild(li);
    }
    parent.appendChild(list);
  }

  function appendCode(parent, lines) {
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    code.textContent = lines.join("\n");
    pre.appendChild(code);
    parent.appendChild(pre);
  }

  /**
   * Render `text` as Markdown into `container`, replacing its contents.
   * Returns the container so callers can chain.
   */
  function renderMarkdown(text, container) {
    while (container.firstChild) {
      container.removeChild(container.firstChild);
    }
    const lines = String(text ?? "").split("\n");
    let paragraph = [];
    let index = 0;

    const flushParagraph = () => {
      if (paragraph.length) {
        appendParagraph(container, paragraph);
        paragraph = [];
      }
    };

    while (index < lines.length) {
      const line = lines[index];

      if (FENCE.test(line)) {
        flushParagraph();
        const body = [];
        index++;
        while (index < lines.length && !FENCE.test(lines[index])) {
          body.push(lines[index]);
          index++;
        }
        index++; // consume the closing fence, or run off the end
        appendCode(container, body);
        continue;
      }

      const bullet = BULLET.exec(line);
      const numbered = NUMBERED.exec(line);
      if (bullet || numbered) {
        flushParagraph();
        const ordered = !bullet;
        const pattern = ordered ? NUMBERED : BULLET;
        const items = [];
        while (index < lines.length) {
          const match = pattern.exec(lines[index]);
          if (!match) break;
          items.push(match[1]);
          index++;
        }
        appendList(container, items, ordered);
        continue;
      }

      if (!line.trim()) {
        flushParagraph();
        index++;
        continue;
      }

      paragraph.push(line);
      index++;
    }

    flushParagraph();
    return container;
  }

  window.renderMarkdown = renderMarkdown;
})();
