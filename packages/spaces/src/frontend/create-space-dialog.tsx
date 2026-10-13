import { navigateTo } from "@k2b/ssr/nav";
import { Button, ColorInput, InlineGuidance, NoticeCard, prompts, TextInput, useLocale } from "@k2b/ui";
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
type SpaceDraft = { name: string; description: string; color: string };
const starterView: Record<SpaceStarter["id"], ViewType> = { blank: "list", tasks: "kanban", calendar: "calendar", project: "table" };
/** Creates the Space from the dialog, which stays open until the server answers; a refusal shows here with the input. */
function CreateSpaceForm(props: {
  starter: SpaceStarter;
  create: (draft: SpaceDraft) => Promise<Space>;
  close: (value: Space | null) => void;
}) {
  const locale = useLocale();
  const { t } = overviewMessages.resolve([locale()]);
  const [name, setName] = createSignal(props.starter.id === "blank" ? "" : props.starter.name);
  const [description, setDescription] = createSignal(props.starter.id === "blank" ? "" : props.starter.description);
  const [color, setColor] = createSignal(props.starter.color);
  const [submitting, setSubmitting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const submit = async () => {
    if (!name().trim() || submitting()) return;
    setSubmitting(true);
    setError(null);
    try {
      props.close(await props.create({ name: name().trim(), description: description().trim(), color: color() }));
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
      <NoticeCard tone="info">{t.adminNotice}</NoticeCard>
      <TextInput
        label={t.name}
        description={t.nameDescription}
        placeholder={props.starter.name}
        icon="ti ti-typography"
        value={name}
        onValueChange={setName}
        required
      />
      <TextInput
        label={t.description}
        description={t.descriptionDescription}
        placeholder={props.starter.description}
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
  const blankStarter: SpaceStarter = {
    id: "blank",
    name: t.blankSpace,
    description: t.blankSpaceDescription,
    icon: "ti ti-plus",
    color: "#3b82f6",
  };
  const createSpaceFromDraft = async (starter: SpaceStarter, draft: SpaceDraft): Promise<Space> => {
    const response = await apiClient.index.$post({
      json: {
        name: draft.name,
        description: draft.description || undefined,
        color: draft.color,
        starter: starter.id,
      },
    });
    if (!response.ok) throw new Error(await readResponseError(response, t.createFailed));
    return response.json();
  };
  return async (starter: SpaceStarter = blankStarter) => {
    const space = await prompts.dialog<Space | null>(
      (close) => <CreateSpaceForm starter={starter} create={(draft) => createSpaceFromDraft(starter, draft)} close={close} />,
      { title: starter.id === "blank" ? t.newSpace : starter.name, icon: starter.icon },
    );
    // Opening the new space is the confirmation.
    if (!space) return;
    setLastSpaceId(space.id);
    writeSpaceSettings(space.id, { view: starterView[starter.id] });
    navigateTo(`/app/spaces/${space.id}`);
  };
}
