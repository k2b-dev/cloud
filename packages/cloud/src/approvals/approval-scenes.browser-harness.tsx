import { type ChatDecisionState, LocaleProvider } from "@k2b/ui";
import type { JSX } from "solid-js";
import { render } from "solid-js/web";
import type { ActionCard, ActionText } from "../ai/chat/action-card";
import { toolActionCard } from "../ai/chat/action-card";
import type { ActionLine } from "../ai/chat/action-question";
import { actionFixtures, FIXTURE_AT } from "../ai/chat/action-question.fixtures";
import { legacyOutcomeWords } from "../ai/chat/tool-action-words";
import type { ApprovalPage } from "../contracts/approvals";
import type { CapabilityActionCallReview } from "../contracts/capabilities";
import { ApprovalCard } from "./ApprovalCard";
import Approvals from "./Approvals";

/**
 * The approval scenes of the capability views concept, from fictional fixtures: every state, a mail draft and its
 * approval, drafts of three apps, and one approval in the chat, a flat side panel, the approvals page and on a phone.
 */
const params = new URLSearchParams(location.search);
const scene = params.get("scene") ?? "states";
const fixtures = actionFixtures("de");
const reviewOf = (key: string): CapabilityActionCallReview => {
  const review = fixtures[key]!.block.review;
  if (!review || !("sentence" in review)) throw new Error(`Missing view fixture ${key}`);
  return review;
};
const cardOf = (key: string, review: CapabilityActionCallReview = reviewOf(key), extra: { draft?: boolean } = {}): ActionCard => {
  const block = fixtures[key]!.block;
  return toolActionCard(
    { ...block, review: extra.draft ? { ...review, draft: { editable: true, fields: ["subject", "body"] } } : review },
    { locale: "de", timeZone: "Europe/Berlin", outcome: legacyOutcomeWords(block, "de", "Europe/Berlin") },
  );
};
const text = (value: string): ActionText => [{ kind: "text", text: value }];
const expiresAt = new Date(Date.parse(FIXTURE_AT) + 9 * 60_000).toISOString();

function Card(props: { card: ActionCard; state?: ChatDecisionState; line?: ActionLine; remember?: boolean; draft?: boolean }): JSX.Element {
  return (
    <ApprovalCard
      card={props.card}
      state={props.state ?? "open"}
      timeZone="Europe/Berlin"
      expiresAt={props.state && props.state !== "open" ? undefined : expiresAt}
      remember={props.remember ? { onSelect: () => {} } : undefined}
      onEditDraft={props.draft ? async () => true : undefined}
      onConfirm={() => {}}
      onDecline={() => {}}
      outcome={{ lines: props.line ? { now: props.line } : {}, current: "now" }}
    />
  );
}

/** A draft of another app: the same small form, with read-only context and labels above the fields. */
const draftReview = (app: "spaces" | "grids"): CapabilityActionCallReview => ({
  locale: "de",
  sentence: {
    action: app === "spaces" ? "Aufgabe {task} anlegen" : "Eintrag {item} speichern",
    running: app === "spaces" ? "Aufgabe {task} wird angelegt …" : "Eintrag {item} wird gespeichert …",
    done: app === "spaces" ? "Aufgabe {task} angelegt." : "Eintrag {item} gespeichert.",
    confirm: app === "spaces" ? "Anlegen" : "Speichern",
    decline: "Verwerfen",
    short: app === "spaces" ? "Neue Aufgabe im Space Ankauf" : "Neuer Eintrag in der Tabelle Bestand",
  },
  slots: app === "spaces" ? { task: { kind: "text", value: "Foto anfragen" } } : { item: { kind: "text", value: "Jugendstil-Vase" } },
  view: {
    version: 1,
    blocks: [
      app === "spaces"
        ? {
            kind: "Draft",
            context: [{ label: "Space", value: "Ankauf" }],
            fields: [
              { name: "title", label: "Titel", type: "text", value: "Foto der Marke bei Frau Albers anfragen" },
              {
                name: "description",
                label: "Beschreibung",
                type: "textarea",
                value: "Für die Schätzung fehlt ein Foto der Marke am Boden. Frist bis 12.11., dann Angebot schreiben.",
              },
            ],
          }
        : {
            kind: "Draft",
            fields: [
              { name: "item", label: "Artikel", type: "text", value: "Jugendstil-Vase, Zinnmontierung" },
              {
                name: "place",
                label: "Lagerort",
                type: "select",
                value: "n02",
                options: [{ value: "n02", label: "N-02 · Vitrine Kommission" }],
              },
              { name: "estimate", label: "Schätzwert", type: "text", value: "1.500–1.900 €" },
            ],
          },
    ],
  },
  ask: "app_asks",
});

const page: ApprovalPage = {
  items: [
    {
      id: "00000000-0000-4000-8000-000000000001",
      app: { id: "spaces", name: "Spaces", icon: "ti ti-layout-kanban" },
      action: "event.delete",
      assurance: "standard",
      sentence: "Termin löschen",
      review: reviewOf("del"),
      requester: { kind: "chat", appId: "assistant", title: "Ordner aufräumen", href: "/app/assistant" },
      remember: { chat: false, always: false, website: false },
      createdAt: FIXTURE_AT,
      expiresAt,
    },
  ],
  count: 1,
  elsewhere: 0,
  nextCursor: null,
};

const Label = (props: { children: string }) => <p class="scene-label">{props.children}</p>;

const scenes: Record<string, () => JSX.Element> = {
  states: () => {
    const mail = cardOf("mail");
    const del = cardOf("del");
    return (
      <>
        <Label>Wartet</Label>
        <Card card={cardOf("share")} remember />
        <Label>Läuft</Label>
        <Card card={mail} state="sending" line={{ tone: "running", text: mail.forms.running }} />
        <Label>Erledigt</Label>
        <Card
          card={mail}
          state="decided"
          line={{ tone: "done", text: mail.forms.done, time: "14:52", action: { label: "In Mail öffnen", onSelect: () => {} } }}
        />
        <Label>Abgelehnt</Label>
        <Card card={del} state="decided" line={{ tone: "off", text: del.forms.rejected, detail: "Du hast abgelehnt.", time: "14:53" }} />
        <Label>Abgelaufen</Label>
        <Card
          card={del}
          state="expired"
          line={{ tone: "off", text: text("Die Frage ist abgelaufen."), action: { label: "Noch einmal fragen", onSelect: () => {} } }}
        />
        <Label>Fehlgeschlagen</Label>
        <Card
          card={mail}
          state="decided"
          line={{
            tone: "error",
            text: text("Mail hat abgelehnt: Das Postfach ist voll. Nichts wurde gesendet."),
            action: { label: "Erneut versuchen", onSelect: () => {} },
          }}
        />
        <Label>Unklar</Label>
        <Card
          card={mail}
          state="decided"
          line={{
            tone: "warning",
            text: mail.forms.unknown,
            detail: "Mail weiß noch nicht, ob gesendet wurde.",
            action: { label: "Noch einmal prüfen", onSelect: () => {} },
          }}
        />
      </>
    );
  },
  mail: () => <Card card={cardOf("mail", reviewOf("mail"), { draft: true })} draft />,
  drafts: () => (
    <>
      <Card card={cardOf("mail", reviewOf("mail"), { draft: true })} draft />
      <Card
        card={toolActionCard(
          { ...fixtures.mail!.block, review: { ...draftReview("spaces"), draft: { editable: true, fields: ["title", "description"] } } },
          { locale: "de", timeZone: "Europe/Berlin", outcome: legacyOutcomeWords(fixtures.mail!.block, "de", "Europe/Berlin") },
        )}
        draft
      />
      <Card
        card={toolActionCard(
          {
            ...fixtures.mail!.block,
            review: { ...draftReview("grids"), draft: { editable: true, fields: ["item", "place", "estimate"] } },
          },
          { locale: "de", timeZone: "Europe/Berlin", outcome: legacyOutcomeWords(fixtures.mail!.block, "de", "Europe/Berlin") },
        )}
        draft
      />
    </>
  ),
  everywhere: () => (
    <div class="scene-places">
      <section data-place="chat">
        <Label>Gustav-Chat</Label>
        <Card card={cardOf("del")} />
      </section>
      <aside data-place="panel" data-k2b-layer="flat">
        <Label>Seitenpanel</Label>
        <Card card={cardOf("del")} />
      </aside>
      <section data-place="page">
        <Label>Seite „Freigaben“</Label>
        <Approvals app="spaces" initial={page} />
      </section>
    </div>
  ),
};

const root = document.createElement("main");
root.className = `scene scene--${scene}`;
document.body.append(root);
render(() => <LocaleProvider locale="de">{(scenes[scene] ?? scenes.states!)()}</LocaleProvider>, root);
