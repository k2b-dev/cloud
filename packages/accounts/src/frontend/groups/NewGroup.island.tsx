import { refreshCurrentPath } from "@k2b/ssr/nav";
import { mutation } from "@k2b/stdlib/solid";
import {
  Button,
  Checkbox,
  confirmDiscardIfDirty,
  dialogCore,
  NoticeCard,
  PanelDialog,
  panelDialogOptions,
  Select,
  TextInput,
  toast,
} from "@k2b/ui";
import { createSignal, createUniqueId, onCleanup, Show } from "solid-js";
import { apiClient } from "@/api/client";
import { type BaseGroup, BaseGroupSchema, ErrorResponseSchema } from "@/contracts";
import { showAccountActionNotice } from "../action-notice";
import { useAccountsMessages } from "../messages";

type ProviderChoice = "ipa" | "local";
const normalizeName = (value: string) =>
  value
    .toLowerCase()
    .replace(/[_ ]/g, "-")
    .replace(/[^a-z0-9-]/g, "");
type CreateGroupPayload = { provider: ProviderChoice; name: string; description?: string; posix?: boolean };
type CreateGroupResult = { group: BaseGroup };

export function CreateGroupDialog(props: { freeIpaEnabled: boolean; close: (result?: CreateGroupResult) => void }) {
  const messages = useAccountsMessages();
  const formId = createUniqueId();
  const [provider, setProvider] = createSignal<ProviderChoice>(props.freeIpaEnabled ? "ipa" : "local");
  const [name, setName] = createSignal("");
  const [description, setDescription] = createSignal("");
  const [posix, setPosix] = createSignal(true);
  const [dirty, setDirty] = createSignal(false);
  const [closing, setClosing] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const createMutation = mutation.create<CreateGroupResult, CreateGroupPayload>({
    mutation: async (payload, { abortSignal }) => {
      const res = await apiClient.groups.$post({ json: payload }, { init: { signal: abortSignal } });
      if (!res.ok) {
        const data = ErrorResponseSchema.safeParse(await res.json());
        throw new Error(data.success ? data.data.message : messages().createGroupFailed);
      }
      const group = BaseGroupSchema.parse(await res.json());
      return { group };
    },
    onSuccess: (result) => props.close(result),
  });
  onCleanup(() => createMutation.abort());
  const requestClose = async () => {
    if (createMutation.loading() || closing()) return;
    setClosing(true);
    try {
      if (await confirmDiscardIfDirty(dirty)) props.close();
    } finally {
      setClosing(false);
    }
  };
  const submit = () => {
    if (createMutation.loading()) return;
    const normalized = normalizeName(name());
    if (!normalized) {
      setError(messages().groupNameInvalid);
      return;
    }
    void createMutation.mutate({
      provider: provider(),
      name: normalized,
      description: description().trim() || undefined,
      posix: provider() === "ipa" ? posix() : undefined,
    });
  };
  return (
    <PanelDialog>
      <PanelDialog.Header
        title={messages().createGroup}
        close={() => void requestClose()}
        closeDisabled={createMutation.loading() || closing()}
      />
      <PanelDialog.Body>
        <form
          id={formId}
          class="flex flex-col gap-5"
          onInput={() => setDirty(true)}
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <Show when={props.freeIpaEnabled}>
            <Select
              label={messages().managedBy}
              value={provider}
              options={[
                { value: "ipa", label: "FreeIPA" },
                { value: "local", label: messages().local },
              ]}
              onValueChange={(value) => {
                if (value === "ipa" || value === "local") {
                  setProvider(value);
                  setDirty(true);
                }
              }}
              description={provider() === "ipa" ? messages().freeIpaGroupDescription : messages().localGroupDescription}
              disabled={createMutation.loading()}
            />
          </Show>
          <TextInput
            label={messages().name}
            required
            maxLength={120}
            value={name}
            onValueChange={(value) => {
              setName(value);
              setError(undefined);
            }}
            error={error}
            placeholder="my-group"
            description={messages().normalizedGroupName}
            disabled={createMutation.loading()}
          />
          <Show when={name() && name() !== normalizeName(name())}>
            <p class="text-sm text-secondary">
              {messages().name}: <strong>{normalizeName(name()) || "—"}</strong>
            </p>
          </Show>
          <TextInput
            label={messages().description}
            maxLength={4000}
            value={description}
            onValueChange={setDescription}
            multiline
            disabled={createMutation.loading()}
          />
          <Show when={provider() === "ipa"}>
            <Checkbox
              label={messages().createPosixGroup}
              description={messages().posixGroupDescription}
              value={posix}
              onValueChange={(value) => {
                setPosix(value);
                setDirty(true);
              }}
              disabled={createMutation.loading()}
            />
          </Show>
          <Show when={createMutation.error()}>
            {(error) => (
              <NoticeCard tone="danger" role="alert">
                {error().message}
              </NoticeCard>
            )}
          </Show>
        </form>
      </PanelDialog.Body>
      <PanelDialog.Footer>
        <Button variant="secondary" onClick={() => void requestClose()} disabled={createMutation.loading() || closing()}>
          {messages().cancel}
        </Button>
        <Button type="submit" form={formId} loading={createMutation.loading()} loadingLabel={messages().creating}>
          {messages().createGroup}
        </Button>
      </PanelDialog.Footer>
    </PanelDialog>
  );
}

export default function NewGroup(props: { freeIpaEnabled?: boolean }) {
  const messages = useAccountsMessages();
  const [opening, setOpening] = createSignal(false);
  const showResult = async (result: CreateGroupResult) => {
    toast.success(messages().groupCreatedMessage({ name: result.group.name }));
    await showAccountActionNotice(
      { action: "group.create", id: result.group.id, name: result.group.name, provider: result.group.provider },
      messages(),
    );
    refreshCurrentPath();
  };
  const openCreate = async () => {
    if (opening()) return;
    setOpening(true);
    try {
      const result = await dialogCore.open<CreateGroupResult>(
        (close) => <CreateGroupDialog freeIpaEnabled={props.freeIpaEnabled ?? true} close={close} />,
        { ...panelDialogOptions, cancelBehavior: "ignore", initialFocus: (dialog) => dialog.querySelector("input") },
      );
      if (result) await showResult(result);
    } finally {
      setOpening(false);
    }
  };
  return (
    <Button size="sm" onClick={() => void openCreate()} disabled={opening()}>
      {messages().newGroup}
    </Button>
  );
}
