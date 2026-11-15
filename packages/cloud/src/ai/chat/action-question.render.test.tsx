import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { createDomTestHarness } from "../../../../ui/test/dom";
import { legacyReviewView } from "../../capabilities/legacy-review-view";
import type { ApprovalPage } from "../../contracts/approvals";
import { CapabilityActionCallReviewSchema, CapabilityActionReviewPresentationSchema } from "../../contracts/capabilities";
import type { AiStoredActionReview } from "../action-review";

const root = mkdtempSync(resolve(tmpdir(), "cloud-action-question-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { renderToString } = await import("solid-js/web");
const { ApprovalCard } = await import("../../approvals/ApprovalCard");
const { default: Approvals } = await import("../../approvals/Approvals");
const { toolActionCard } = await import("./action-card");
const { legacyOutcomeWords } = await import("./tool-action-words");
const { actionFixtures, storedLegacyReviews, FIXTURE_AT } = await import("./action-question.fixtures");

type Props = Parameters<typeof ApprovalCard>[0];
const block = () => actionFixtures("de").mail!.block;
const card = (review?: AiStoredActionReview) => {
  const source = block();
  return toolActionCard(
    { ...source, ...(review ? { review } : {}) },
    {
      locale: "de",
      timeZone: "UTC",
      outcome: legacyOutcomeWords(source, "de", "UTC"),
    },
  );
};
const defaults = (): Props => ({
  card: card(),
  state: "open",
  timeZone: "UTC",
  onConfirm: () => {},
  onDecline: () => {},
  outcome: { lines: {}, current: "" },
});
const dom = createDomTestHarness();
dom.cleanup();
const parser = new dom.window.DOMParser();
const parse = (html: string) => parser.parseFromString(html, "text/html").body;
const render = (patch: Partial<Props> = {}) => parse(renderToString(() => createComponent(ApprovalCard, { ...defaults(), ...patch })));
const words = (node: { outerHTML: string }) => {
  const copy = parse(node.outerHTML);
  for (const element of copy.querySelectorAll("span, div, p, button, li")) element.after(" ");
  return copy.textContent?.replace(/\s+/g, " ").trim() ?? "";
};

describe("ApprovalCard at the public rendering seam", () => {
  test("fixtures use view; stored metadata is not part of the app writing contract", () => {
    for (const locale of ["de", "en"] as const)
      for (const fixture of Object.values(actionFixtures(locale))) {
        const review = fixture.block.review;
        if (!review || !("sentence" in review)) continue;
        const { draft: _draft, contentRef: _ref, incomplete: _incomplete, ...written } = review;
        expect(CapabilityActionCallReviewSchema.safeParse(written).success).toBe(true);
        expect(written).not.toHaveProperty("preview");
        expect(written).not.toHaveProperty("content");
      }
  });

  test("head, source, platform reason and app details are visible together", () => {
    const body = render();
    const head = body.querySelector(".k2b-chat-decision__head")!;
    expect(words(head)).toContain("Freigabe · Mail");
    expect(head.querySelector(".ti-shield-check")).not.toBeNull();
    expect(head.querySelector(".ti-mail")).not.toBeNull();
    expect(words(body)).toContain("Details von Mail");
    expect(words(body)).toContain("Ich frage, weil das Cloud verlässt.");
    for (const value of ["An", "Von", "Lea Berg", "Wartungsfenster Dienstag", "Betreff", "Text"]) expect(words(body)).toContain(value);
    expect(body.querySelector('input[value="Wartungsfenster Dienstag"]')?.hasAttribute("readonly")).toBe(true);
  });

  test("consequences stay a list with their change markers", () => {
    const source = actionFixtures("de").share!.block;
    const body = render({
      card: toolActionCard(source, { locale: "de", timeZone: "UTC", outcome: legacyOutcomeWords(source, "de", "UTC") }),
    });
    const changes = body.querySelector('.cloud-action-details__changes[aria-label="Was sich ändert"]')!;
    expect(changes.querySelectorAll("li")).toHaveLength(3);
    expect(changes.querySelector('li[data-mark="added"]')?.textContent).toContain("Tom kann alles darin ansehen");
  });

  test("native detail and rule views retain status, file facts and before values", () => {
    for (const [key, values] of [
      ["task", ["Backups testen", "Offen", "Lea Berg", "Team Ops"]],
      ["share", ["Rechnungen 2026", "48 Dateien in 3 Ordnern"]],
      ["fields", ["IBAN", "DE89 3704 0044 0532 0130 00"]],
      ["routine", ["Neue Aufgaben zusammenfassen", "Liest neue Aufgaben, keine Termine."]],
    ] as const) {
      const source = actionFixtures("de")[key]!.block;
      const body = render({
        card: toolActionCard(source, { locale: "de", timeZone: "UTC", outcome: legacyOutcomeWords(source, "de", "UTC") }),
      });
      for (const value of values) expect(words(body)).toContain(value);
      if (key === "fields") expect(body.querySelector("s")?.textContent).toBe("DE02 1203 0000 0000 2020 51");
    }
  });

  test("remember is a checkbox only when offered; otherwise asks every time", () => {
    expect(render().querySelector('input[type="checkbox"]')).toBeNull();
    expect(words(render())).toContain("Fragt jedes Mal");
    const remembered = render({ remember: { onSelect: () => {} } });
    expect(remembered.querySelector('input[type="checkbox"]')).not.toBeNull();
    expect(words(remembered)).toContain("In diesem Chat nicht mehr fragen");
    expect(words(remembered)).not.toContain("Fragt jedes Mal");
  });

  test("expiry uses a fixed clock", () => {
    const now = spyOn(Date, "now").mockReturnValue(Date.parse(FIXTURE_AT));
    try {
      expect(words(render({ expiresAt: "2026-10-17T12:11:00.000Z" }))).toContain("Läuft ab in 9 Min");
    } finally {
      now.mockRestore();
    }
  });

  for (const [state, tone, label] of [
    ["sending", "running", "Läuft"],
    ["decided", "done", "Erledigt"],
    ["decided", "off", "Abgelehnt"],
    ["expired", "off", "Abgelaufen"],
    ["decided", "error", "Fehlgeschlagen"],
    ["decided", "warning", "Unklar"],
  ] as const)
    test(`compact ${label} keeps head and one outcome`, () => {
      const body = render({
        state,
        outcome: { lines: { result: { tone, text: [{ kind: "text", text: "Ergebnis." }] } }, current: "result" },
      });
      expect(words(body.querySelector(".k2b-chat-decision__head")!)).toContain(`Freigabe · Mail ${label}`);
      expect(words(body)).toContain("Ergebnis.");
      expect(body.querySelector(".k2b-chat-decision__details")).toBeNull();
      expect(body.querySelector(".k2b-chat-decision__answers")).toBeNull();
    });

  test("an editable draft starts in edit mode with a safe next step", () => {
    const body = render({ onEditDraft: async () => true });
    expect(body.querySelector('.k2b-chat-decision[data-mode="edit"]')).not.toBeNull();
    expect(words(body)).toContain("Entwurf · Mail");
    expect(words(body)).toContain("Nichts geht raus, bevor du freigibst.");
    expect(words(body)).toContain("Verwerfen");
    expect(words(body)).toContain("An Lea Berg senden …");
    expect(body.querySelector(".cloud-blocks__field input")?.outerHTML).not.toContain("readonly");
  });

  test("no editing without a callback or for a converted draft", () => {
    expect(render().querySelector('.k2b-chat-decision[data-mode="approve"]')).not.toBeNull();
    const parsed = CapabilityActionReviewPresentationSchema.parse(legacyReviewView(storedLegacyReviews("de").message));
    if (!("sentence" in parsed)) throw new Error("Expected converted view review");
    expect(parsed.draft?.editable).toBe(false);
    const body = render({ card: card(parsed), onEditDraft: async () => true });
    expect(body.querySelector('.k2b-chat-decision[data-mode="approve"]')).not.toBeNull();
    expect(words(body)).not.toContain("Verwerfen");
  });

  test("a large view blocks approval until the full proposal is loaded", () => {
    const source = actionFixtures("de").large!.block;
    const body = render({
      card: toolActionCard(source, { locale: "de", timeZone: "UTC", outcome: legacyOutcomeWords(source, "de", "UTC") }),
    });
    expect(words(body)).toContain("Lies vor der Freigabe den vollständigen Vorschlag.");
    expect(words(body)).toContain("Der vollständige Vorschlag wird geladen");
    expect(body.querySelector('.k2b-chat-decision__answer[data-variant="ai"]')?.hasAttribute("disabled")).toBe(true);
  });

  const keyValues = {
    message: ["lea.berg@example.com", "Wartungsfenster Dienstag", "Wartungsplan-KW43.pdf"],
    page: ["Woche 42", "Wartungsfenster Dienstag", "Server-Update vorbereiten"],
    event: ["Retro", "Raum 2.14", "2026-10-17T13:00:00.000Z"],
    task: ["Backups testen", "Offen", "Restore auf Staging", "Lea Berg"],
    file: ["Rechnungen 2026", "48 Dateien in 3 Ordnern"],
    rule: ["Drei Abschnitte", "Team Ops", "Gibt mir keine neuen Rechte"],
    fields: ["IBAN", "DE02 1203 0000 0000 2020 51", "DE89 3704 0044 0532 0130 00"],
  };
  for (const [kind, stored] of Object.entries(storedLegacyReviews("de")))
    test(`stored ${kind} converts to visible values`, () => {
      const parsed = CapabilityActionReviewPresentationSchema.parse(legacyReviewView(stored));
      if (!("sentence" in parsed)) throw new Error("Expected converted view review");
      expect(parsed.draft?.editable).toBe(false);
      const body = render({ card: card(parsed) });
      for (const value of keyValues[kind as keyof typeof keyValues]) expect(words(body) + body.innerHTML).toContain(value);
    });

  test("one look: chat, flat panel and initial approvals page have identical decision subtrees", () => {
    const review = block().review!;
    if (!("sentence" in review)) throw new Error("Expected view review");
    const initial: ApprovalPage = {
      items: [
        {
          id: "00000000-0000-4000-8000-000000000001",
          app: { id: "mail", name: "Mail", icon: "ti ti-mail" },
          action: "draft.send",
          assurance: "confirm",
          sentence: "Send draft",
          review,
          requester: { kind: "chat", appId: "assistant", title: "Mail", href: "/app/assistant" },
          remember: { chat: false, always: false, website: false },
          createdAt: FIXTURE_AT,
          expiresAt: "2026-10-18T12:02:00.000Z",
        },
      ],
      count: 1,
      elsewhere: 0,
      nextCursor: null,
    };
    const same = { ...defaults(), card: { ...card(), app: { name: "Mail", icon: "ti ti-mail" } }, expiresAt: initial.items[0]!.expiresAt };
    const chat = parse(renderToString(() => createComponent(ApprovalCard, same)));
    const panel = parse(`<aside data-k2b-layer="flat">${renderToString(() => createComponent(ApprovalCard, same))}</aside>`);
    const page = parse(renderToString(() => createComponent(Approvals, { app: "mail", initial })));
    const signature = (host: ReturnType<typeof parse>) => {
      const root = host.querySelector(".k2b-chat-decision")!;
      return [root, ...root.querySelectorAll("*")].map((node) => ({
        tag: node.tagName,
        classes: [...node.classList].sort(),
        data: Object.fromEntries(
          [...node.attributes].filter((a) => a.name.startsWith("data-") && a.name !== "data-chat-anchor").map((a) => [a.name, a.value]),
        ),
      }));
    };
    expect(signature(panel)).toEqual(signature(chat));
    expect(signature(page)).toEqual(signature(chat));
  });
});
