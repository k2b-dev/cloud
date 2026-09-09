import { createMemo, createSignal, Show } from "solid-js";
import { Button, TextInput, SettingsModal, prompts, useLocale } from "@k2b/ui";
import { PermissionEditor } from "@valentinkolb/cloud/access/ui";
import type { AccessEntry } from "@valentinkolb/cloud/contracts";
import type { Bundle } from "../contracts";
import { LocalFiles } from "./LocalFiles";
import { messages } from "./messages";
import { client, checked, displayError } from "./client";

export function KitSettings(props: {
  userId: string;
  project: Bundle;
  access: AccessEntry[];
  close: () => void;
  onSaved: (project: Bundle) => void;
}) {
  const locale = useLocale(),
    t = () => messages.resolve([locale()]).t;
  const [base, setBase] = createSignal(props.project);
  const [name, setName] = createSignal(props.project.name),
    [description, setDescription] = createSignal(props.project.description);
  const [busy, setBusy] = createSignal(false),
    [error, setError] = createSignal("");
  const access = () => props.access;
  const dirty = createMemo(() => name() !== base().name || description() !== base().description);
  async function close() {
    if (!busy() && (!dirty() || (await prompts.confirm(t().discard, { title: t().discardTitle })))) props.close();
  }
  async function save() {
    setBusy(true);
    setError("");
    try {
      const result = await checked(
        await client.projects[":id"].$put({
          param: { id: base().id },
          json: {
            name: name(),
            description: description(),
            persistenceEnabled: base().persistenceEnabled,
            files: base().files,
            expectedRevision: base().revision,
          },
        }),
      );
      setBase(result);
      props.onSaved(result);
    } catch (e) {
      setError(displayError(e, locale()));
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!(await prompts.confirm(t().confirmDelete, { title: t().deleteApp, confirmText: t().deleteApp, variant: "danger" }))) return;
    setBusy(true);
    try {
      await checked(await client.projects[":id"].$delete({ param: { id: base().id } }));
      location.assign("/app/kit");
    } catch (e) {
      setError(displayError(e, locale()));
      setBusy(false);
    }
  }
  return (
    <SettingsModal class="kit-settings-modal" title={t().settings + " · " + base().name} onClose={() => void close()}>
      <Show when={base().permission === "admin"}>
        <SettingsModal.Group title={base().name}>
          <SettingsModal.Tab id="general" title={t().general} icon="ti ti-adjustments">
            <div class="kit-flow kit-flow-column kit-gap-md">
              <TextInput label={t().name} value={name()} onValueChange={setName} disabled={busy()} />
              <TextInput label={t().description} value={description()} onValueChange={setDescription} disabled={busy()} />
              <Show when={error()}>
                <p role="alert" class="kit-error">
                  {error()}
                </p>
              </Show>
            </div>
            <SettingsModal.Footer>
              <Button onClick={save} loading={busy()} disabled={!dirty()}>
                {t().save}
              </Button>
            </SettingsModal.Footer>
          </SettingsModal.Tab>
          <SettingsModal.Tab id="access" title={t().share} icon="ti ti-users" description={t().accessAdmin}>
            <PermissionEditor
              initialEntries={access()}
              canEdit
              allowPublic={false}
              allowServiceAccounts={false}
              allowedLevels={[
                { level: "read", label: t().accessRead },
                { level: "write", label: t().accessWrite },
                { level: "admin", label: t().accessAdmin },
              ]}
              grantAccess={async (principal, permission) => {
                if (principal.type === "public" || principal.type === "service_account") throw new Error(t().error);
                const r = await checked(
                  await client.projects[":id"].access.$post({
                    param: { id: props.project.id },
                    json: { principal, permission },
                  }),
                );
                if (!r) throw new Error(t().error);
                return r;
              }}
              updateAccess={async (accessId, permission) => {
                await checked(
                  await client.projects[":id"].access[":accessId"].$patch({
                    param: { id: props.project.id, accessId },
                    json: { permission },
                  }),
                );
              }}
              revokeAccess={async (accessId) => {
                await checked(
                  await client.projects[":id"].access[":accessId"].$delete({
                    param: { id: props.project.id, accessId },
                  }),
                );
              }}
            />
          </SettingsModal.Tab>
        </SettingsModal.Group>
      </Show>
      <SettingsModal.Group title={t().localData}>
        <SettingsModal.Tab id="local" title={t().localData} icon="ti ti-device-desktop">
          <LocalFiles appId={base().id} userId={props.userId} />
        </SettingsModal.Tab>
      </SettingsModal.Group>
      <Show when={base().permission === "admin"}>
        <SettingsModal.Group title={t().deleteApp}>
          <SettingsModal.Tab id="delete" title={t().deleteApp} icon="ti ti-trash" tone="danger">
            <Button variant="danger" onClick={remove} loading={busy()}>
              {t().deleteApp}
            </Button>
            <Show when={error()}>
              <p role="alert" class="kit-error">
                {error()}
              </p>
            </Show>
          </SettingsModal.Tab>
        </SettingsModal.Group>
      </Show>
    </SettingsModal>
  );
}
