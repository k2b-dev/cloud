import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { Window } from "happy-dom";
import { createComponent, type JSX } from "solid-js";
import { renderToString } from "solid-js/web";
import type { ChatDecisionProps, ChatOutcomeLine, ChatOutcomeTone } from "../index";

const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-decision-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { Chat, ReferenceChip, truncateMiddle, LocaleProvider } = await import("../index");
const window = new Window();
const render = (content: () => JSX.Element) => {
  const body = window.document.createElement("div");
  body.innerHTML = renderToString(content);
  return body;
};
const noop = () => undefined;
const decision = (extra: Partial<ChatDecisionProps> = {}) =>
  createComponent(Chat.Decision, {
    state: "open",
    sentence: "Send the mail?",
    reason: { text: "You asked to review it." },
    confirm: { label: "Send", icon: "ti ti-send", onSelect: noop },
    decline: { label: "Keep draft", icon: "ti ti-x", onSelect: noop },
    ...extra,
  });

describe("Chat.Decision SSR", () => {
  test("names and describes its section, orders sentence, reason, preview and answers on the sentence class", () => {
    const body = render(() => decision({ preview: createComponent(Chat.Preview, { children: "Mail preview" }) }));
    const section = body.querySelector("section")!;
    const sentence = body.querySelector(".k2b-chat-decision__sentence")!;
    const reason = body.querySelector(".k2b-chat-decision__reason")!;
    expect(section.getAttribute("aria-labelledby")).toBe(sentence.id);
    expect(section.getAttribute("aria-describedby")).toBe(reason.id);
    expect(sentence.getAttribute("tabindex")).toBe("-1");
    expect(sentence.className).toBe("k2b-chat-decision__sentence");
    expect(Array.from(section.children).map((e) => e.className)).toEqual([
      "k2b-chat-decision__sentence",
      "k2b-chat-line k2b-chat-decision__reason",
      "k2b-chat-preview ",
      "k2b-chat-decision__answers",
    ]);
    expect(reason.getAttribute("data-tone")).toBe("neutral");
    expect(reason.querySelector("i")!.className).toContain("ti-info-circle");
    const buttons = body.querySelectorAll("button");
    expect(buttons.length).toBe(2);
    expect(buttons[0]!.textContent).toBe("Send");
    expect(buttons[0]!.getAttribute("data-variant")).toBe("ai");
    expect(buttons[0]!.querySelector(".ti-send")).not.toBeNull();
    expect(buttons[1]!.textContent).toBe("Keep draft");
    expect(buttons[1]!.querySelector(".ti-x")).not.toBeNull();
    expect(body.querySelector(".k2b-chat-decision__remember")).toBeNull();
  });
  for (const tone of ["neutral", "danger", "warning"] as const)
    test(`reason supports ${tone} and an icon override`, () => {
      const body = render(() => decision({ reason: { text: "Reason", tone, icon: "ti ti-shield" } }));
      expect(body.querySelector("[data-tone]")!.getAttribute("data-tone")).toBe(tone);
      expect(body.querySelector(".k2b-chat-decision__reason i")!.className).toContain("ti-shield");
    });
  for (const variant of ["danger", "primary"] as const)
    test(`confirm supports ${variant}`, () => {
      const body = render(() => decision({ confirm: { label: "Confirm", variant, onSelect: noop } }));
      expect(body.querySelector("button")!.getAttribute("data-variant")).toBe(variant);
    });
  test("unavailable replaces the described reason and disables only confirm and remember", () => {
    const body = render(() =>
      decision({
        remember: { label: "Remember this choice", onSelect: noop },
        unavailable: { text: "The recipient is unavailable.", icon: "ti ti-alert-triangle", tone: "warning" },
      }),
    );
    const reason = body.querySelector(".k2b-chat-decision__reason")!;
    expect(body.querySelector("section")!.getAttribute("aria-describedby")).toBe(reason.id);
    expect(reason.textContent).toBe("The recipient is unavailable.");
    expect(body.textContent).not.toContain("You asked to review it.");
    expect(reason.getAttribute("data-tone")).toBe("warning");
    expect(reason.querySelector(".ti-alert-triangle")).not.toBeNull();
    expect(Array.from(body.querySelectorAll("button")).map((b) => b.disabled)).toEqual([true, false, true]);
    expect(body.querySelector(".k2b-chat-decision__remember")!.getAttribute("data-variant")).toBe("text");
  });
  test("remember is an optional enabled quiet answer", () => {
    const body = render(() => decision({ remember: { label: "Remember", onSelect: noop } }));
    expect(body.querySelectorAll("button").length).toBe(3);
    expect(body.querySelector(".k2b-chat-decision__remember")!.hasAttribute("disabled")).toBe(false);
  });
  for (const state of ["sending", "decided", "expired"] as const)
    test(`${state} replaces the question with its outcome`, () => {
      const body = render(() => decision({ state, outcome: "Outcome slot" }));
      expect(body.firstElementChild!.getAttribute("data-state")).toBe(state);
      // Busy belongs to the outcome's words; a busy ancestor would hold back its live region.
      expect(body.firstElementChild!.hasAttribute("aria-busy")).toBe(false);
      expect(body.textContent).toBe("Outcome slot");
      expect(body.querySelector("button, section")).toBeNull();
    });
});

describe("Chat.Outcome SSR", () => {
  const icons: Record<ChatOutcomeTone, string> = {
    running: "ti-loader-2",
    done: "ti-check",
    off: "ti-circle-off",
    waiting: "ti-clock",
    warning: "ti-alert-triangle",
    error: "ti-alert-circle",
  };
  for (const tone of ["running", "done", "off", "waiting", "warning", "error"] as const)
    test(`${tone} has its default icon and busy semantics`, () => {
      const body = render(() => createComponent(Chat.Outcome, { current: "one", lines: { one: { tone, text: "Result" } } }));
      const outcome = body.firstElementChild!;
      expect(outcome.getAttribute("data-tone")).toBe(tone);
      expect(outcome.hasAttribute("aria-busy")).toBe(false);
      expect(outcome.querySelector(".k2b-chat-outcome__cell")!.getAttribute("aria-busy")).toBe(tone === "running" ? "true" : null);
      expect(outcome.querySelector('[aria-busy] [role="status"]')).toBeNull();
      expect(outcome.getAttribute("tabindex")).toBe("-1");
      expect(outcome.hasAttribute("data-enter")).toBe(false);
      expect(outcome.querySelector("i")!.className).toContain(icons[tone]);
      expect(outcome.querySelector('[role="status"]')!.textContent).toBe("");
      expect(outcome.querySelector('[role="status"]')!.getAttribute("aria-live")).toBe("polite");
    });
  test("keeps all lines in one cell, hides inactive lines and actions, and overrides the icon", () => {
    const lines: Record<string, ChatOutcomeLine> = {
      done: {
        tone: "done",
        text: "Sent",
        detail: "To Lea.",
        time: "09:41",
        icon: "ti ti-mail",
        action: { label: "Open mail", onSelect: noop },
        actions: "Current controls",
      },
      expired: { tone: "off", text: "Expired", action: { label: "Ask again", onSelect: noop }, actions: "Hidden controls" },
    };
    const body = render(() => createComponent(Chat.Outcome, { current: "done", lines }));
    const entries = body.querySelectorAll(".k2b-chat-outcome__cell > .k2b-chat-outcome__text");
    expect(entries.length).toBe(2);
    expect(entries[0]!.getAttribute("data-current")).toBe("true");
    expect(entries[0]!.hasAttribute("aria-hidden")).toBe(false);
    expect(entries[1]!.hasAttribute("data-current")).toBe(false);
    expect(entries[1]!.getAttribute("aria-hidden")).toBe("true");
    expect(entries[0]!.querySelector(".k2b-chat-outcome__detail")!.textContent).toBe("To Lea.");
    expect(entries[0]!.querySelector(".k2b-chat-outcome__time")!.textContent).toBe("09:41");
    expect(entries[0]!.querySelector("button")!.textContent).toBe("Open mail");
    expect(entries[0]!.querySelector("button")!.hasAttribute("tabindex")).toBe(false);
    expect(entries[1]!.querySelector("button")!.getAttribute("tabindex")).toBe("-1");
    expect(entries[0]!.querySelector(".k2b-chat-outcome__actions")!.textContent).toBe("Current controls");
    // Inactive lines keep their buttons, hidden with their text, so the shared cell reserves that row too.
    expect(entries[1]!.querySelector(".k2b-chat-outcome__actions")!.textContent).toBe("Hidden controls");
    expect(body.querySelector(".k2b-chat-outcome__icon i")!.className).toBe("ti ti-mail");
  });
});

for (const [locale, added, removed] of [
  ["en", "new:", "removed:"],
  ["de", "neu:", "weg:"],
] as const)
  test(`Preview parts and localized marks in ${locale}`, () => {
    const body = render(() =>
      createComponent(LocaleProvider, {
        locale,
        get children() {
          return createComponent(Chat.Preview, {
            get children() {
              return [
                createComponent(Chat.Preview.Header, {
                  rows: [
                    {
                      label: "To",
                      people: [{ name: "Lea", address: "lea@example.test" }, { address: "tom@example.test" }],
                      value: "and others",
                    },
                    { label: "Bcc", emphasis: true, value: "Hidden recipient" },
                  ],
                  note: "Sends now",
                }),
                createComponent(Chat.Preview.Title, { children: "Mail title", meta: "Draft" }),
                createComponent(Chat.Preview.Sentence, { children: "Every Friday" }),
                createComponent(Chat.Preview.Excerpt, { children: "Hello\nThe complete draft" }),
                createComponent(Chat.Preview.ReadMore, { href: "/draft/1", title: "This version", children: "Read draft" }),
                createComponent(Chat.Preview.Line, { icon: "ti ti-file", accent: "red", meta: "12 KB", children: "Attachment" }),
                createComponent(Chat.Preview.Lines, {
                  label: "Consequences",
                  get children() {
                    return [
                      createComponent(Chat.Preview.Line, { icon: "ti ti-plus", mark: "added", children: "Sends mail" }),
                      createComponent(Chat.Preview.Line, { icon: "ti ti-minus", mark: "removed", tone: "muted", children: "Old rule" }),
                      createComponent(Chat.Preview.Line, { icon: "ti ti-alert-triangle", tone: "warning", children: "Outside content" }),
                    ];
                  },
                }),
                createComponent(Chat.Preview.People, { people: [{ name: "Lea" }, { name: "Tom" }], children: "Lea and Tom" }),
                createComponent(Chat.Mark, { change: "added", children: "New words" }),
                createComponent(Chat.Mark, { change: "removed", children: "Old words" }),
              ];
            },
          });
        },
      }),
    );
    expect(body.querySelector("dt")!.textContent).toBe("To");
    expect(body.querySelector("dd b")!.textContent).toBe("Lea");
    expect(body.querySelector("dd")!.textContent).toContain(", tom@example.test");
    expect(body.querySelector('[data-emphasis="true"] dt')!.textContent).toBe("Bcc");
    expect(body.querySelector('[data-alone="true"]')!.textContent).toBe("tom@example.test");
    expect(body.querySelector(".k2b-chat-preview__header > p")!.textContent).toBe("Sends now");
    expect(body.querySelector(".k2b-chat-preview__title")!.textContent).toBe("Mail title");
    expect(body.querySelector(".k2b-chat-preview__title-line .k2b-chat-preview__meta")!.textContent).toBe("Draft");
    expect(body.querySelector(".k2b-chat-preview__sentence")!.textContent).toBe("Every Friday");
    expect(body.querySelector(".k2b-chat-preview__excerpt")!.textContent).toBe("Hello\nThe complete draft");
    const link = body.querySelector("a")!;
    expect([link.getAttribute("href"), link.title, link.textContent]).toEqual(["/draft/1", "This version", "Read draft"]);
    const attachment = body.querySelector("p.k2b-chat-preview__line")!;
    expect(attachment.querySelector("i")!.getAttribute("style")).toContain("color:red");
    expect(attachment.querySelector(".k2b-chat-preview__meta")!.textContent).toBe("12 KB");
    expect(body.querySelectorAll('ul[aria-label="Consequences"] > li').length).toBe(3);
    expect(body.querySelector('li[data-tone="muted"] .k2b-chat-mark[data-change="removed"]')).not.toBeNull();
    expect(body.querySelector('li:not([data-tone]) .k2b-chat-mark[data-change="added"] .k2b-sr-only')!.textContent).toBe(`${added} `);
    expect(body.querySelector('li[data-tone="muted"] .k2b-chat-mark .k2b-sr-only')!.textContent).toBe(`${removed} `);
    expect(body.querySelector('li[data-tone="warning"] .k2b-chat-mark')!.hasAttribute("data-change")).toBe(false);
    expect(body.querySelector('li[data-tone="warning"]')!.textContent).toBe("Outside content");
    expect(body.querySelectorAll("mark .k2b-sr-only").length).toBe(1);
    for (const word of body.querySelectorAll("mark .k2b-sr-only")) expect(word.textContent).toBe(`${added} `);
    for (const word of body.querySelectorAll("del .k2b-sr-only")) expect(word.textContent).toBe(`${removed} `);
    const faces = body.querySelector(".k2b-chat-preview__faces")!;
    expect(faces.getAttribute("aria-hidden")).toBe("true");
    expect(faces.querySelectorAll(".k2b-avatar").length).toBe(2);
    expect(faces.nextElementSibling!.textContent).toBe("Lea and Tom");
  });

test("an excerpt without a page of its own shows the rest in place", () => {
  const body = render(() => [
    createComponent(Chat.Preview.Excerpt, { id: "body-1", children: "One\nTwo\nThree\nFour" }),
    createComponent(Chat.Preview.ShowAll, { controls: "body-1", onShow: () => undefined, children: "Read it all" }),
    createComponent(Chat.Preview.Excerpt, { id: "body-2", expanded: true, children: "Shown whole" }),
  ]);
  const [closed, open] = body.querySelectorAll(".k2b-chat-preview__excerpt");
  expect(closed!.hasAttribute("data-expanded")).toBe(false);
  expect(closed!.hasAttribute("tabindex")).toBe(false);
  // A shown text takes the focus from the button that leaves, so reading goes on there.
  expect([open!.getAttribute("data-expanded"), open!.getAttribute("tabindex")]).toEqual(["true", "-1"]);
  const button = body.querySelector("button.k2b-chat-preview__more")!;
  expect([
    button.getAttribute("type"),
    button.getAttribute("aria-controls"),
    button.getAttribute("aria-expanded"),
    button.textContent,
  ]).toEqual(["button", "body-1", "false", "Read it all"]);
});

describe("ReferenceChip", () => {
  test("object and place link to their targets with a decorative accented icon", () => {
    for (const kind of ["object", "place"] as const) {
      const body = render(() =>
        createComponent(ReferenceChip, { kind, title: "Draft", href: "/draft", icon: "ti ti-mail", accent: "#123456" }),
      );
      const chip = body.querySelector("a")!;
      expect(chip.getAttribute("data-kind")).toBe(kind);
      expect(chip.getAttribute("href")).toBe("/draft");
      expect(chip.getAttribute("style")).toContain("--k2b-reference-icon:#123456");
      expect(chip.querySelector("i")!.getAttribute("aria-hidden")).toBe("true");
      expect(chip.textContent).toBe("Draft");
    }
  });
  test("gone objects and places are non-link spans", () => {
    for (const kind of ["object", "place"] as const) {
      const body = render(() => createComponent(ReferenceChip, { kind, title: "Deleted", href: "/old", gone: true }));
      expect(body.firstElementChild!.tagName).toBe("SPAN");
      expect(body.firstElementChild!.getAttribute("data-gone")).toBe("true");
      expect(body.firstElementChild!.hasAttribute("href")).toBe(false);
    }
  });
  test("person shows a hidden avatar and only the display name; time is machine-readable", () => {
    const person = render(() => createComponent(ReferenceChip, { kind: "person", name: "Lea Berg", href: "/people/lea" }));
    const avatar = person.querySelector(".k2b-reference__avatar")!;
    expect(avatar.getAttribute("aria-hidden")).toBe("true");
    expect(avatar.querySelector(".k2b-avatar")).not.toBeNull();
    avatar.remove();
    expect(person.textContent).toBe("Lea Berg");
    expect(person.textContent).not.toContain("@");
    const time = render(() => createComponent(ReferenceChip, { kind: "time", label: "Friday", dateTime: "2026-10-16" }));
    expect(time.querySelector("time")!.getAttribute("datetime")).toBe("2026-10-16");
    expect(time.querySelector("time")!.getAttribute("data-kind")).toBe("time");
    expect(time.querySelector("time")!.textContent).toBe("Friday");
  });
  test("never marks a chip as long: it wraps by layout, not by a character count", () => {
    const body = render(() => createComponent(ReferenceChip, { kind: "object", title: "W".repeat(60) }));
    expect(body.firstElementChild!.hasAttribute("data-long")).toBe(false);
  });
  test("60-character titles show 40 graphemes, preserve .pdf and retain the full accessible title", () => {
    const title = `${"a".repeat(56)}.pdf`;
    const body = render(() => createComponent(ReferenceChip, { kind: "object", title, href: "/file" }));
    const chip = body.querySelector("a")!;
    const visible = chip.querySelector('[aria-hidden="true"]')!.textContent;
    expect(Array.from(new Intl.Segmenter().segment(visible)).length).toBe(40);
    expect(visible.endsWith(".pdf")).toBe(true);
    expect(chip.querySelector(".k2b-sr-only")!.textContent).toBe(title);
    expect(chip.title).toBe(title);
  });
  test("truncateMiddle leaves short and exact strings alone, keeps endings and whole graphemes", () => {
    expect(truncateMiddle("short")).toBe("short");
    expect(truncateMiddle("x".repeat(40))).toBe("x".repeat(40));
    expect(truncateMiddle(`${"a".repeat(56)}.pdf`)).toBe(`${"a".repeat(20)}…${"a".repeat(15)}.pdf`);
    expect(truncateMiddle("abcdef.pdf", 7)).toBe("abc…pdf");
    for (const grapheme of ["👩🏽‍💻", "e\u0301", "🇩🇪"]) {
      expect(truncateMiddle(grapheme.repeat(50), 5)).toBe(`${grapheme}${grapheme}…${grapheme}${grapheme}`);
    }
  });
});

test("Chat.Activity supports the warning tone", () => {
  const body = render(() =>
    createComponent(Chat.Activity, {
      label: "Answer lost",
      tone: "warning",
      get children() {
        return createComponent(Chat.Outcome, {
          current: "lost",
          lines: { lost: { tone: "warning", text: "Check the sent folder before trying again." } },
        });
      },
    }),
  );
  expect(body.querySelector(".k2b-chat-activity")!.getAttribute("data-tone")).toBe("warning");
});
