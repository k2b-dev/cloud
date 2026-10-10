import { describe, expect, test } from "bun:test";
import { ok } from "@k2b/stdlib";
import { z } from "zod";
import { mailCapabilities } from "../../../mail/src/capabilities";
import { mailCapabilityPresentation } from "../../../mail/src/capability-presentation";
import { type CapabilityActionSentences, type CapabilityPresentationCatalog, defineCapabilities } from "../contracts/capabilities";
import { compileCapabilities, compileCapabilityPresentation, resolveCapabilityActionWording } from "./capabilities";
import {
  type CapabilityActionWording,
  capabilityActionOutcome,
  capabilityActionSubject,
  capabilitySentenceFallback,
  renderCapabilitySentence,
  resolveCapabilityActionSentences,
} from "./capability-sentences";

const Recipient = z.object({
  name: z.string().max(200).optional().describe("Display name."),
  address: z.string().max(320).describe("Address."),
});

/** One Action whose sentences are under test; everything else about the app stays minimal. */
const app = (presentation?: unknown) =>
  defineCapabilities({
    protocolVersion: 2,
    presentation: presentation as CapabilityPresentationCatalog,
    queries: {
      list: {
        title: "List messages",
        description: "Lists messages.",
        input: z.object({ folder: z.string().max(100).describe("Folder.") }).strict(),
        data: z.array(z.object({ id: z.string() })),
        openWorld: false,
        run: async () => ok({ data: [] }),
      },
    },
    actions: {
      send: {
        title: "Send email",
        description: "Sends one email.",
        input: z
          .object({
            to: z.array(Recipient).max(50).describe("Recipients."),
            subject: z.string().max(200).describe("Subject line."),
            sendAt: z.iso.datetime({ offset: true }).optional().describe("Delivery time."),
          })
          .strict(),
        data: z.object({ messageId: z.string() }).strict(),
        destructive: false,
        openWorld: false,
        idempotency: "required",
        run: async () => ok({ data: { messageId: "M-1" } }),
      },
    },
  });

const compile = (presentation: unknown) => compileCapabilities("acme", app(presentation));

describe("sentence validation", () => {
  test("accepts placeholders that name declared fields and keeps only what a reader may show", () => {
    const { presentation } = compile({
      baseLocale: "en",
      sentences: { send: { approval: "Send email to {input.to}", done: "Sent {data.messageId} to {input.to[].name}" } },
      translations: { de: { actions: { send: { sentences: { approval: "E-Mail an {input.to} senden" } } } } },
    });
    expect(presentation?.sentences).toEqual({
      send: { approval: "Send email to {input.to}", done: "Sent {data.messageId} to {input.to[].name}" },
    });
    expect(presentation?.translations.de?.actions?.send?.sentences).toEqual({ approval: "E-Mail an {input.to} senden" });
  });

  test.each([
    [{ sentences: { send: { approval: "Send to {input.cc}" } } }, /placeholder \{input\.cc\} does not exist/],
    [{ sentences: { send: { approval: "Sent {data.messageId}" } } }, /may read \{data\.messageId\} only in done/],
    [{ sentences: { send: { rejected: "No {data.messageId}" } } }, /only in done/],
    [{ sentences: { send: { approval: "Send {to}" } } }, /placeholder other than/],
    [{ sentences: { send: { approval: "Send {input.to" } } }, /placeholder other than/],
    [{ sentences: { send: { approval: "Send‮email" } } }, /control or direction characters/],
    [{ sentences: { send: { approval: "x".repeat(201) } } }, /at most 200 characters/],
    [{ sentences: { send: { approval: Array(7).fill("{input.subject}").join(" ") } } }, /more than 6 placeholders/],
    [{ sentences: { send: { later: "Later" } } }, /unsupported field "later"/],
    [{ sentences: { send: {} } }, /needs at least one sentence/],
    [{ sentences: { missing: { approval: "Missing" } } }, /unknown localId "missing"/],
    [{ sentences: {}, translations: { de: { queries: { list: { sentences: { approval: "Nein" } } } } } }, /unsupported field "sentences"/],
  ])("rejects an invalid declaration at app start: %p", (overlay, error) => {
    expect(() => compile({ baseLocale: "en", translations: {}, ...overlay })).toThrow(error);
  });

  test("a reader of a newer or broken producer keeps the Action's other copy and drops only its sentences", () => {
    const { manifest } = compile(undefined);
    const read = compileCapabilityPresentation(
      manifest,
      {
        baseLocale: "en",
        sentences: { send: { approval: "Send {input.unknown}" }, missing: { approval: "Gone" } },
        translations: { de: { actions: { send: { title: "E-Mail senden", sentences: { approval: "{data.messageId}" } } } } },
      },
      "reader",
    );
    expect(read?.sentences).toBeUndefined();
    expect(read?.translations.de?.actions?.send).toEqual({ title: "E-Mail senden" });
  });
});

const context = { locale: "en", timeZone: "Europe/Berlin" };
const fields = [
  { path: "input.to", label: "Recipients" },
  { path: "input.subject", label: "Subject" },
  { path: "input.sendAt", label: "Delivery time", format: "date-time" as const },
] as const;

describe("sentence rendering", () => {
  test("inserts values as bounded plain text and never reads them as a template", () => {
    const render = (subject: unknown) => renderCapabilitySentence("Send {input.subject}", { input: { subject } }, fields, context);
    expect(render("Offer\n\u001b[31mred‮")).toBe("Send Offer [31mred");
    expect(render("{input.secret} <b>bold</b>")).toBe("Send {input.secret} <b>bold</b>");
    expect(render("x".repeat(80))).toBe(`Send ${"x".repeat(59)}…`);
    // A value that cannot be shown leaves no gap: the caller words the call generically instead.
    expect(render("   ")).toBeNull();
    expect(render(undefined)).toBeNull();
    expect(renderCapabilitySentence("Send {input.constructor}", { input: {} }, fields, context)).toBeNull();
  });

  test("names people and resources by their display names and bounds lists", () => {
    const to = [
      { name: "Jana Berger", address: "jana@example.com" },
      { address: "max@example.com" },
      { name: "", address: "a@example.com" },
      { name: "Ida" },
    ];
    expect(renderCapabilitySentence("Send to {input.to}", { input: { to } }, fields, context)).toBe(
      "Send to Jana Berger, max@example.com, and 2 more",
    );
    expect(renderCapabilitySentence("An {input.to} senden", { input: { to: to.slice(0, 2) } }, fields, { locale: "de" })).toBe(
      "An Jana Berger und max@example.com senden",
    );
    expect(renderCapabilitySentence("Send to {input.to[].name}", { input: { to } }, fields, context)).toBe("Send to Jana Berger and Ida");
  });

  test("formats dates, times, numbers, and yes or no for the reader", () => {
    const at = "2026-10-12T07:00:00Z";
    expect(renderCapabilitySentence("Send at {input.sendAt}", { input: { sendAt: at } }, fields, context)).toBe(
      "Send at Oct 12, 2026, 09:00",
    );
    expect(
      renderCapabilitySentence("Am {input.sendAt}", { input: { sendAt: at } }, fields, { locale: "de", timeZone: "America/New_York" }),
    ).toBe("Am 12. Okt. 2026, 03:00");
    // A calendar date is the same day everywhere.
    expect(
      renderCapabilitySentence("Due {input.due}", { input: { due: "2026-10-12" } }, [], { locale: "de", timeZone: "Pacific/Honolulu" }),
    ).toBe("Due 12. Okt. 2026");
    expect(renderCapabilitySentence("{input.count} Zeilen", { input: { count: 12345.5 } }, [], { locale: "de" })).toBe("12.345,5 Zeilen");
    expect(renderCapabilitySentence("Urgent: {input.urgent}", { input: { urgent: false } }, [], { locale: "de" })).toBe("Urgent: nein");
  });

  test("the generic sentence shows the title with the first two labelled fields in schema order", () => {
    const wording: CapabilityActionWording = { title: "Send email", fields };
    expect(capabilitySentenceFallback(wording, { to: [], subject: "Offer", sendAt: "2026-10-12T07:00:00Z" }, context)).toBe(
      "Send email · Subject: Offer · Delivery time: Oct 12, 2026, 09:00",
    );
    expect(capabilitySentenceFallback(wording, {}, context)).toBe("Send email");
    // A template with a missing value falls back the same way.
    expect(
      capabilityActionSubject({ ...wording, sentences: { approval: "Send to {input.to}" } }, { to: [], subject: "Offer" }, context),
    ).toBe("Send email · Subject: Offer");
  });

  test("labelled fields leave out identifiers, flags, and long text, and are bounded", () => {
    const { manifest, presentation } = compileCapabilities(
      "acme",
      defineCapabilities({
        protocolVersion: 2,
        actions: {
          update: {
            title: "Update note",
            description: "Updates one note.",
            input: z
              .object({
                noteId: z.string().max(40).describe("Note ID."),
                expectedRevision: z.number().int().describe("Current revision."),
                pinned: z.boolean().describe("Whether the note is pinned."),
                body: z.string().max(64_000).describe("Note body."),
                title: z.string().max(200).describe("Note title; shown in lists."),
                due: z.iso.date().optional().describe("A rather long description that cannot serve as a short field label at all."),
              })
              .strict(),
            data: z.object({ id: z.string() }).strict(),
            destructive: false,
            openWorld: false,
            idempotency: "none",
            run: async () => ok({ data: { id: "n" } }),
          },
        },
      }),
    );
    expect(resolveCapabilityActionWording(manifest.actions[0]!, presentation, "en").fields).toEqual([
      { path: "input.title", label: "Note title" },
    ]);
  });
});

describe("sentence locales", () => {
  const catalog = {
    baseLocale: "en",
    sentences: { send: { approval: "Send email", done: "Sent email" } },
    translations: { de: { actions: { send: { sentences: { approval: "E-Mail senden" } } } }, fr: {} },
  } satisfies CapabilityPresentationCatalog;

  test("the most specific locale that words the Action provides the whole set, so one receipt never mixes languages", () => {
    expect(resolveCapabilityActionSentences("send", catalog, "de-CH")).toEqual({ approval: "E-Mail senden" });
    expect(resolveCapabilityActionSentences("send", catalog, "fr")).toEqual(catalog.sentences.send);
    expect(resolveCapabilityActionSentences("other", catalog, "de")).toBeUndefined();
    const wording: CapabilityActionWording = { title: "E-Mail senden", sentences: resolveCapabilityActionSentences("send", catalog, "de") };
    expect(capabilityActionOutcome(wording, "done", { input: {} }, { locale: "de" })).toBeNull();
  });
});

describe("one contract for every app", () => {
  /** A third-party app that declares Mail's draft sentences for an Action of its own, through the same public catalog. */
  const thirdParty = () => {
    const mailSentences = (locale: "en" | "de"): CapabilityActionSentences =>
      (locale === "en"
        ? mailCapabilityPresentation.sentences?.["draft.create"]
        : mailCapabilityPresentation.translations.de?.actions?.["draft.create"]?.sentences)!;
    return compileCapabilities(
      "acme-mail",
      defineCapabilities({
        protocolVersion: 2,
        presentation: {
          baseLocale: "en",
          sentences: { "message.draft": mailSentences("en") },
          translations: { de: { actions: { "message.draft": { title: "Entwurf erstellen", sentences: mailSentences("de") } } } },
        },
        actions: {
          "message.draft": {
            title: "Create draft",
            description: "Creates a draft.",
            input: z.object({ to: z.array(Recipient).max(200).describe("Primary recipients.") }).strict(),
            data: z.object({ id: z.string() }).strict(),
            destructive: false,
            openWorld: false,
            idempotency: "required",
            run: async () => ok({ data: { id: "d" } }),
          },
        },
      }),
    );
  };

  test("a third-party app's sentences render exactly like Mail's", () => {
    const mail = compileCapabilities("mail", mailCapabilities);
    const acme = thirdParty();
    const mailDraft = mail.manifest.actions.find((action) => action.localId === "draft.create")!;
    const acmeDraft = acme.manifest.actions[0]!;
    const input = { to: [{ name: "Jana Berger", address: "jana@example.com" }], mailboxId: "Mb1", senderIdentityId: "Si1" };
    for (const locale of ["en", "de"]) {
      const mailWording = resolveCapabilityActionWording(mailDraft, mail.presentation, locale);
      const acmeWording = resolveCapabilityActionWording(acmeDraft, acme.presentation, locale);
      for (const key of ["done", "rejected", "notRun"] as const) {
        expect(capabilityActionOutcome(acmeWording, key, { input }, { locale })).toBe(
          capabilityActionOutcome(mailWording, key, { input }, { locale }),
        );
      }
      expect(capabilityActionSubject(acmeWording, input, { locale })).toBe(capabilityActionSubject(mailWording, input, { locale }));
    }
    expect(capabilityActionSubject(resolveCapabilityActionWording(acmeDraft, acme.presentation, "de"), input, { locale: "de" })).toBe(
      "Entwurf an Jana Berger erstellen",
    );
    expect(capabilityActionSubject(resolveCapabilityActionWording(acmeDraft, acme.presentation, "en"), input, { locale: "en" })).toBe(
      "Create a draft to Jana Berger",
    );
  });
});
