import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { cssDeclarations, readShippedCssRules } from "../styles/css-contract-test-helpers";

const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-message-row-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { LocaleProvider, MessageRow, MessageSystemRow, startsMessageGroup } = await import("../index");
type Props = Parameters<typeof MessageRow>[0];

const nora = { name: "Nora Brandt" };
const row = (props: Partial<Props> = {}, locale = "en") =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(MessageRow, { author: nora, text: "Hello", time: "09:31", ...props });
      },
    }),
  );
/** The text a reader meets, with a space where an element starts or ends; comments such as hydration markers drop out. */
const textOf = (html: string) => {
  let text = "";
  new HTMLRewriter()
    .on("*", {
      element(element) {
        text += " ";
        if (!element.canHaveContent) return;
        element.onEndTag(() => {
          text += " ";
        });
      },
    })
    .onDocument({
      text(chunk) {
        text += chunk.text;
      },
    })
    .transform(html);
  return text.replace(/\s+/g, " ").trim();
};
const long = Array.from({ length: 20 }, (_, index) => `Line ${index + 1}`).join("\n");

describe("MessageRow", () => {
  test("starts a group of others with avatar, name, badge, and time on the left", () => {
    const html = row({ badge: "Agent", dateTime: "2026-10-06T07:31:00Z" });

    expect(html).toContain('class="k2b-message-row"');
    expect(html).not.toContain("data-own");
    expect(html).toContain("data-group-start");
    // The name follows the avatar, so the avatar's own name would be read twice.
    expect(html).toMatch(/class="k2b-message-row__avatar" aria-hidden="true"><span class="k2b-avatar ?" data-size="sm" data-tint="\d"/);
    expect(html).toContain(">NB</span>");
    expect(textOf(html)).toBe("NB Nora Brandt Agent 09:31 Hello");
    expect(html).toContain('datetime="2026-10-06T07:31:00.000Z"');
    expect(html).not.toContain("k2b-sr-only");
    expect(html).not.toContain("k2b-message-row__line");
    expect(html).not.toContain("k2b-message-row__actions");
  });

  test("continues a group with the text only and still names author and time for screen readers", () => {
    const html = row({ groupStart: false });

    expect(html).not.toContain("data-group-start");
    expect(html).toContain('class="k2b-message-row__gutter"></div>');
    expect(html).not.toContain("k2b-avatar");
    expect(html).not.toContain("k2b-message-row__meta");
    expect(html).toMatch(/<span class="k2b-sr-only">Nora Brandt, 09:31:/);
  });

  test("puts own messages on the right with the time only and no avatar", () => {
    const html = row({ own: true, status: "sent" });

    expect(html).toContain("data-own");
    expect(html).not.toContain("k2b-message-row__gutter");
    expect(html).not.toContain("k2b-avatar");
    expect(html).toMatch(
      /class="k2b-message-row__meta"><span class="k2b-sr-only">Nora Brandt, <\/span><time class="k2b-message-row__time"/,
    );
    expect(row({ own: true, groupStart: false })).toMatch(/<span class="k2b-sr-only">Nora Brandt, 09:31:/);
  });

  test("tints initials by the name, so a person has one color everywhere", () => {
    const tint = (html: string) => html.match(/data-tint="(\d)"/)?.[1];

    expect(tint(row({ author: { name: " Nora Brandt " } }))).toBe(tint(row()));
    expect(new Set(["Ada", "Ben", "Cleo", "Dan", "Eve", "Finn"].map((name) => tint(row({ author: { name } })))).size).toBeGreaterThan(1);
    expect(row({ author: { name: "Nora Brandt", avatar: "/avatar.webp" } })).toContain('src="/avatar.webp"');
  });

  for (const [locale, words] of [
    ["en", { sending: "Sending", sent: "Sent", failed: "Not sent", retry: "Retry", more: "Show more", copy: "Copy", copied: "Copied" }],
    [
      "de",
      {
        sending: "Wird gesendet",
        sent: "Gesendet",
        failed: "Nicht gesendet",
        retry: "Erneut senden",
        more: "Mehr anzeigen",
        copy: "Kopieren",
        copied: "Kopiert",
      },
    ],
  ] as const) {
    test(`shows every send state in one fixed line (${locale})`, () => {
      const pending = row({ own: true, status: "pending" }, locale);
      expect(pending).toContain('data-status="pending"');
      expect(pending).toMatch(/class="k2b-message-row__line"><i class="ti ti-clock" aria-hidden="true"><\/i><span>/);
      expect(textOf(pending)).toEndWith(`Hello ${words.sending}`);

      const sent = row({ own: true, status: "sent" }, locale);
      expect(sent).toContain('<i class="ti ti-check" aria-hidden="true"></i><span class="k2b-sr-only">');
      expect(textOf(sent)).toEndWith(`Hello ${words.sent}`);

      const read = row({ own: true, status: "sent", receipt: "Read by Tobias" }, locale);
      expect(read).toContain('<i class="ti ti-checks" aria-hidden="true"></i><span class="k2b-message-row__receipt">Read by Tobias</span>');
      expect(read).not.toContain('ti-check"');

      const failed = row({ own: true, status: "failed", onRetry: () => {} }, locale);
      expect(failed).toContain('data-status="failed"');
      expect(failed).toMatch(/<button[^>]*type="button"[^>]*>/);
      expect(textOf(failed)).toEndWith(`Hello ${words.failed} ${words.retry}`);
      expect(textOf(row({ own: true, status: "failed" }, locale))).toEndWith(`Hello ${words.failed}`);
    });

    test(`collapses a long message from its text alone and labels the controls (${locale})`, () => {
      const html = row({ text: long }, locale);
      const id = html.match(/id="(k2b-message-[^"]+)"/)?.[1];

      expect(id).toBeDefined();
      expect(html).toMatch(/class="k2b-content-markdown k2b-message-row__text"[^>]*data-collapsed/);
      expect(html).toContain(`aria-controls="${id}"`);
      expect(html).toContain('aria-expanded="false"');
      expect(textOf(html)).toEndWith(words.more);

      const code = row({ text: "```ts\nconst a = 1;\n```" }, locale);
      expect(code).toContain('<pre tabindex="0"><code class="language-ts">const a = 1;\n</code></pre>');
      expect(textOf(code)).toContain(`ts ${words.copy} ${words.copied} const a = 1;`);
    });
  }

  test("keeps short messages and messages of many short words whole", () => {
    expect(row({ text: Array.from({ length: 14 }, () => "Line").join("\n") })).not.toContain("data-collapsed");
    expect(row({ text: Array.from({ length: 14 }, () => "Line").join("\n\n") })).not.toContain("data-collapsed");
    expect(row({ text: "word ".repeat(300) })).toContain("data-collapsed");
    expect(row({ text: Array.from({ length: 15 }, () => "Line").join("\n") })).toContain("data-collapsed");
  });

  test("decides the collapse from what renders, not from the source", () => {
    const collapsed = (text: string) => row({ text }).includes("data-collapsed");
    const fence = (lines: string[]) => `\`\`\`\n${lines.join("\n")}\n\`\`\``;

    // Link destinations and reference definitions show nothing.
    expect(collapsed(`[docs](https://example.com/${"x".repeat(1500)})`)).toBe(false);
    expect(collapsed(Array.from({ length: 8 }, (_, index) => `- [Link ${index}](https://example.com/${"y".repeat(220)})`).join("\n"))).toBe(
      false,
    );
    expect(
      collapsed(`Short text\n\n${Array.from({ length: 14 }, (_, index) => `[r${index}]: https://example.com/${index}`).join("\n")}`),
    ).toBe(false);
    // Code scrolls instead of wrapping, and every line of it shows, blank ones too.
    expect(collapsed(fence(Array.from({ length: 5 }, () => "log ".repeat(75))))).toBe(false);
    expect(collapsed(fence(Array.from({ length: 12 }, (_, index) => `line ${index}`)))).toBe(false);
    expect(collapsed(fence(Array.from({ length: 12 }, (_, index) => `line ${index}\n`)))).toBe(true);
    expect(collapsed(fence(Array.from({ length: 14 }, (_, index) => `line ${index}`)))).toBe(true);
    // A list item, a table row, and a quoted line each take a line of their own.
    expect(collapsed(Array.from({ length: 15 }, (_, index) => `- ${index}`).join("\n"))).toBe(true);
    expect(collapsed(`| a | b |\n| - | - |\n${Array.from({ length: 14 }, () => "| 1 | 2 |").join("\n")}`)).toBe(true);
    expect(collapsed(Array.from({ length: 15 }, (_, index) => `> ${index}`).join("\n"))).toBe(true);
    expect(collapsed(`:::note Plan\n${Array.from({ length: 15 }, (_, index) => `Step ${index}`).join("\n")}\n:::`)).toBe(true);
  });

  test("renders a safe Markdown subset: raw HTML and unsafe links stay text, links open in a new tab", () => {
    const html = row({
      text: [
        '<img src=x onerror="alert(1)"> <script>alert(2)</script>',
        "[run](javascript:alert(3)) [data](data:text/html,hi) [ftp](ftp://example.com/file) <javascript:alert(4)>",
        "[docs](https://example.com/docs) [mail](mailto:team@example.com) https://example.org",
        "[rel](/settings/x) [proto](//evil.example/x) [query](?a=1) [bare](example.com)",
        "![chart](https://example.com/chart.png)",
        "**bold** _italic_ `code`",
        "line one\nline two",
      ].join("\n\n"),
    });

    expect(html).not.toMatch(/<img |<script|<a [^>]*href="(?:javascript|data|ftp):/i);
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).toContain("&lt;script&gt;alert(2)&lt;/script&gt;");
    expect(textOf(html)).toContain("run data ftp javascript:alert(4)");
    // A relative link would lead somewhere else on every page that shows the conversation.
    expect(textOf(html)).toContain("rel proto query bare");
    expect(html).not.toMatch(/href="(?:\/|\?|example\.com)/);
    expect(html).toContain('<a href="https://example.com/docs" target="_blank" rel="noopener noreferrer">docs</a>');
    expect(html).toContain('<a href="mailto:team@example.com" target="_blank" rel="noopener noreferrer">mail</a>');
    expect(html).toContain('<a href="https://example.org" target="_blank" rel="noopener noreferrer">https://example.org</a>');
    // Images never load from a message; their description stays.
    expect(textOf(html)).toContain("chart");
    expect(html).toContain("<strong>bold</strong> <em>italic</em> <code>code</code>");
    expect(html).toContain("line one<br>line two");
  });

  test("escapes a code block's language", () => {
    expect(row({ text: '```"><img>\nx\n```' })).not.toContain("<img>");
  });

  test("offers the caller's actions as a labelled group that overlays the row", () => {
    const html = row({
      actions: [
        { id: "reply", label: "Reply", icon: "ti ti-arrow-back-up", onSelect: () => {} },
        { id: "copy", label: "Copy text", icon: "ti ti-copy", onSelect: () => {}, disabled: true },
      ],
    });

    expect(html).toMatch(/class="k2b-message-row__actions" role="group" aria-label="Message actions"/);
    expect(html).toMatch(/aria-label="Reply"/);
    expect(html).toMatch(/<button[^>]*disabled[^>]*aria-label="Copy text"|<button[^>]*aria-label="Copy text"[^>]*disabled/);
    expect(row({ actions: [] })).not.toContain("k2b-message-row__actions");
    expect(row({ actions: [{ id: "reply", label: "Reply", icon: "ti ti-arrow-back-up", onSelect: () => {} }] }, "de")).toContain(
      'aria-label="Nachrichtenaktionen"',
    );
  });
});

describe("MessageSystemRow", () => {
  test("renders a quiet centered line with an optional icon and time", () => {
    const html = renderToString(() =>
      createComponent(MessageSystemRow, {
        icon: "ti ti-user-plus",
        time: "10:02",
        dateTime: "2026-10-06T08:02:00Z",
        children: "Nora added Tobias",
      }),
    );

    expect(html).toContain('class="k2b-message-system-row"');
    expect(html).toContain('<i class="ti ti-user-plus" aria-hidden="true">');
    expect(textOf(html)).toBe("Nora added Tobias 10:02");
    expect(html).toContain('datetime="2026-10-06T08:02:00.000Z"');
  });
});

describe("startsMessageGroup", () => {
  const at = Date.UTC(2026, 9, 6, 9, 0);

  test("groups messages by the same author within five minutes", () => {
    expect(startsMessageGroup({ author: "a", at })).toBe(true);
    expect(startsMessageGroup({ author: "a", at: at + 5 * 60_000 }, { author: "a", at })).toBe(false);
    expect(startsMessageGroup({ author: "a", at: new Date(at + 60_000) }, { author: "a", at: new Date(at).toISOString() })).toBe(false);
    expect(startsMessageGroup({ author: "a", at: at + 5 * 60_000 + 1 }, { author: "a", at })).toBe(true);
    expect(startsMessageGroup({ author: "b", at: at + 1 }, { author: "a", at })).toBe(true);
    expect(startsMessageGroup({ author: "a", at: at - 1 }, { author: "a", at })).toBe(true);
    expect(startsMessageGroup({ author: "a", at: at + 1 }, { author: "a", at, system: true })).toBe(true);
    expect(startsMessageGroup({ author: "a", at: "not a date" }, { author: "a", at })).toBe(true);
  });
});

describe("MessageRow styles", () => {
  const rules = readShippedCssRules(resolve(import.meta.dir, "../styles"));
  const declarations = (selector: string, context = "") => {
    const rule = rules.find((candidate) => candidate.selector === selector && candidate.context === context);
    expect(rule, `${context} ${selector}`).toBeDefined();
    return cssDeclarations(rule!.body);
  };

  test("draws both themes from the theme tokens", () => {
    const own = rules.filter((rule) => /\.k2b-message-(?:row|system-row)\b/.test(rule.selector));
    expect(own.length).toBeGreaterThan(10);
    for (const rule of own) {
      for (const [property, values] of cssDeclarations(rule.body)) {
        if (!/color|background|shadow/.test(property) || rule.context.includes("forced-colors")) continue;
        for (const value of values) expect(value, `${rule.selector} ${property}`).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(/i);
      }
    }
    expect(declarations(".k2b-ui .k2b-message-row__bubble").get("background")).toEqual(["var(--k2b-surface-muted)"]);
    expect(declarations(".k2b-ui .k2b-message-row[data-own] .k2b-message-row__bubble").get("background")).toEqual(["var(--k2b-selected)"]);
  });

  test("shows the actions by paint only and gives the status line a fixed height", () => {
    const bar = declarations(".k2b-ui .k2b-message-row__actions");
    expect(bar.get("position")).toEqual(["absolute"]);
    expect(bar.get("opacity")).toEqual(["0"]);
    for (const [selector, context] of [
      [".k2b-ui .k2b-message-row:focus-within .k2b-message-row__actions", ""],
      [".k2b-ui :focus > .k2b-message-row .k2b-message-row__actions", ""],
      // A tap's emulated hover must not show the actions and press one in the same tap.
      [".k2b-ui .k2b-message-row:hover .k2b-message-row__actions", "@media (hover: hover)"],
    ] as const)
      expect([...declarations(selector, context).keys()].sort()).toEqual(["opacity", "pointer-events"]);
    expect(rules.some((rule) => rule.selector.includes(".k2b-message-row:hover") && rule.context === "")).toBe(false);
    expect(declarations(".k2b-ui .k2b-message-row__line").get("height")).toEqual(["1.25rem"]);
    expect(declarations(".k2b-ui .k2b-message-row__meta").get("height")).toEqual(["1.25rem"]);
    const clamp = declarations(".k2b-ui .k2b-message-row__text[data-collapsed]");
    expect(clamp.get("max-height")).toEqual(["calc(10 * var(--k2b-message-line))"]);
    // A box that can scroll would scroll to a focused link instead of opening.
    expect(clamp.get("overflow")).toEqual(["clip"]);
  });

  test("gives every avatar tint a rule", () => {
    for (let tint = 0; tint < 10; tint++) {
      expect(declarations(`.k2b-ui .k2b-avatar[data-tint="${tint}"]`).get("--k2b-avatar-hue")?.[0]).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});
