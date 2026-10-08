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
    expect(html).toContain(
      '<a href="https://example.com/docs" class="k2b-text-link" data-link="web" target="_blank" rel="noopener noreferrer">docs<i class="k2b-text-link__external ti ti-arrow-up-right" aria-hidden="true"></i></a>',
    );
    expect(html).toContain(
      '<a href="mailto:team@example.com" class="k2b-text-link" data-link="mail" target="_blank" rel="noopener noreferrer">mail</a>',
    );
    expect(html).toContain(
      '<a href="https://example.org" class="k2b-text-link" data-link="web" target="_blank" rel="noopener noreferrer">https://example.org<i class="k2b-text-link__external ti ti-arrow-up-right" aria-hidden="true"></i></a>',
    );
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

describe("MessageRow rich content", () => {
  const image = { kind: "image", src: "/media/grid.webp", alt: "Tile grid", width: 1200, height: 800 } as const;
  const pdf = { kind: "file", name: "Testplan.pdf", detail: "PDF · 412 KB", mediaType: "application/pdf" } as const;

  for (const [locale, words] of [
    [
      "en",
      {
        replyTo: "In reply to",
        forwarded: "Forwarded",
        edited: "edited",
        deleted: "This message was deleted",
        reactions: "Reactions",
        add: "Add reaction",
        one: "👍 1 reaction: Nora",
        many: "☕ 3 reactions",
        ownOne: "👍 your reaction: Nora",
        ownMany: "☕ 3 reactions, including yours",
        replies: "3 replies",
        reply: "1 reply",
        last: "Last reply 10:42",
        stop: "Stop",
        video: "Clip, Video 0:42",
        more: "Four, 2 more",
      },
    ],
    [
      "de",
      {
        replyTo: "Antwort auf",
        forwarded: "Weitergeleitet",
        edited: "bearbeitet",
        deleted: "Diese Nachricht wurde gelöscht",
        reactions: "Reaktionen",
        add: "Reaktion hinzufügen",
        one: "👍 1 Reaktion: Nora",
        many: "☕ 3 Reaktionen",
        ownOne: "👍 deine Reaktion: Nora",
        ownMany: "☕ 3 Reaktionen, einschließlich deiner",
        replies: "3 Antworten",
        reply: "1 Antwort",
        last: "Letzte Antwort 10:42",
        stop: "Stoppen",
        video: "Clip, Video 0:42",
        more: "Four, 2 weitere",
      },
    ],
  ] as const) {
    test(`marks a quote, a forward, and an edit (${locale})`, () => {
      const html = row({ quote: { author: "Tobias Kern", text: "The API is done." }, forwarded: true, edited: true }, locale);

      expect(textOf(html)).toBe(
        `NB Nora Brandt 09:31 ${words.forwarded} ${words.replyTo} Tobias Kern The API is done. Hello ${words.edited}`,
      );
      expect(html).toMatch(/<div class="k2b-message-row__quote"><i class="ti ti-arrow-back-up" aria-hidden="true">/);
      // The marker ends the last paragraph instead of taking a line of its own.
      expect(html).toContain(`<p>Hello <span class="k2b-message-row__edited">${words.edited}</span></p>`);
      expect(row({ text: "```\ncode\n```", edited: true }, locale)).toContain(
        `</div><p><span class="k2b-message-row__edited">${words.edited}</span></p>`,
      );
      expect(row({ quote: { author: "Tobias Kern", text: "The API is done.", onSelect: () => {} } }, locale)).toMatch(
        /<button type="button" class="k2b-message-row__quote">/,
      );
      // A collapsed message hides the end of its text, so the marker sits beside "Show more" instead.
      const collapsed = row({ text: long, edited: true }, locale);
      expect(collapsed).not.toMatch(/<p>[^<]*<span class="k2b-message-row__edited">/);
      expect(collapsed).toMatch(
        new RegExp(`class="k2b-message-row__more-line">.*</button><span class="k2b-message-row__edited">${words.edited}</span></div>`),
      );
      // Without a bubble, the marker takes the bubble's place.
      const pictures = row({ text: "", edited: true, attachments: [image] }, locale);
      expect(pictures).not.toContain("k2b-message-row__bubble");
      expect(pictures).toMatch(
        new RegExp(
          `<div class="k2b-message-row__marker"><i class="ti ti-pencil" aria-hidden="true"></i><span class="k2b-message-row__edited">${words.edited}</span></div><div class="k2b-message-row__media"`,
        ),
      );
    });

    test(`replaces a deleted message with a placeholder and keeps its thread (${locale})`, () => {
      const html = row(
        {
          text: "",
          deleted: true,
          edited: true,
          forwarded: true,
          quote: { author: "Tobias Kern", text: "Quoted" },
          attachments: [image, pdf],
          linkPreview: "Preview",
          card: "Card",
          reactions: [{ key: "👍", emoji: "👍", count: 1 }],
          thread: { count: 1, lastReply: "10:42", onOpen: () => {} },
        },
        locale,
      );

      expect(html).toContain('class="k2b-message-row__bubble" data-deleted=""');
      expect(textOf(html)).toBe(`NB Nora Brandt 09:31 ${words.deleted} ${words.reply} ${words.last}`);
      for (const part of ["__quote", "__marker", "__edited", "__media", "__files", "__slot", "__reactions", "__text"])
        expect(html).not.toContain(`k2b-message-row${part}`);
    });

    test(`shows reactions as toggles with counts and names (${locale})`, () => {
      const html = row(
        {
          reactions: [
            { key: "👍", emoji: "👍", count: 1, own: true, label: "Nora" },
            { key: "☕", emoji: "☕", count: 3 },
          ],
          onToggleReaction: () => {},
          onAddReaction: () => {},
        },
        locale,
      );

      expect(html).toMatch(new RegExp(`class="k2b-message-row__reactions" role="group" aria-label="${words.reactions}"`));
      expect(html).toContain(`aria-pressed="true" aria-label="${words.one}" title="Nora" data-own=""`);
      expect(html).toContain(`aria-pressed="false" aria-label="${words.many}"`);
      expect(html).toMatch(new RegExp(`<button[^>]*aria-label="${words.add}"`));
      // Pressed says which are the reader's own; the label stays the same.
      expect(html).not.toContain(words.ownOne);
      // Chips that do not fit scroll sideways behind a fade.
      const list = (markup: string) => markup.match(/<div[^>]*k2b-message-row__reaction-list[^>]*>/)?.[0] ?? "";
      expect(list(html)).toContain('data-scroll-fade-axis="horizontal"');
      expect(list(html)).toContain('data-scroll-fade-mode="both"');
      expect(list(html)).not.toContain("tabindex");
      // Read-only reactions are not controls; their label says which are the reader's own, and their list is a tab stop
      // so a keyboard can scroll it. A reserved bar stays even while it is empty.
      const readOnly = row(
        {
          reactions: [
            { key: "👍", emoji: "👍", count: 1, label: "Nora" },
            { key: "🎉", emoji: "🎉", count: 1, own: true, label: "Nora" },
            { key: "☕", emoji: "☕", count: 3, own: true },
          ],
        },
        locale,
      );
      expect(readOnly).toContain(`<span class="k2b-message-row__reaction" role="img" aria-label="${words.one}"`);
      expect(readOnly).toContain(`aria-label="${words.ownOne.replace("👍", "🎉")}"`);
      expect(readOnly).toContain(`aria-label="${words.ownMany}"`);
      expect(readOnly).not.toContain("aria-pressed");
      expect(list(readOnly)).toContain('tabindex="0"');
      expect(row({ reactions: [], onAddReaction: () => {} }, locale)).toMatch(/class="k2b-message-row__reactions"[^>]*data-empty=""/);
      expect(row({}, locale)).not.toContain("k2b-message-row__reactions");
    });

    test(`opens a thread from a bar with people, count, and last reply (${locale})`, () => {
      const people = ["Ada", "Ben", "Cleo", "Dan"].map((name) => ({ name }));
      const html = row(
        { thread: { count: 3, participants: people, lastReply: "10:42", lastReplyDateTime: "2026-10-06T08:42:00Z", onOpen: () => {} } },
        locale,
      );

      expect(html).toMatch(
        /<button type="button" class="k2b-message-row__thread"><span class="k2b-message-row__thread-people" aria-hidden="true">/,
      );
      expect(html.match(/class="k2b-avatar ?" data-size="xs"/g)).toHaveLength(3);
      expect(html).toContain(`<span class="k2b-message-row__thread-count">${words.replies}</span>`);
      expect(html).toContain(`datetime="2026-10-06T08:42:00.000Z">${words.last}</time>`);
    });

    test(`shows the same progress line and Stop for every author (${locale})`, () => {
      const person = row({ text: "", progress: { status: "Writing", onStop: () => {} } }, locale);
      const agent = row(
        { author: { name: "Minutes", icon: "ti ti-robot" }, text: "", progress: { status: "Writing", onStop: () => {} } },
        locale,
      );
      const line = (html: string) => html.slice(html.indexOf('class="k2b-message-row__line"'));

      expect(line(person)).toBe(line(agent));
      expect(textOf(line(person))).toEndWith(`Writing ${words.stop}`);
      expect(person).toContain('class="k2b-message-row__writing"><span class="k2b-chat-progress-dots" aria-hidden="true">');
      // The bubble is busy while the message is written, also before its first word.
      const streaming = row({ text: "Half a sen", progress: { status: "Writing" } }, locale);
      expect(streaming).toMatch(/class="k2b-message-row__bubble"[^>]*aria-busy="true"/);
      expect(person).toMatch(/class="k2b-message-row__bubble"[^>]*aria-busy="true"/);
      expect(row({ text: "Done" }, locale)).not.toContain("aria-busy");
      expect(textOf(line(streaming))).toEndWith("Writing");
    });

    test(`names images, videos, and the rest of a full grid (${locale})`, () => {
      const html = row(
        {
          attachments: [
            { ...image, alt: "One", onOpen: () => {} },
            { kind: "video", src: "/clip.webp", alt: "Clip", width: 1920, height: 1080, duration: "0:42", onOpen: () => {} },
            { ...image, alt: "Three", onOpen: () => {} },
            { ...image, alt: "Four", onOpen: () => {} },
            { ...image, alt: "Five" },
            { ...image, alt: "Six" },
          ],
        },
        locale,
      );

      expect(html).toContain('data-count="4"');
      expect(html.match(/<img /g)).toHaveLength(4);
      expect(html).toContain(`aria-label="${words.video}"`);
      expect(html).toContain(`aria-label="${words.more}"`);
      expect(html).toContain('<span class="k2b-message-row__media-more" aria-hidden="true">+2</span>');
    });
  }

  test("reserves a single image's area from its stored size before it loads", () => {
    const style = (attachment: object) => {
      const html = row({ attachments: [attachment as typeof image] });
      return {
        width: html.match(/class="k2b-message-row__media"[^>]*style="width: ?([^"]+)"/)?.[1],
        ratio: html.match(/class="k2b-message-row__media-item" style="aspect-ratio: ?([^;"]+)/)?.[1],
      };
    };

    expect(style(image)).toEqual({ width: "min(100%, 1200px, calc(var(--k2b-message-media-height) * 1.5))", ratio: "1.5" });
    // Very tall and very wide pictures are cropped to a ratio that still reads in a conversation.
    expect(style({ ...image, width: 400, height: 4000 }).ratio).toBe("0.5");
    expect(style({ ...image, width: 9000, height: 1000 }).ratio).toBe("3");
    expect(style({ ...image, width: 0, height: 0 })).toEqual({
      width: "min(100%, calc(var(--k2b-message-media-height) * 1.3333333333333333))",
      ratio: "1.3333333333333333",
    });
    const html = row({ attachments: [image] });
    expect(html).toMatch(/<img[^>]*src="\/media\/grid.webp"[^>]*alt[ =][^>]*width="1200"[^>]*height="800"[^>]*loading="lazy"/);
    // Without a way to open it, the picture itself carries the description.
    expect(html).toMatch(/<span class="k2b-message-row__media-item" style="aspect-ratio: ?1.5;?" role="img" aria-label="Tile grid">/);
    expect(html).toContain("data-media");
    expect(row()).not.toContain("data-media");
  });

  test("shows files as chips and opens attachments only from safe URLs", () => {
    const html = row({
      attachments: [
        { ...pdf, href: "https://example.com/testplan.pdf" },
        { kind: "file", name: "notes.zip", href: "javascript:alert(1)" },
        { kind: "file", name: "photo.heic", icon: "ti ti-photo", href: "/files/photo.heic" },
        { ...image, src: "javascript:alert(2)", href: "data:text/html,hi" },
      ],
    });

    expect(html).toMatch(
      /<a class="k2b-message-row__file"[^>]* href="https:\/\/example.com\/testplan.pdf" target="_blank" rel="noopener noreferrer"><span class="k2b-message-row__file-icon" aria-hidden="true"><i class="ti ti-file-type-pdf">/,
    );
    expect(textOf(html)).toContain("Testplan.pdf PDF · 412 KB notes.zip photo.heic");
    expect(html).toMatch(
      /<span class="k2b-message-row__file"[^>]*><span class="k2b-message-row__file-icon" aria-hidden="true"><i class="ti ti-file-zip">/,
    );
    expect(html).toContain('href="/files/photo.heic"');
    expect(html).toContain('<i class="ti ti-photo">');
    expect(html).not.toMatch(/javascript:|data:text/);
    // A picture may be inline image data or a file still uploading; a link may be neither, because a blob: URL would
    // run an uploaded HTML file in the page's origin.
    const inline = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E";
    expect(row({ attachments: [{ ...image, src: inline, href: inline }] })).toMatch(
      /<span class="k2b-message-row__media-item"[^>]*><img src="data:image\/svg\+xml,/,
    );
    const uploading = "blob:https://cloud.example/0b7c6a1e-3f7d-4a3e-9d1c-2f8e6b9a7c55";
    const optimistic = row({
      attachments: [
        { ...image, src: uploading, href: uploading },
        { ...pdf, href: uploading },
      ],
    });
    expect(optimistic).toContain(`<img src="${uploading}"`);
    expect(optimistic).not.toContain(`href="${uploading}"`);
    expect(optimistic).toMatch(/<span class="k2b-message-row__file"/);
    // A message of attachments alone has no empty bubble.
    expect(row({ text: " ", attachments: [pdf] })).not.toContain("k2b-message-row__bubble");
  });

  test("places the caller's link preview and card below the attachments", () => {
    const html = row({ attachments: [pdf], linkPreview: "Preview", card: "Card" });

    expect(html.indexOf("k2b-message-row__files")).toBeLessThan(html.indexOf('<div class="k2b-message-row__slot">Preview</div>'));
    expect(html.indexOf("Preview")).toBeLessThan(html.indexOf('<div class="k2b-message-row__slot">Card</div>'));
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

  test("gives rich content fixed heights and reserved areas", () => {
    expect(declarations(".k2b-ui .k2b-message-row__thread").get("height")).toEqual(["1.75rem"]);
    expect(declarations(".k2b-ui .k2b-message-row__thread").get("white-space")).toEqual(["nowrap"]);
    expect(declarations(".k2b-ui .k2b-message-row__reactions").get("height")).toEqual(["1.625rem"]);
    expect(declarations(".k2b-ui .k2b-message-row__reaction-list").get("overflow-x")).toEqual(["auto"]);
    expect(declarations(".k2b-ui .k2b-message-row__file").get("height")).toEqual(["2.75rem"]);
    expect(declarations(".k2b-ui .k2b-message-row__quote-text").get("-webkit-line-clamp")).toEqual(["2"]);
    // The image never sizes its area; it covers the area the row reserved.
    const picture = declarations(".k2b-ui .k2b-message-row__media-item img");
    expect(picture.get("position")).toEqual(["absolute"]);
    expect(picture.get("object-fit")).toEqual(["cover"]);
    expect(declarations(".k2b-ui .k2b-message-row__media-item").get("aspect-ratio")).toEqual(["1"]);
    // An empty, reserved bar shows "Add reaction" by paint only, like the actions.
    expect(declarations(".k2b-ui .k2b-message-row__reactions[data-empty] .k2b-message-row__react").get("opacity")).toEqual(["0"]);
    expect(
      [
        ...declarations(
          ".k2b-ui .k2b-message-row:hover .k2b-message-row__reactions[data-empty] .k2b-message-row__react",
          "@media (hover: hover)",
        ).keys(),
      ].sort(),
    ).toEqual(["opacity", "pointer-events"]);
  });

  test("keeps the line's words and buttons whole beside reactions", () => {
    // The line may shrink only down to its own content, and in it only the receipt or progress text gives way.
    expect(declarations(".k2b-ui .k2b-message-row__footer > .k2b-message-row__line").get("min-width")).toEqual(["auto"]);
    const text = declarations(".k2b-ui .k2b-message-row__receipt");
    expect(text.get("-webkit-line-clamp")).toEqual(["1"]);
    expect(text.get("white-space")).toEqual(["normal"]);
    expect(declarations(".k2b-ui .k2b-message-row__reactions:has(> .k2b-message-row__react)").get("min-width")).toEqual(["2rem"]);
  });

  test("gives compact controls the shared touch area without taking layout on fine pointers", () => {
    const coarse = "@media (any-pointer: coarse)";
    const area = rules.find(
      (rule) => rule.context === coarse && rule.selector.endsWith("::after") && rule.selector.includes("button.k2b-message-row__quote"),
    );
    expect(area?.selector).toContain(".k2b-message-row__thread");
    expect(cssDeclarations(area!.body).get("inset")).toEqual(["min(0px, calc((100% - 2.75rem) / 2))"]);
    const list = declarations(".k2b-ui .k2b-message-row__reaction-list", coarse);
    expect(list.get("padding-block")).toEqual(["0.5625rem"]);
    expect(list.get("margin-block")).toEqual(["-0.5625rem"]);
    // Every rule that adds room for those areas applies to touch screens only.
    for (const rule of rules.filter(
      (candidate) =>
        /margin|padding-bottom/.test(candidate.body) && /k2b-message-row__(?:thread|footer|quote)|:has/.test(candidate.selector),
    ))
      if (rule.selector.includes("k2b-message-row")) expect(rule.context, rule.selector).toBe(coarse);
  });

  test("gives every avatar tint a rule", () => {
    for (let tint = 0; tint < 10; tint++) {
      expect(declarations(`.k2b-ui .k2b-avatar[data-tint="${tint}"]`).get("--k2b-avatar-hue")?.[0]).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});
