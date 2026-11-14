import { AiModelChooser, type AiModelChooserState } from "@k2b/cloud/ai/ui";
import type { AiModelRequest, AiPeopleModels } from "@k2b/cloud/shared";
import { Chat, IconButton, LocaleProvider, ProgressBar } from "@k2b/ui";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";

const params = new URL(location.href).searchParams;
const state = params.get("state") ?? "rest";
const mark = (text: string, color: string) => ({ kind: "mark" as const, text, color });
const options: AiPeopleModels["options"] = [
  { id: "fast", label: "Orion", variantLabel: "Schnell", description: "Kurze Antworten", icon: mark("OR", "#0f766e"), classes: ["fast"] },
  { id: "bal", label: "Orion", variantLabel: "Ausgewogen", description: "Für die meisten Aufgaben", icon: mark("OR", "#0f766e"), classes: ["balanced"] },
  { id: "deep", label: "Orion", variantLabel: "Gründlich", description: "Für komplexe Aufgaben", icon: mark("OR", "#0f766e"), classes: ["thorough"] },
  { id: "max", label: "Orion", variantLabel: "Maximal", description: "Lange Texte", icon: mark("OR", "#0f766e"), classes: ["maximum"] },
];
const models: AiPeopleModels = {
  status: "ok",
  selection: null,
  effectiveDefault: { class: "balanced" },
  classes: [
    { class: "fast", variantId: "fast" },
    { class: "balanced", variantId: "bal" },
    { class: "thorough", variantId: "deep" },
    { class: "maximum", variantId: "max" },
  ],
  options,
};
const none = state === "nomodel";
const chooser: AiModelChooserState = none ? { status: "ready", models: { ...models, classes: [], options: [] } } : { status: "ready", models };
const budget = state === "usage" ? 86 : 34;
render(() => {
  const [value, setValue] = createSignal<AiModelRequest | null>({ class: "balanced" });
  const [draft, setDraft] = createSignal(state === "typed" ? "Ja, und frag auch nach dem Stromanschluss." : "");
  return (
    <LocaleProvider locale="de">
      <div id="cell" style={{ width: "min(522px, calc(100vw - 32px))", margin: "40px auto" }}>
        <Chat.Composer
          value={draft()}
          onValueChange={setDraft}
          placeholder={none ? "Gustav kann gerade nicht antworten" : state === "running" ? "Weitere Nachricht vormerken" : "Gustav etwas fragen"}
          state={state === "running" ? "running" : "idle"}
          runningSubmitIntent="queue"
          onStop={() => {}}
          disabled={none}
          addOpensCommands
          menuActions={[{ id: "files", label: "Dateien", icon: "ti ti-paperclip", onSelect: () => {} }]}
          suggestion={state === "suggestion" ? { text: "Ja, entwirf die Antwort an Jana und häng das Angebot an", onAccept: () => {}, onDismiss: () => {} } : undefined}
          contextUsage={{ usage: { input: 14_000, output: 2_000 }, loopUsage: { total: 20_000 }, contextWindow: 128_000, modelLabel: "Orion" }}
          contextPopupAction={{ id: "compact", label: "Jetzt zusammenfassen", icon: "ti ti-arrows-diagonal-minimize-2", onSelect: () => {} }}
          contextSections={[
            {
              id: "budget",
              title: "Dein Budget",
              warnAt: 80,
              percent: budget,
              value: `${budget} % genutzt`,
              summary: `Budget ${budget} % genutzt`,
              content: <ProgressBar value={budget} size="xs" tone={budget >= 80 ? "warning" : "info"} label="Orion" />,
            },
          ]}
          submitTools={
            <>
              <AiModelChooser state={chooser} value={value()} onChange={setValue} locked={state === "running"} lockedReason="Während eine Antwort läuft, bleibt das Modell gleich." />
              <IconButton type="button" variant="ghost" size="sm" label="Diktieren">
                <i class="ti ti-microphone" aria-hidden="true" />
              </IconButton>
            </>
          }
          onSubmit={() => {}}
        />
      </div>
    </LocaleProvider>
  );
}, document.getElementById("root")!);
