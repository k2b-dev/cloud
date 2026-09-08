import { navigateTo, refreshCurrentPath } from "@k2b/ssr/nav";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { Button, CodeDisplay, Dropdown, NoticeCard, prompts } from "@k2b/ui";
import { apiClient } from "@/api/client";
import { ErrorResponseSchema } from "@/contracts";
import { useAccountsMessages } from "../../messages";

type GroupActionsProps = {
  id: string;
  name: string;
  provider: "ipa" | "local";
  isPosix: boolean;
  description: string | null;
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
      const g = props.name;
      const providerLabel = props.provider === "ipa" ? "FreeIPA" : messages().local;

      if (!props.isPosix) {
        await prompts.alert(messages().groupDeletedFrom({ name: g, provider: providerLabel }), {
          title: messages().groupDeleted,
          icon: "ti ti-check",
        });
        navigateTo(props.listHref);
        return;
      }

      const deleteCmd = `sudo nfsctl groupdel ${g}`;

      prompts.dialog(
        (close) => (
          <div class="flex flex-col gap-4">
            <NoticeCard tone="success" icon={false}>
              {messages().groupDeletedFrom({ name: g, provider: providerLabel })}
            </NoticeCard>

            <div class="flex flex-col gap-1">
              <CodeDisplay title={messages().deleteOrArchiveFiles} code={deleteCmd} lineNumbers={false} />
            </div>

            <div class="flex justify-end">
              <Button
                size="sm"
                onClick={() => {
                  close();
                  navigateTo(props.listHref);
                }}
              >
                {messages().done}
              </Button>
            </div>
          </div>
        ),
        { title: messages().groupDeleted, icon: "ti ti-check" },
      );
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
    onSuccess: () => refreshCurrentPath(),
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

  const handleMakePosix = async () => {
    const confirmed = await prompts.confirm(messages().posixConfirm({ name: props.name }), {
      title: messages().makePosix,
      icon: "ti ti-transform",
      confirmText: messages().convert,
      cancelText: messages().cancel,
    });
    if (confirmed) {
      const res = await apiClient.groups[":id"].posix.$put({
        param: { id: props.id },
      });
      if (res.ok) refreshCurrentPath();
      else prompts.error(messages().posixFailed);
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
