import { isPosixName } from "@k2b/cloud/contracts";
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
import { usePageSwap } from "@/frontend/lib/page-swap";
import { showAccountActionNotice } from "../action-notice";
import { useAccountsMessages } from "../messages";

type ProviderChoice = "ipa" | "local";
export const normalizeName = (value: string) =>
  value
    .toLowerCase()
    .replace(/[_ ]/g, "-")
    .replace(/[^a-z0-9-]/g, "");
type CreateGroupPayload = { provider: ProviderChoice; name: string; description?: string; posix?: boolean };
export type CreateGroupResult = { group: BaseGroup };

/**
 * The state and deeds of the form for a new group, shared by the v1 dialog (relations page) and the v2 dialog of the
 * group list: the same fields, the same name rules, the same request and the same question before an edited form closes.
 */
export const useCreateGroupForm = (props: {
  freeIpaEnabled: boolean;
  linuxEnabled: boolean;
  close: (result?: CreateGroupResult) => void;
}) => {
  const messages = useAccountsMessages();
  const formId = createUniqueId();
  const [provider, setProvider] = createSignal<ProviderChoice>(props.freeIpaEnabled ? "ipa" : "local");
  const [name, setName] = createSignal("");
  const [description, setDescription] = createSignal("");
  const [localPosix, setLocalPosix] = createSignal(false);
  const [ipaPosix, setIpaPosix] = createSignal(true);
  const posix = () => (provider() === "ipa" ? ipaPosix() : props.linuxEnabled && localPosix());
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
    if (provider() === "local" && posix() && !isPosixName(normalized)) {
      setError(messages().localPosixNameInvalid);
      return;
    }
    void createMutation.mutate({
      provider: provider(),
      name: normalized,
      description: description().trim() || undefined,
      posix: posix(),
    });
  };
  const choosePosix = (value: boolean) => {
    if (provider() === "local") setLocalPosix(value);
    else setIpaPosix(value);
    setError(undefined);
    setDirty(true);
  };
  return {
    messages,
    formId,
    provider,
    setProvider,
    name,
    setName,
    description,
    setDescription,
    posix,
    choosePosix,
    setDirty,
    closing,
    error,
    setError,
    createMutation,
    requestClose,
    submit,
  };
};

export function CreateGroupDialog(props: { freeIpaEnabled: boolean; linuxEnabled: boolean; close: (result?: CreateGroupResult) => void }) {
  const {
    messages,
    formId,
    provider,
    setProvider,
    name,
    setName,
    description,
    setDescription,
    posix,
    choosePosix,
    setDirty,
    closing,
    error,
    setError,
    createMutation,
    requestClose,
    submit,
  } = useCreateGroupForm(props);
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
          <Checkbox
            label={messages().createPosixGroup}
            description={
              provider() === "local" && !props.linuxEnabled ? messages().localPosixUnavailable : messages().posixGroupDescription
            }
            value={posix}
            onValueChange={choosePosix}
            disabled={createMutation.loading() || (provider() === "local" && !props.linuxEnabled)}
          />
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

/** Once a group is created: says so, shows the notice for its follow-up deeds, and shows the page again. */
export const useGroupCreated = () => {
  const { showChanges } = usePageSwap();
  const messages = useAccountsMessages();
  return async (result: CreateGroupResult) => {
    toast.success(messages().groupCreatedMessage({ name: result.group.name }));
    await showAccountActionNotice(
      { action: "group.create", id: result.group.id, name: result.group.name, provider: result.group.provider },
      messages(),
    );
    showChanges();
  };
};

/** Opens the v1 dialog for a new group (the relations page) and, once created, shows the result. Call it in an island. */
export const useNewGroup = (props: { freeIpaEnabled?: boolean; linuxEnabled: boolean }) => {
  const showResult = useGroupCreated();
  const [opening, setOpening] = createSignal(false);
  const open = async () => {
    if (opening()) return;
    setOpening(true);
    try {
      const result = await dialogCore.open<CreateGroupResult>(
        (close) => <CreateGroupDialog freeIpaEnabled={props.freeIpaEnabled ?? true} linuxEnabled={props.linuxEnabled} close={close} />,
        { ...panelDialogOptions, cancelBehavior: "ignore", initialFocus: (dialog) => dialog.querySelector("input") },
      );
      if (result) await showResult(result);
    } finally {
      setOpening(false);
    }
  };
  return { open, opening };
};
