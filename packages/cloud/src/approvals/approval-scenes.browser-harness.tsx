import { ButtonLink, ChangeList, Chat, type ChatDecisionState, LocaleProvider } from "@k2b/ui";
import type { JSX } from "solid-js";
import { render } from "solid-js/web";
import type { ActionCard, ActionText } from "../ai/chat/action-card";
import { toolActionCard } from "../ai/chat/action-card";
import type { ActionLine } from "../ai/chat/action-question";
import { actionFixtures, FIXTURE_AT } from "../ai/chat/action-question.fixtures";
import { AiTurnBlockView } from "../ai/chat/blocks";
import { legacyOutcomeWords } from "../ai/chat/tool-action-words";
import { createAiToolDisclosureState } from "../ai/chat/tool-disclosure";
import { layoutAiTurn } from "../ai/chat/turn-layout";
import { AiTurnView } from "../ai/chat/turn-view";
import { CloudSurveyBlock } from "../ai/chat/visual-tools";
import { cardToolResult, chartToolResult } from "../ai/gustav-views";
import type { AiTurnBlock } from "../ai/protocol";
import { capabilityResultView } from "../ai/result-view";
import type { ApprovalPage } from "../contracts/approvals";
import type { CapabilityActionCallReview } from "../contracts/capabilities";
import { ApprovalCard } from "./ApprovalCard";
import { ApprovalFrame } from "./ApprovalFrame";
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
          {
            ...fixtures.mail!.block,
            presentation: { ...fixtures.mail!.block.presentation!, appId: "spaces", appName: "Spaces", appIcon: "ti ti-layout-kanban" },
            review: { ...draftReview("spaces"), draft: { editable: true, fields: ["title", "description"] } },
          },
          { locale: "de", timeZone: "Europe/Berlin", outcome: legacyOutcomeWords(fixtures.mail!.block, "de", "Europe/Berlin") },
        )}
        draft
      />
      <Card
        card={toolActionCard(
          {
            ...fixtures.mail!.block,
            presentation: { ...fixtures.mail!.block.presentation!, appId: "grids", appName: "Grids", appIcon: "ti ti-table" },
            review: { ...draftReview("grids"), draft: { editable: true, fields: ["item", "place", "estimate"] } },
          },
          { locale: "de", timeZone: "Europe/Berlin", outcome: legacyOutcomeWords(fixtures.mail!.block, "de", "Europe/Berlin") },
        )}
        draft
      />
    </>
  ),
  // The frame a Code version fills (Gustav v12, version card): data only, no Capability.
  // Gustav's own chart (v12 06): the same island under Cloud's head as an app's result, with Gustav as its origin.
  gustav: () => {
    const args = {
      kind: "line",
      title: "Gesamtsaldo",
      subtitle: "letzte 6 Monate, in Tausend Euro",
      area: true,
      series: [
        {
          label: "Saldo",
          data: [13.4, 14.1, 13.2, 14.2, 15, 15.5].map((y, index) => ({ x: `2026-${String(index + 6).padStart(2, "0")}-01`, y })),
        },
      ],
    };
    const result = chartToolResult(args);
    return (
      <>
        <Label>Gustavs Diagramm</Label>
        <AiTurnBlockView
          turnId="turn-1"
          block={{
            id: "tool-chart",
            kind: "tool",
            callId: "chart-1",
            name: "chart",
            args,
            status: "completed",
            at: FIXTURE_AT,
            result,
            view: capabilityResultView(result) ?? undefined,
          }}
        />
      </>
    );
  },
  // Gustav's key figures and chart in one answer (v12 06): one flat row under one head, the chart as an island.
  konten: () => {
    const tool = (id: string, name: string, args: Record<string, unknown>, result: unknown): AiTurnBlock => ({
      id,
      kind: "tool",
      callId: id,
      name,
      args,
      status: "completed",
      at: FIXTURE_AT,
      result,
      view: capabilityResultView(result) ?? undefined,
    });
    const card = (id: string, args: Record<string, unknown>) => tool(id, "card", args, cardToolResult(args));
    const chartArgs = {
      kind: "line",
      title: "Gesamtsaldo",
      subtitle: "letzte 6 Monate, in Tausend Euro",
      area: true,
      series: [
        {
          label: "Saldo",
          data: [13.4, 14.1, 13.2, 14.2, 15, 15.5].map((y, index) => ({ x: `2026-${String(index + 6).padStart(2, "0")}-01`, y })),
        },
      ],
    };
    const blocks: AiTurnBlock[] = [
      card("c1", { icon: "building-bank", title: "Girokonto", value: "2.481,20 €", trendValue: "+312,00 €", trendLabel: "seit 01.11." }),
      card("c2", { icon: "pig-money", title: "Tagesgeld", value: "12.050,00 €", caption: "2,1 % Zins" }),
      card("c3", { icon: "home", title: "Haushaltstopf", value: "640,00 €", caption: "dein Anteil" }),
      card("c4", { icon: "credit-card", title: "Kreditkarte", value: "−312,45 €", caption: "Abbuchung 28.11." }),
      tool("g1", "chart", chartArgs, chartToolResult(chartArgs)),
      { id: "t1", kind: "text", text: "Nach den 4 Zahlungen bleiben auf dem Girokonto etwa **1.176 €**." },
    ];
    return (
      <>
        <Label>Konten im November</Label>
        <AiTurnView
          segment={() => ({
            id: "ai-turn:turn-1:start",
            turnId: "turn-1",
            phase: "completed",
            layout: layoutAiTurn(blocks, { phase: "completed" }),
            earlier: false,
            duration: () => null,
          })}
          disclosureState={createAiToolDisclosureState()}
        />
      </>
    );
  },
  // Durchgang 5, #78: Gustav asked for three key figures, once as stat charts, once as cards with their signs; both
  // stand as the flat row of key figures under his head.
  kennzahlen: () => {
    const tool = (id: string, name: string, args: Record<string, unknown>, result: unknown): AiTurnBlock => ({
      id,
      kind: "tool",
      callId: id,
      name,
      args,
      status: "completed",
      at: FIXTURE_AT,
      result,
      view: capabilityResultView(result) ?? undefined,
    });
    const statArgs = {
      title: "Logistik – Kennzahlen",
      subtitle: "Stand 15.11., 13:35",
      layout: "grid",
      charts: [
        { kind: "stat", title: "Offene Aufgaben", value: 1366, subtitle: "Momentaufnahme", icon: "list-check" },
        { kind: "stat", title: "Diese Woche fällig", value: 3, subtitle: "15. – 21.11.", icon: "calendar-due" },
        { kind: "stat", title: "Ohne Fälligkeit", value: 1363, subtitle: "Überwiegend Automation-Duplikate", icon: "calendar-off" },
      ],
    };
    const card = (id: string, args: Record<string, unknown>) => tool(id, "card", args, cardToolResult(args));
    const segment = (id: string, blocks: AiTurnBlock[]) => (
      <AiTurnView
        segment={() => ({
          id: `ai-turn:${id}:start`,
          turnId: id,
          phase: "completed",
          layout: layoutAiTurn(blocks, { phase: "completed" }),
          earlier: false,
          duration: () => null,
        })}
        disclosureState={createAiToolDisclosureState()}
      />
    );
    return (
      <>
        <Label>Als Stat-Diagramme</Label>
        {segment("turn-1", [tool("s1", "chart", statArgs, chartToolResult(statArgs))])}
        <Label>Als Karten</Label>
        {segment("turn-2", [
          card("c1", { icon: "list-check", title: "Offene Aufgaben", value: "1.366", caption: "Momentaufnahme" }),
          card("c2", { icon: "calendar-due", title: "Diese Woche fällig", value: "3", caption: "15. – 21.11." }),
          card("c3", { icon: "calendar-off", title: "Ohne Fälligkeit", value: "1.363", caption: "Überwiegend Automation-Duplikate" }),
        ])}
      </>
    );
  },
  // Gustav's own question with options (v12 07): the same flat choice as a view's.
  survey: () => (
    <>
      <Label>Auswahl</Label>
      <CloudSurveyBlock
        args={{
          title: "Welche Jana meinst du?",
          description: "Gustav liest dann nur die Mails dieser Person.",
          submitLabel: "Diese Jana nehmen",
          questions: [
            {
              id: "jana",
              type: "single",
              label: "Person",
              required: true,
              options: [
                { label: "Jana Berger", value: "berger" },
                { label: "Jana Probe", value: "probe" },
                { label: "Jana Albers", value: "albers" },
              ],
            },
          ],
        }}
        onSubmit={() => {}}
      />
    </>
  ),
  frame: () => {
    const code = { name: "Code", icon: "ti ti-code", accent: "var(--k2b-ai-accent)" };
    const sentence: ActionText = [
      { kind: "chip", chip: { kind: "object", title: "Version 5" } },
      { kind: "text", text: " von " },
      { kind: "chip", chip: { kind: "object", title: "Code von info@" } },
      { kind: "text", text: " einschalten?" },
    ];
    // A function: each frame draws its own list.
    const details = () => ({
      label: "Details von Code",
      context: "gegenüber Version 4",
      note: { text: "Cloud prüft Zugriffe und Auslöser, nicht das Verhalten.", icon: "ti ti-info-circle" },
      content: (
        <ChangeList
          label="Änderungen"
          items={[
            { tone: "add", content: "Läuft zusätzlich Mo–Fr um 08:00" },
            { tone: "add", content: "Darf neu Dateien ablegen im Ordner Lieferscheine 2026" },
            { tone: "remove", content: "Darf nicht mehr Unterhaltungen markieren im Postfach info@" },
          ]}
        />
      ),
    });
    return (
      <>
        <Label>Bereit</Label>
        <ApprovalFrame
          locale="de"
          state="open"
          source={code}
          sentence={sentence}
          reason={{ text: "Sie darf danach mehr als Version 4: Sie legt Dateien ab, die andere sehen.", icon: "ti ti-eye" }}
          details={details()}
          meta={[
            { text: "3 von 3 Beispielen erfolgreich", icon: "ti ti-circle-check", tone: "success" },
            { text: "Bis dahin bleibt Version 4 eingeschaltet", icon: "ti ti-history" },
          ]}
          link={{ label: "Alles ansehen", href: "/app/code/info" }}
          confirm={{ label: "Version 5 einschalten", icon: "ti ti-power", onSelect: () => {} }}
        />
        <Label>Wartet auf Admin</Label>
        <ApprovalFrame
          locale="de"
          state="open"
          source={code}
          sentence={[...sentence.slice(0, 3), { kind: "text", text: " wartet auf die Freigabe eines Admins." }]}
          reason={{ text: "In eurer Cloud gibt ein Admin jede Automation frei, die etwas tut, das andere sehen.", icon: "ti ti-eye" }}
          details={details()}
          notes={[
            { text: "Die Admins wissen Bescheid. Du bekommst eine Mitteilung, sobald einer entschieden hat.", icon: "ti ti-bell" },
            { text: "Bis dahin bleibt Version 4 eingeschaltet. Du musst nichts tun.", icon: "ti ti-history" },
          ]}
          meta={[{ text: "3 von 3 Beispielen erfolgreich", icon: "ti ti-circle-check", tone: "success" }]}
          more={[
            { label: "Zurückziehen", onSelect: () => {} },
            { label: "Ohne Dateien ablegen bauen", icon: "ti ti-git-fork", onSelect: () => {} },
          ]}
          link={{ label: "Alles ansehen", href: "/app/code/info" }}
        />
        <Label>Bereit, aber ohne Beispiele</Label>
        <ApprovalFrame
          locale="de"
          state="open"
          source={code}
          sentence={sentence}
          reason={{ text: "Sie darf danach mehr als Version 4: Sie legt Dateien ab, die andere sehen.", icon: "ti ti-eye" }}
          details={details()}
          meta={[
            { text: "Keine Beispiele: Niemand hat ausprobiert, was sie tut", icon: "ti ti-alert-triangle", tone: "warning" },
            { text: "Bis dahin bleibt Version 4 eingeschaltet", icon: "ti ti-history" },
          ]}
          more={[{ label: "Erst Beispiele ausprobieren", onSelect: () => {} }]}
          confirm={{ label: "Trotzdem einschalten", icon: "ti ti-power", onSelect: () => {} }}
        />
        <Label>Wartet auf Admin, auf der Code-Seite</Label>
        <ApprovalFrame
          locale="de"
          state="decided"
          source={code}
          status={{ tone: "waiting", label: "Wartet auf Admin" }}
          reason={{ text: "In eurer Cloud gibt ein Admin jede Automation frei, die etwas tut, das andere sehen.", icon: "ti ti-eye" }}
          outcome={
            <Chat.Outcome
              current="state"
              lines={{
                state: {
                  tone: "waiting",
                  text: "Version 5 wartet auf die Freigabe eines Admins.",
                  detail: "Die Admins wissen Bescheid. Bis dahin bleibt Version 4 eingeschaltet.",
                  actions: (
                    <ButtonLink variant="text" href="/app/code/info">
                      Alles ansehen
                    </ButtonLink>
                  ),
                },
              }}
            />
          }
        />
        <Label>Lädt</Label>
        <ApprovalFrame locale="de" state="loading" source={code} reason={{ text: "" }} />
      </>
    );
  },
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
