import { query } from "@k2b/stdlib/solid";
import { Button, confirmDiscardIfDirty, Placeholder, prompts, SettingsGroup, SettingsModal, StatusBadge, TextInput, toast } from "@k2b/ui";
import type { AiProject, AiProjectAccess } from "@k2b/cloud/ai";
import { coreClient } from "@k2b/cloud/clients/core";
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import {
  type AssistantLiveHub,
  type AssistantLiveInvalidation,
  AssistantLiveProvider,
  matchesAssistantInvalidation,
  useAssistantLive,
} from "./assistant-live";
import { useAssistantText } from "./ui-copy";

const readError = async (response: Response, fallback: string) => {
  const body = (await response.json().catch(() => null)) as { message?: string } | null;
  return body?.message || fallback;
};

const permissionTone = (permission: AiProjectAccess["permission"]) =>
  permission === "admin" ? ("warning" as const) : permission === "write" ? ("ok" as const) : ("neutral" as const);

function ProjectSettings(props: { project: AiProject; close: () => void }) {
  const text = useAssistantText();
  const [name, setName] = createSignal(props.project.name);
  const [description, setDescription] = createSignal(props.project.description);
  const [instructions, setInstructions] = createSignal(props.project.instructions);
  const [saving, setSaving] = createSignal(false);
  const [saveError, setSaveError] = createSignal<string | null>(null);
  const changeCount = createMemo(
    () =>
      Number(name().trim() !== props.project.name) +
      Number(description().trim() !== props.project.description) +
      Number(instructions().trim() !== props.project.instructions),
  );
  const access = query.create<string | null, AiProjectAccess[], AssistantLiveInvalidation>({
    source: () => (props.project.permission === "admin" ? props.project.id : null),
    load: async (projectId) => {
      if (!projectId) return [];
      const response = await coreClient.ai.projects[":projectId"].access.$get({ param: { projectId } });
      if (!response.ok) throw new Error(await readError(response, text("Failed to load Project access")));
      return (await response.json()).access as AiProjectAccess[];
    },
  });
  const live = useAssistantLive();
  const unregister = live.register({
    matches: matchesAssistantInvalidation(["project-detail"], { projectId: props.project.id }),
    invalidate: (invalidation) => access.invalidate(invalidation),
  });
  onCleanup(unregister);

  const requestClose = async () => {
    if (!saving() && (await confirmDiscardIfDirty(() => changeCount() > 0))) props.close();
  };

  const save = async () => {
    if (!name().trim() || saving()) return;
    setSaving(true);
    setSaveError(null);
    try {
      const response = await coreClient.ai.projects[":projectId"].$patch({
        param: { projectId: props.project.id },
        json: { name: name().trim(), description: description().trim(), instructions: instructions().trim() },
      });
      if (!response.ok) throw new Error(await readError(response, text("Failed to save Project")));
      toast.success(text("Project saved"));
      props.close();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : text("Failed to save Project"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div class="dialog-fixed-frame flex min-h-0 flex-col overflow-hidden">
      <SettingsModal title={text("Project settings")} onClose={() => void requestClose()} closeLabel={text("Close Project settings")}>
        <SettingsModal.Group title={text("Project")}>
          <SettingsModal.Tab
            id="general"
            title={text("General")}
            icon="ti ti-id"
            description={text("Name, description, and instructions shared by this Project.")}
          >
            <SettingsGroup title={text("Project context")} description={text("Instructions are applied to new turns in every Project chat.")}>
              <TextInput
                label={text("Name")}
                value={name}
                onValueChange={setName}
                maxLength={120}
                required
                error={() => (!name().trim() ? text("Name is required.") : undefined)}
                disabled={saving()}
              />
              <TextInput
                label={text("Description")}
                multiline
                lines={2}
                value={description}
                onValueChange={setDescription}
                maxLength={500}
                disabled={saving()}
              />
              <TextInput
                label={text("Instructions")}
                description={text("Only Project instructions are treated as instructions; files, knowledge, and references remain data.")}
                multiline
                markdown
                lines={7}
                value={instructions}
                onValueChange={setInstructions}
                maxLength={16_000}
                disabled={saving()}
              />
              <Show when={saveError()}>
                {(message) => <Placeholder state="error" align="left" title={text("Could not save Project")} description={message()} />}
              </Show>
            </SettingsGroup>
            <SettingsModal.Footer>
              <div class="flex w-full items-center justify-between gap-3">
                <span class="text-xs text-dimmed">
                  {changeCount()} unsaved {changeCount() === 1 ? "change" : "changes"}
                </span>
                <div class="flex gap-2">
                  <Button size="sm" variant="secondary" onClick={() => void requestClose()} disabled={saving()}>
                    {text("Cancel")}
                  </Button>
                  <Button size="sm" onClick={() => void save()} loading={saving()} disabled={!name().trim() || changeCount() === 0}>
                    {text("Save changes")}
                  </Button>
                </div>
              </div>
            </SettingsModal.Footer>
          </SettingsModal.Tab>
        </SettingsModal.Group>

        <Show when={props.project.permission === "admin"}>
          <SettingsModal.Group title={text("Sharing")}>
            <SettingsModal.Tab
              id="access"
              title={text("Access")}
              icon="ti ti-shield"
              description={text("People and groups with direct access to this Project.")}
            >
              <SettingsGroup title={text("Project access")} description={text("Cloud resolves direct and nested group membership at request time.")}>
                <Show
                  when={access.data()}
                  fallback={
                    <Placeholder
                      state={access.error() ? "error" : "loading"}
                      title={text(access.error() ? "Could not load access" : "Loading access")}
                      description={access.error()?.message}
                      action={
                        access.error() ? (
                          <Button size="sm" variant="secondary" onClick={() => void access.refresh()}>
                            {text("Retry")}
                          </Button>
                        ) : undefined
                      }
                    />
                  }
                >
                  {(entries) => (
                    <Show when={entries().length > 0} fallback={<Placeholder title={text("No additional access")} />}>
                      <ul class="flex flex-col gap-3">
                        <For each={entries()}>
                          {(entry) => (
                            <li class="flex items-center justify-between gap-3 text-sm">
                              <span class="min-w-0 truncate text-primary">{entry.displayName || entry.principal.type}</span>
                              <StatusBadge label={entry.permission} tone={permissionTone(entry.permission)} variant="chip" />
                            </li>
                          )}
                        </For>
                      </ul>
                    </Show>
                  )}
                </Show>
              </SettingsGroup>
            </SettingsModal.Tab>
          </SettingsModal.Group>
        </Show>
      </SettingsModal>
    </div>
  );
}

export const openAssistantProjectSettingsDialog = (project: AiProject, live: AssistantLiveHub) =>
  prompts.dialog<void>(
    (close) => (
      <AssistantLiveProvider value={live}>
        <ProjectSettings project={project} close={() => close()} />
      </AssistantLiveProvider>
    ),
    {
      surface: "bare",
      header: false,
      size: "large",
    },
  );
