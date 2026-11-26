import { isPosixName } from "@k2b/cloud/contracts";
import { mutation } from "@k2b/stdlib/solid";
import { Dialog, useToast } from "@k2b/ui/v2";
import { createSignal, onCleanup } from "solid-js";
import { apiClient } from "@/api/client";
import { type BaseGroup, BaseGroupSchema, ErrorResponseSchema } from "@/contracts";
import { usePageSwap } from "@/frontend/lib/page-swap";
import { showAccountActionNotice } from "../action-notice";
import { useAccountsMessages } from "../messages";
import { useGroupDetailMessages } from "./detail/messages";

type ProviderChoice = "ipa" | "local";
export const normalizeName = (value: string) =>
  value
    .toLowerCase()
    .replace(/[_ ]/g, "-")
    .replace(/[^a-z0-9-]/g, "");
type CreateGroupPayload = { provider: ProviderChoice; name: string; description?: string; posix?: boolean };
export type CreateGroupResult = { group: BaseGroup };

/**
 * The state and deeds of the form for a new group (`NewGroupDialog`, on the group list and the relations page): the
 * fields, the name rules, the request, and the question before an edited form closes.
 */
export const useCreateGroupForm = (props: {
  freeIpaEnabled: boolean;
  linuxEnabled: boolean;
  close: (result?: CreateGroupResult) => void;
}) => {
  const messages = useAccountsMessages();
  const words = useGroupDetailMessages();
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
      const discard =
        !dirty() ||
        (await Dialog.confirm({
          title: words().discardTitle,
          description: words().discardText,
          confirm: words().discard,
          cancel: messages().cancel,
        }));
      if (discard) props.close();
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

/** Once a group is created: shows the page again, says so, and shows the notice for its follow-up deeds. */
export const useGroupCreated = () => {
  const { showChanges } = usePageSwap();
  const messages = useAccountsMessages();
  const toast = useToast();
  return async (result: CreateGroupResult) => {
    await showAccountActionNotice(
      { action: "group.create", id: result.group.id, name: result.group.name, provider: result.group.provider },
      messages(),
    );
    await showChanges();
    toast(messages().groupCreatedMessage({ name: result.group.name }), { status: "ok" });
  };
};
