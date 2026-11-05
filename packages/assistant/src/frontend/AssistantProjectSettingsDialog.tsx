import { type GrantableLevel, openAccessDialog, PermissionEditor } from "@k2b/cloud/access/ui";
import type { AiProject, AiProjectAccess } from "@k2b/cloud/ai";
import { AiModelField } from "@k2b/cloud/ai/ui";
import { coreClient } from "@k2b/cloud/clients/core";
import { AuthenticatedPrincipalSchema, type Principal } from "@k2b/cloud/contracts";
import type { AiModelRequest, AiPeopleModels } from "@k2b/cloud/shared";
import { query } from "@k2b/stdlib/solid";
import {
  Button,
  confirmDiscardIfDirty,
  NoticeCard,
  Placeholder,
  prompts,
  SettingsGroup,
  SettingsModal,
  SettingsPanelFooter,
  TextInput,
  toast,
} from "@k2b/ui";
import { createMemo, createSignal, onCleanup, Show } from "solid-js";
import {
  type AssistantLiveHub,
  type AssistantLiveInvalidation,
  AssistantLiveProvider,
  matchesAssistantInvalidation,
  useAssistantLive,
} from "./assistant-live";
import { useAssistantText } from "./ui-copy";

const readError = async (response: Pick<Response, "json">, fallback: string) => {
  const body = (await response.json().catch(() => null)) as { message?: string } | null;
  return body?.message || fallback;
};

function ProjectSettings(props: { project: AiProject; close: () => void }) {
  const text = useAssistantText();
  const [name, setName] = createSignal(props.project.name);
  const [description, setDescription] = createSignal(props.project.description);
  const [instructions, setInstructions] = createSignal(props.project.instructions);
  // F8: scheduled tasks of this Project use this model; it is set where the Project is set up.
  const [defaultModel, setDefaultModel] = createSignal<AiModelRequest | null>(props.project.defaultModel ?? null);
  const models = query.create({
    source: () => props.project.id,
    load: async (_, { abortSignal }) => {
      const response = await coreClient.ai.models.$get({}, { init: { signal: abortSignal } });
      if (!response.ok) throw new Error(text("Models could not be loaded."));
      return (await response.json()) as AiPeopleModels;
    },
  });
  const [saving, setSaving] = createSignal(false);
  const [saveError, setSaveError] = createSignal<string | null>(null);
  const changeCount = createMemo(
    () =>
      Number(name().trim() !== props.project.name) +
      Number(description().trim() !== props.project.description) +
      Number(instructions().trim() !== props.project.instructions) +
      Number(JSON.stringify(defaultModel()) !== JSON.stringify(props.project.defaultModel ?? null)),
  );
  const access = query.create<string | null, AiProjectAccess[], AssistantLiveInvalidation>({
    source: () => (props.project.permission === "admin" ? props.project.id : null),
    load: async (projectId) => {
      if (!projectId) return [];
      const response = await coreClient.ai.projects[":projectId"].access.$get({ param: { projectId } });
      if (!response.ok) throw new Error(await readError(response, text("Failed to load Project access")));
      return (await response.json()).access;
    },
  });
  // Set by every saved access change, also when a later one fails and the person discards the rest.
  let wroteAccess = false;
  // A plain guard, not a disabled state: a disabled button could not take focus back when the dialog closes.
  let editingAccess = false;
  // The access dialog closes with these settings; nothing is sent after they are gone.
  const accessOwner = new AbortController();
  onCleanup(() => accessOwner.abort());
  const accessFailed = () => text("Could not update Project access");
  const grantAccess = async (principal: Principal, permission: GrantableLevel) => {
    const response = await coreClient.ai.projects[":projectId"].access.$post({
      param: { projectId: props.project.id },
      json: { principal: AuthenticatedPrincipalSchema.parse(principal), permission },
    });
    if (!response.ok) throw new Error(await readError(response, accessFailed()));
    wroteAccess = true;
    return (await response.json()).access;
  };
  const updateAccess = async (accessId: string, permission: GrantableLevel) => {
    const response = await coreClient.ai.projects[":projectId"].access[":accessId"].$patch({
      param: { projectId: props.project.id, accessId },
      json: { permission },
    });
    if (!response.ok) throw new Error(await readError(response, accessFailed()));
    wroteAccess = true;
  };
  const revokeAccess = async (accessId: string) => {
    const response = await coreClient.ai.projects[":projectId"].access[":accessId"].$delete({
      param: { projectId: props.project.id, accessId },
    });
    if (!response.ok) throw new Error(await readError(response, accessFailed()));
    wroteAccess = true;
  };
  // Changes are collected in the access dialog and saved together; the list reads the result once afterwards.
  const editAccess = async () => {
    // A list that missed a saved change, or is still being read again, is read first, so the dialog never starts
    // from an old list.
    if (access.error() || access.refreshing()) await access.refresh().catch(() => undefined);
    const entries = access.data();
    if (access.error() || !entries || accessOwner.signal.aborted) return;
    wroteAccess = false;
    await openAccessDialog({
      target: { type: "core.ai.project", id: props.project.id },
      resourceName: props.project.name,
      subtitle: text("Project · Assistant"),
      initialEntries: entries,
      allowPublic: false,
      signal: accessOwner.signal,
      grantAccess,
      updateAccess,
      revokeAccess,
    });
    // Awaited, so a second click waits for the saved list instead of opening the old one.
    if (wroteAccess && !accessOwner.signal.aborted) await access.refresh().catch(() => undefined);
  };
  const runEditAccess = () => {
    if (editingAccess) return;
    editingAccess = true;
    void editAccess().finally(() => {
      editingAccess = false;
    });
  };
  const live = useAssistantLive();
  const unregister = live.register({
    matches: matchesAssistantInvalidation(["project-detail"], { projectId: props.project.id }),
    invalidate: (invalidation) => access.invalidate(invalidation),
  });
  onCleanup(unregister);

  const discard = () => {
    setName(props.project.name);
    setDescription(props.project.description);
    setInstructions(props.project.instructions);
    setDefaultModel(props.project.defaultModel ?? null);
    setSaveError(null);
  };
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
        json: { name: name().trim(), description: description().trim(), instructions: instructions().trim(), defaultModel: defaultModel() },
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
            <SettingsGroup
              title={text("Project context")}
              description={text("Instructions are applied to new turns in every Project chat.")}
            >
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
              <AiModelField
                label={text("Default model")}
                description={text("Routines in this Project use it. Without a default, they use the person's choice, otherwise Balanced.")}
                noneLabel={text("No Project default")}
                state={
                  models.data() ? { status: "ready", models: models.data()! } : models.error() ? { status: "error" } : { status: "loading" }
                }
                onRetry={() => void models.refresh()}
                value={defaultModel()}
                onChange={setDefaultModel}
                disabled={saving() || props.project.permission === "read"}
              />
              <Show when={saveError()}>
                {(message) => <Placeholder state="error" align="left" title={text("Could not save Project")} description={message()} />}
              </Show>
            </SettingsGroup>
            <SettingsModal.Footer>
              <SettingsPanelFooter
                changeCount={changeCount}
                loading={saving}
                saveDisabled={() => !name().trim()}
                onDiscard={discard}
                onSave={() => void save()}
              />
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
              <SettingsGroup
                title={text("Project access")}
                description={text("Changes apply when you save them. At least one administrator must remain.")}
              >
                <SettingsGroup.Action>
                  <Button size="sm" variant="secondary" disabled={!access.data()} onClick={runEditAccess}>
                    <i class="ti ti-pencil" aria-hidden="true" />
                    {text("Edit access")}
                  </Button>
                </SettingsGroup.Action>
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
                    <PermissionEditor
                      initialEntries={entries()}
                      canEdit={false}
                      grantAccess={grantAccess}
                      updateAccess={updateAccess}
                      revokeAccess={revokeAccess}
                    />
                  )}
                </Show>
                <Show when={access.data() && access.error()}>
                  <NoticeCard tone="warning" title={text("Access could not be reloaded.")}>
                    <Button size="sm" variant="secondary" onClick={() => void access.refresh()}>
                      {text("Retry")}
                    </Button>
                  </NoticeCard>
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
