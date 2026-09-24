import { navigateTo, refreshCurrentPath } from "@k2b/ssr/nav";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { Dropdown, prompts, toast } from "@k2b/ui";
import { createSignal } from "solid-js";
import { apiClient } from "@/api/client";
import { ErrorResponseSchema } from "@/contracts";
import { showAccountActionNotice } from "../../action-notice";
import { useAccountsMessages } from "../../messages";

type GroupActionsProps = {
  id: string;
  name: string;
  provider: "ipa" | "local";
  isPosix: boolean;
  linuxEnabled: boolean;
  description: string | null;
  /** Owner of a personal Linux group; the server refuses to delete such a group. */
  personalOwnerName: string | null;
  listHref: string;
};

/** Per-group action dropdown menu. */
export default function GroupActions(props: GroupActionsProps) {
  const messages = useAccountsMessages();
  const deleteMutation = mutations.create<void, string>({
    mutation: async (id) => {
      const res = await apiClient.groups[":id"].$delete({ param: { id } });
      if (!res.ok) {
        const data = ErrorResponseSchema.safeParse(await res.json());
        throw new Error(data.success ? data.data.message : messages().deleteGroupFailed);
      }
    },
    onSuccess: async () => {
      toast.success(messages().groupDeletedFrom({ name: props.name, provider: props.provider === "ipa" ? "FreeIPA" : messages().local }));
      await showAccountActionNotice({ action: "group.delete", id: props.id, name: props.name, provider: props.provider }, messages());
      navigateTo(props.listHref);
    },
    onError: (err) => {
      prompts.error(err.message);
    },
  });

  const editMutation = mutations.create<void, { description: string }>({
    mutation: async (vars) => {
      const res = await apiClient.groups[":id"].$patch({
        param: { id: props.id },
        json: vars,
      });
      if (!res.ok) {
        const data = ErrorResponseSchema.safeParse(await res.json());
        throw new Error(data.success ? data.data.message : messages().updateGroupFailed);
      }
    },
    onSuccess: async () => {
      await showAccountActionNotice({ action: "group.update", id: props.id, name: props.name, provider: props.provider }, messages());
      refreshCurrentPath();
    },
    onError: (err) => prompts.error(err.message),
  });

  const handleEdit = async () => {
    const result = await prompts.form({
      title: messages().editGroup,
      icon: "ti ti-pencil",
      confirmText: messages().save,
      fields: {
        description: {
          type: "text" as const,
          label: messages().description,
          placeholder: messages().groupDescriptionPlaceholder,
          multiline: true,
          default: props.description ?? "",
        },
      },
    });
    if (result) {
      await editMutation.mutate({ description: result.description ?? "" });
    }
  };

  const posixMutation = mutations.create<void, void>({
    mutation: async () => {
      const res = await apiClient.groups[":id"].posix.$put({ param: { id: props.id } });
      if (!res.ok) {
        const data = ErrorResponseSchema.safeParse(await res.json());
        throw new Error(data.success ? data.data.message : messages().posixFailed);
      }
    },
    onSuccess: async () => {
      await showAccountActionNotice({ action: "group.posix", id: props.id, name: props.name, provider: props.provider }, messages());
      refreshCurrentPath();
    },
    onError: (error) => prompts.error(error.message),
  });
  const [confirmingPosix, setConfirmingPosix] = createSignal(false);
  const handleMakePosix = async () => {
    if (confirmingPosix() || posixMutation.loading() || (props.provider === "local" && !props.linuxEnabled)) return;
    setConfirmingPosix(true);
    try {
      const confirmed = await prompts.confirm(messages().posixConfirm({ name: props.name }), {
        title: messages().makePosix,
        icon: "ti ti-transform",
        confirmText: messages().convert,
        cancelText: messages().cancel,
      });
      if (confirmed) await posixMutation.mutate();
    } finally {
      setConfirmingPosix(false);
    }
  };

  const handleDelete = async () => {
    const confirmed = await prompts.confirm(messages().deleteGroupExplanation({ freeIpa: props.provider === "ipa" }), {
      title: messages().deleteGroupQuestion({ name: props.name }),
      icon: "ti ti-trash",
      confirmText: messages().delete,
      cancelText: messages().cancel,
      variant: "danger",
    });

    if (confirmed) {
      await deleteMutation.mutate(props.id);
    }
  };

  return (
    <Dropdown.Root
      disabled={confirmingPosix() || posixMutation.loading()}
      position="bottom-left"
      width="12rem"
      items={[
        {
          items: [
            ...(!props.isPosix
              ? [
                  {
                    icon: "ti ti-transform",
                    label: messages().makePosix,
                    disabled: props.provider === "local" && !props.linuxEnabled,
                    description: props.provider === "local" && !props.linuxEnabled ? messages().localPosixUnavailable : undefined,
                    action: handleMakePosix,
                  },
                ]
              : []),
            {
              icon: "ti ti-pencil",
              label: messages().edit,
              action: handleEdit,
            },
            {
              icon: "ti ti-trash",
              label: messages().delete,
              action: handleDelete,
              variant: "danger" as const,
              disabled: props.personalOwnerName !== null,
              description:
                props.personalOwnerName !== null ? messages().personalGroupDeleteBlocked({ name: props.personalOwnerName }) : undefined,
            },
          ],
        },
      ]}
    >
      <Dropdown.Trigger iconOnly size="sm" label={messages().groupActions} tooltip={messages().manageGroup}>
        <i class="ti ti-dots-vertical text-sm" />
      </Dropdown.Trigger>
    </Dropdown.Root>
  );
}
