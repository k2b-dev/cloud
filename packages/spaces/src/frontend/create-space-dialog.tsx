import { navigateTo } from "@k2b/ssr/nav";
import { Button, ColorInput, InlineGuidance, NoticeCard, prompts, Select, TextInput, useLocale } from "@k2b/ui";
import { createSignal, Show } from "solid-js";
import { apiClient } from "../api/client";
import type { Space } from "../contracts";
import { setLastSpaceId, type ViewType, writeSpaceSettings } from "./[id]/_components/settings/SpaceSettingsStore";
import { readResponseError } from "./lib/response";
import { overviewMessages } from "./overview-messages";

export type SpaceStarter = {
  id: "blank" | "tasks" | "calendar" | "project";
  name: string;
  description: string;
  icon: string;
  color: string;
};
type SpaceDraft = { name: string; description: string; color: string; starter: SpaceStarter };
type CreatedSpace = { space: Space; starter: SpaceStarter };
const starterView: Record<SpaceStarter["id"], ViewType> = { blank: "list", tasks: "kanban", calendar: "calendar", project: "table" };
export const spaceStarters = (t: ReturnType<typeof overviewMessages.resolve>["t"]): SpaceStarter[] => [
  { id: "blank", name: t.blankSpace, description: t.blankSpaceDescription, icon: "ti ti-plus", color: "#3b82f6" },
  { id: "tasks", name: t.taskBoard, description: t.taskBoardDescription, icon: "ti ti-list-check", color: "#3b82f6" },
  { id: "calendar", name: t.eventCalendar, description: t.eventCalendarDescription, icon: "ti ti-calendar-event", color: "#8b5cf6" },
  { id: "project", name: t.projectTracker, description: t.projectTrackerDescription, icon: "ti ti-flag", color: "#10b981" },
];

/** Creates the Space from the dialog, which stays open until the server answers; a refusal shows here with the input. */
function CreateSpaceForm(props: {
  starter: SpaceStarter;
  create: (draft: SpaceDraft) => Promise<Space>;
  close: (value: CreatedSpace | null) => void;
}) {
  const locale = useLocale();
  const { t } = overviewMessages.resolve([locale()]);
  const starters = spaceStarters(t);
  const [starter, setStarter] = createSignal(props.starter);
  const [name, setName] = createSignal(props.starter.id === "blank" ? "" : props.starter.name);
  const [description, setDescription] = createSignal(props.starter.id === "blank" ? "" : props.starter.description);
  const [color, setColor] = createSignal(props.starter.color);
  const [submitting, setSubmitting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const selectStarter = (id: string | null) => {
    const selected = starters.find((entry) => entry.id === id);
    if (!selected) return;
    // A template fills only what still shows the previous template's text, so typed input stays.
    const previous = starter();
    const filled = (value: string, text: string) => value === "" || value === (previous.id === "blank" ? "" : text);
    if (filled(name(), previous.name)) setName(selected.id === "blank" ? "" : selected.name);
    if (filled(description(), previous.description)) setDescription(selected.id === "blank" ? "" : selected.description);
    if (color() === previous.color) setColor(selected.color);
    setStarter(selected);
  };
  const submit = async () => {
    if (!name().trim() || submitting()) return;
    setSubmitting(true);
    setError(null);
    try {
      const chosen = starter();
      const space = await props.create({ name: name().trim(), description: description().trim(), color: color(), starter: chosen });
      props.close({ space, starter: chosen });
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : t.createFailed);
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <form
      class="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Select
        label={t.template}
        value={() => starter().id}
        onValueChange={selectStarter}
        disabled={submitting()}
        options={starters.map((entry) => ({ value: entry.id, label: entry.name, description: entry.description, icon: entry.icon }))}
      />
      <NoticeCard tone="info">{t.adminNotice}</NoticeCard>
      <TextInput
        label={t.name}
        description={t.nameDescription}
        placeholder={starter().name}
        icon="ti ti-typography"
        value={name}
        onValueChange={setName}
        required
      />
      <TextInput
        label={t.description}
        description={t.descriptionDescription}
        placeholder={starter().description}
        icon="ti ti-align-left"
        value={description}
        onValueChange={setDescription}
        multiline
        lines={3}
      />
      <ColorInput label={t.color} description={t.colorDescription} value={color} onValueChange={setColor} />
      <Show when={error()}>
        {(message) => (
          <InlineGuidance tone="danger" icon="ti ti-alert-circle" role="alert">
            {message()}
          </InlineGuidance>
        )}
      </Show>
      <div class="flex justify-end gap-2 pt-2">
        <Button type="button" variant="secondary" size="sm" onClick={() => props.close(null)} disabled={submitting()}>
          {t.cancel}
        </Button>
        <Button type="submit" size="sm" loading={submitting()}>
          {t.create}
        </Button>
      </div>
    </form>
  );
}

export function createSpaceCreation(t: ReturnType<typeof overviewMessages.resolve>["t"]) {
  const blankStarter = spaceStarters(t)[0]!;
  const createSpaceFromDraft = async (draft: SpaceDraft): Promise<Space> => {
    const response = await apiClient.index.$post({
      json: {
        name: draft.name,
        description: draft.description || undefined,
        color: draft.color,
        starter: draft.starter.id,
      },
    });
    if (!response.ok) throw new Error(await readResponseError(response, t.createFailed));
    return response.json();
  };
  return async (starter: SpaceStarter = blankStarter) => {
    const result = await prompts.dialog<CreatedSpace | null>(
      (close) => <CreateSpaceForm starter={starter} create={createSpaceFromDraft} close={close} />,
      { title: t.newSpace, icon: "ti ti-plus" },
    );
    // Opening the new space is the confirmation.
    if (!result) return;
    const { space, starter: selected } = result;
    setLastSpaceId(space.id);
    writeSpaceSettings(space.id, { view: starterView[selected.id] });
    navigateTo(`/app/spaces/${space.id}`);
  };
}
