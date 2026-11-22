import { describe, expect, it, spyOn } from "bun:test";
import { highlight } from "./highlight";

const count = (text: string, needle: string): number =>
  text.split(needle).length - 1;

// =====================================================================
// highlight.escape
// =====================================================================

describe("highlight.escape", () => {
  it("escapes HTML-special characters", () => {
    expect(highlight.escape(`<script a="b">'x' & y</script>`)).toBe(
      "&lt;script a=&quot;b&quot;&gt;&#39;x&#39; &amp; y&lt;/script&gt;",
    );
  });
});

// =====================================================================
// highlight.compile
// =====================================================================

describe("highlight.compile", () => {
  const renderFormula = highlight.compile(
    [
      { kind: "comment", match: /#.*/ },
      { kind: "string", match: /"(?:\\.|[^"])*"/ },
      { kind: "variable", match: /\$[a-zA-Z_]\w*/ },
      { kind: "keyword", match: /\b(?:IF|THEN|ELSE|SUM)\b/ },
      { kind: "number", match: /\b\d+(?:\.\d+)?\b/ },
      { kind: "operator", match: /[+\-*/=<>!]+/ },
    ],
    { classPrefix: "dsl-" },
  );

  it("renders caller-defined DSL tokens", () => {
    expect(renderFormula(`IF $price > 10 THEN "ok"`)).toBe(
      `<span class="dsl-keyword">IF</span> <span class="dsl-variable">$price</span> <span class="dsl-operator">&gt;</span> <span class="dsl-number">10</span> <span class="dsl-keyword">THEN</span> <span class="dsl-string">&quot;ok&quot;</span>`,
    );
  });

  it("uses rule order as priority", () => {
    expect(renderFormula("# IF $price")).toBe(
      `<span class="dsl-comment"># IF $price</span>`,
    );
  });

  it("escapes unmatched text and token text", () => {
    expect(renderFormula(`IF "<x>"`)).toBe(
      `<span class="dsl-keyword">IF</span> <span class="dsl-string">&quot;&lt;x&gt;&quot;</span>`,
    );
  });

  it("sanitises token class names", () => {
    const render = highlight.compile([{ kind: `bad" token`, match: /x/ }]);
    expect(render("x")).toBe(`<span class="hl-bad--token">x</span>`);
  });

  it("trims only the edges of class names and preserves internal runs", () => {
    const kind = "a" + "-".repeat(75_000) + "b";
    const render = highlight.compile([{ kind: `--${kind}--`, match: /x/ }]);
    expect(render("x")).toBe(`<span class="hl-${kind}">x</span>`);
    expect(highlight.compile([{ kind: "---", match: /x/ }])("x")).toBe(
      `<span class="hl-token">x</span>`,
    );
  });

  it("ignores zero-length rule matches", () => {
    const render = highlight.compile([
      { kind: "empty", match: /(?:)/ },
      { kind: "word", match: /ok/ },
    ]);
    expect(render("ok")).toBe(`<span class="hl-word">ok</span>`);
  });

  it("is reusable across repeated renders", () => {
    const start = performance.now();
    for (let i = 0; i < 1000; i++) {
      renderFormula(`IF $price > ${i} THEN "ok" # comment`);
    }
    expect(performance.now() - start).toBeLessThan(150);
  });
});

// =====================================================================
// highlight.overlay
// =====================================================================

describe("highlight.overlay", () => {
  it("injects an escaped ghost with the Cloud anchor attribute", () => {
    const html = highlight.overlay("hel", highlight.escape, {
      ghost: { at: 3, text: `<lo>` },
    });

    expect(html).toBe(
      `hel<span class="completion-ghost" data-completion-anchor>&lt;lo&gt;<span class="completion-ghost-arrow" aria-hidden="true">→</span></span>`,
    );
  });

  it("injects an invisible caret anchor", () => {
    const html = highlight.overlay("hello", highlight.escape, {
      anchor: { at: 2 },
    });

    expect(html).toContain(`he<span class="completion-caret-anchor"`);
    expect(html).toContain(`data-completion-anchor`);
    expect(html).toContain(`aria-hidden="true"`);
  });

  it("lets the caller highlighter process text before sentinel replacement", () => {
    const html = highlight.overlay("**hi**", highlight.markdown, {
      ghost: { at: 6, text: "!" },
    });

    expect(html).toContain(`class="md-bold"`);
    expect(html).toContain(`class="completion-ghost"`);
  });
});

// =====================================================================
// highlight.markdown
// =====================================================================

describe("highlight.markdown", () => {
  it("escapes raw HTML before markdown processing", () => {
    expect(highlight.markdown(`<b>"x"</b>`)).toBe(
      "&lt;b&gt;&quot;x&quot;&lt;/b&gt;",
    );
  });

  it("renders inline code as a protected zone", () => {
    expect(highlight.markdown("Use `*x*` now")).toBe(
      `Use <span class="md-code"><span class="md-syntax">\`</span>*x*<span class="md-syntax">\`</span></span> now`,
    );
  });

  it("renders links without creating anchors", () => {
    expect(highlight.markdown("[Docs](https://example.test?a=1&b=2)")).toBe(
      `<span class="md-link"><span class="md-syntax">[</span>Docs<span class="md-syntax">](https://example.test?a=1&amp;b=2)</span></span>`,
    );
  });

  it("renders bold and nested italic", () => {
    const html = highlight.markdown("**foo *bar* baz**");
    expect(html).toContain(`class="md-bold"`);
    expect(html).toContain(`class="md-italic"`);
    expect(html).toContain(`<span class="md-syntax">**</span>`);
    expect(html).toContain(`<span class="md-syntax">*</span>bar`);
  });

  it("renders block-level markdown markers", () => {
    const html = highlight.markdown("# Title\n> Quote\n- Item\n1. One\n---");
    expect(html).toContain(`class="md-h1"`);
    expect(html).toContain(`class="md-quote"`);
    expect(html).toContain(`<span class="md-marker">- </span>Item`);
    expect(html).toContain(`<span class="md-marker">1. </span>One`);
    expect(html).toContain(`class="md-hr"`);
  });

  it("keeps fenced code blocks verbatim", () => {
    const html = highlight.markdown("```\n**not bold**\n```");
    expect(count(html, `md-code-block`)).toBe(3);
    expect(html).not.toContain(`class="md-bold"`);
  });

  it("highlights known labels outside code zones only", () => {
    const html = highlight.markdown("#alice `#alice`\n```\n#alice\n```", {
      knownLabels: new Set(["#alice"]),
    });

    expect(count(html, `class="md-completion-match"`)).toBe(1);
  });

  it("matches known labels as standalone words", () => {
    const html = highlight.markdown("hello #alice and #alice2", {
      knownLabels: new Set(["#alice"]),
    });

    expect(count(html, `class="md-completion-match"`)).toBe(1);
  });

  it("adds textarea trailing-newline compensation", () => {
    expect(highlight.markdown("line\n")).toBe("line\n\n");
  });
});

// =====================================================================
// highlight.presets
// =====================================================================

describe("highlight.presets", () => {
  const unfinished = [
    { preset: "code", kind: "comment", start: "/*", unit: "/*a", end: "\n" },
    { preset: "sql", kind: "comment", start: "/*", unit: "/*a", end: "\n" },
    { preset: "code", kind: "string", start: '"', unit: '\\"a', end: "\\" },
    { preset: "code", kind: "string", start: "'", unit: "\\'a", end: "\\" },
    { preset: "code", kind: "string", start: "`", unit: "\\`a", end: "\\" },
    { preset: "shell", kind: "string", start: '"', unit: '\\"a', end: "\\" },
    { preset: "shell", kind: "string", start: "'", unit: "\\'a", end: "\\" },
    { preset: "sql", kind: "string", start: "'", unit: "''a", end: "\\" },
    { preset: "sql", kind: "identifier", start: '"', unit: '\\"a', end: "\\" },
    { preset: "sql", kind: "identifier", start: "`", unit: "\\`a", end: "\\" },
    { preset: "sql", kind: "identifier", start: "[", unit: "[a", end: "" },
    { preset: "shell", kind: "variable", start: "${", unit: "${a", end: "" },
  ] as const;

  for (const { preset, kind, start, unit, end } of unfinished) {
    it(`${preset} bounds suffix scans for unfinished ${start}`, () => {
      // Count delimiter-rule calls at actual openers, where a suffix scan can
      // occur. Cheap failures at other characters do not scan ahead.
      const originalExec = RegExp.prototype.exec;
      let calls = 0;
      const exec = spyOn(RegExp.prototype, "exec").mockImplementation(function (this: RegExp, text: string) {
        if (this.sticky && text.startsWith(start, this.lastIndex)) {
          const prefix = kind === "comment" ? "\\/\\*" : kind === "variable" ? "\\$" :
            preset === "sql" && kind === "string" ? "'" : '"';
          if (this.source.startsWith(prefix)) calls++;
        }
        return originalExec.call(this, text);
      });
      const runs: { calls: number; input: string; html: string }[] = [];
      try {
        for (const n of [12_500, 25_000]) {
          calls = 0;
          const input = start + unit.repeat(n) + end;
          const html = highlight.presets[preset](input);
          runs.push({ calls, input, html });
        }
      } finally {
        exec.mockRestore();
      }
      for (const run of runs) {
        if (kind === "comment") {
          expect(run.html).toBe(`<span class="hl-comment">${highlight.escape(run.input)}</span>`);
        }
        expect(run.html.replace(/<\/?span[^>]*>/g, "")).toBe(highlight.escape(run.input));
        expect(run.calls).toBeGreaterThan(0);
        expect(run.calls).toBeLessThanOrEqual(2);
      }
      expect(runs[1]!.calls).toBe(runs[0]!.calls);
    });
  }

  it("retries failed line-bounded tokens on the next line", () => {
    expect(highlight.presets.sql("[open\nSELECT [ok]")).toBe(
      `[open\n<span class="hl-keyword">SELECT</span> <span class="hl-identifier">[ok]</span>`,
    );
    expect(highlight.presets.shell("${open\n${ok}")).toBe(
      `\${open\n<span class="hl-variable">\${ok}</span>`,
    );
  });

  for (const [preset, render] of Object.entries(highlight.presets)) {
    it(`${preset} bounds rule calls for plain words, numbers, and operators`, () => {
      const originalExec = RegExp.prototype.exec;
      let calls = 0;
      const exec = spyOn(RegExp.prototype, "exec").mockImplementation(function (this: RegExp, text: string) {
        if (this.sticky) calls++;
        return originalExec.call(this, text);
      });
      const counts: number[] = [];
      try {
        for (const n of [1_000, 2_000]) {
          calls = 0;
          // Includes failing SQL function lookaheads and numeric word boundaries.
          render("identifier 123abc ? + \n".repeat(n) + "x".repeat(n) + " ".repeat(n));
          counts.push(calls);
        }
      } finally {
        exec.mockRestore();
      }
      expect(counts[1]!).toBeLessThanOrEqual(2 * counts[0]! + 10);
    });
  }

  it("provides a shallow code highlighter", () => {
    const html = highlight.presets.code(`const x = "if"; // if`);
    expect(html).toContain(`<span class="hl-keyword">const</span>`);
    expect(html).toContain(`<span class="hl-string">&quot;if&quot;</span>`);
    expect(html).toContain(`<span class="hl-comment">// if</span>`);
  });

  it("provides a shallow shell highlighter", () => {
    const html = highlight.presets.shell(`if [ "$USER" ]; then # hi`);
    expect(html).toContain(`<span class="hl-keyword">if</span>`);
    expect(html).toContain(`<span class="hl-string">&quot;$USER&quot;</span>`);
    expect(html).toContain(`<span class="hl-keyword">then</span>`);
    expect(html).toContain(`<span class="hl-comment"># hi</span>`);
  });

  it("provides a shallow SQL highlighter", () => {
    const html = highlight.presets.sql(
      `SELECT count(*) FROM "users" WHERE email = $1 AND status = 'active' -- only active`,
    );
    expect(html).toContain(`<span class="hl-keyword">SELECT</span>`);
    expect(html).toContain(`<span class="hl-function">count</span>`);
    expect(html).toContain(`<span class="hl-identifier">&quot;users&quot;</span>`);
    expect(html).toContain(`<span class="hl-parameter">$1</span>`);
    expect(html).toContain(`<span class="hl-string">&#39;active&#39;</span>`);
    expect(html).toContain(`<span class="hl-comment">-- only active</span>`);
  });

  it("keeps SQL keywords inside strings and comments protected", () => {
    const html = highlight.presets.sql(`SELECT 'FROM users' -- WHERE id = 1`);
    expect(count(html, `class="hl-keyword"`)).toBe(1);
    expect(html).toContain(`<span class="hl-string">&#39;FROM users&#39;</span>`);
    expect(html).toContain(`<span class="hl-comment">-- WHERE id = 1</span>`);
  });
});

// =====================================================================
// namespace export
// =====================================================================

describe("highlight namespace", () => {
  it("exposes the KISS API surface", () => {
    expect(Object.keys(highlight).sort()).toEqual([
      "compile",
      "escape",
      "markdown",
      "overlay",
      "presets",
    ]);
    expect(Object.keys(highlight.presets).sort()).toEqual(["code", "shell", "sql"]);
  });
});
