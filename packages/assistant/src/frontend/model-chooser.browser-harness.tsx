import { AiModelChooser, type AiModelChooserState, AiModelNote, aiModelBlocksSending } from "@k2b/cloud/ai/ui";
import type { AiModelRequest, AiPeopleModels } from "@k2b/cloud/shared";
import { Chat, IconButton, LocaleProvider } from "@k2b/ui";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import AssistantEmptyChat from "./AssistantEmptyChat";

// The Assistant's empty chat with the real composer, chip, card and note; `?state=` and `?choice=` pick a case.
const params = new URL(location.href).searchParams;
const state = params.get("state") ?? "normal";
const locale = params.get("locale") ?? "de";
const mark = (text: string, color: string) => ({ kind: "mark" as const, text, color });
const budget = { code: "budget_exhausted" as const, resetsAt: "2026-11-02T00:00:00.000Z" };
const long = "Ein künstlich langer Stufenname mit vielen Zeichen";
const options: AiPeopleModels["options"] = [
  { id: "mistral-small", label: "Mistral Small", description: "Kurze Antworten, schnell", icon: mark("CO", "#0f766e"), classes: ["fast"] },
  {
    id: "gpt-oss-120b",
    label: "GPT-OSS",
    variantLabel: "Ausgewogen",
    description: "Für die meisten Aufgaben",
    icon: mark("CO", "#0f766e"),
    classes: ["balanced"],
  },
  {
    id: "gpt-oss-120b:gruendlich",
    label: "GPT-OSS",
    variantLabel: "Gründlich",
    description: "Für komplexe Aufgaben",
    icon: mark("CO", "#0f766e"),
    classes: ["thorough"],
  },
  {
    id: "claude:maximal",
    label: "Claude",
    variantLabel: "Maximal",
    description: "Lange Texte und Code",
    icon: mark("OR", "#6d28d9"),
    classes: ["maximum"],
    ...(state === "budget" ? { unavailable: budget } : state === "revoked" ? { unavailable: { code: "access_revoked" as const } } : {}),
  },
  { id: "gemini-flash", label: "Gemini Flash", description: "Schnell bei Bildern", icon: mark("OR", "#6d28d9"), classes: [] },
  {
    id: "qwen",
    label: "Qwen",
    variantLabel: "Gründlich",
    description: "Wenn Inhalte im Haus bleiben sollen",
    icon: mark("RE", "#475569"),
    classes: [],
  },
  { id: "long", label: long, description: "Nur zum Messen", icon: mark("LA", "#be123c"), classes: [] },
  ...Array.from({ length: 2 }, (_, index) => ({
    id: `extra-${index}`,
    label: `Modell ${index + 1}`,
    description: "Zusätzliches Modell",
    icon: mark("EX", "#1d4ed8"),
    classes: [],
  })),
];
const models: AiPeopleModels = {
  status: "ok",
  selection: null,
  effectiveDefault: { class: "balanced" },
  classes: [
    { class: "fast", variantId: "mistral-small" },
    { class: "balanced", variantId: "gpt-oss-120b" },
    { class: "thorough", variantId: "gpt-oss-120b:gruendlich" },
    ...(state === "unassigned"
      ? []
      : [{ class: "maximum" as const, variantId: "claude:maximal", ...(state === "budget" ? { unavailable: budget } : {}) }]),
  ],
  options: state === "single" ? options.slice(1, 2) : options,
};
const chooserState: AiModelChooserState =
  state === "loading"
    ? { status: "loading" }
    : state === "error"
      ? { status: "error" }
      : state === "empty"
        ? { status: "ready", models: { ...models, classes: [], options: [] } }
        : { status: "ready", models };
const initial = (): AiModelRequest | null => {
  const choice = params.get("choice");
  if (!choice) return state === "budget" || state === "revoked" || state === "unassigned" ? { class: "maximum" } : null;
  const modelClass = (["fast", "balanced", "thorough", "maximum"] as const).find((entry) => entry === choice);
  return modelClass ? { class: modelClass } : { id: choice };
};

render(() => {
  const [value, setValue] = createSignal(initial());
  const [draft, setDraft] = createSignal(params.get("draft") ?? "");
  const running = state === "running";
  return (
    <LocaleProvider locale={locale}>
      <main style={{ height: "100dvh", overflow: "auto" }}>
        <AssistantEmptyChat
          composer={
            <Chat.Composer
              value={draft()}
              onValueChange={setDraft}
              placeholder="Assistent etwas fragen"
              state={running ? "running" : "idle"}
              submitDisabled={aiModelBlocksSending(chooserState, value())}
              fileSelection={{ onSelect: () => {}, choose: async () => [], disabled: running }}
              submitTools={
                <>
                  <AiModelChooser
                    state={chooserState}
                    value={value()}
                    onChange={setValue}
                    locked={running}
                    lockedReason="Während eine Antwort läuft, bleibt das Modell gleich."
                  />
                  <IconButton type="button" variant="ghost" size="sm" label="Diktieren" data-test="mic">
                    <i class="ti ti-microphone" aria-hidden="true" />
                  </IconButton>
                </>
              }
              onSubmit={() => {}}
            />
          }
          modelNote={
            aiModelBlocksSending(chooserState, value()) || state === "budget" || state === "revoked" ? (
              <AiModelNote state={chooserState} value={value()} onChange={setValue} />
            ) : undefined
          }
          projects={[]}
          selectedProjectId={null}
          onChooseProject={() => {}}
          onStarter={() => {}}
        />
      </main>
    </LocaleProvider>
  );
}, document.getElementById("root")!);
document.body.dataset.ready = "true";
