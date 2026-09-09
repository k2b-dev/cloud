import { mutation } from "@k2b/stdlib/solid";
import { prompts, toast } from "@k2b/ui";
import { createSignal } from "solid-js";
import { apiClient } from "@/api/client";
import type { User } from "@/contracts";
import { showAccountActionNotice } from "../action-notice";
import { useAccountsMessages } from "../messages";

type DeleteTarget = Pick<User, "id" | "uid" | "mail" | "givenname" | "sn" | "displayName" | "provider" | "profile">;

export function createDeleteUserAction(props: { user: DeleteTarget; onDeleted: () => void }) {
  const messages = useAccountsMessages();
  const [confirming, setConfirming] = createSignal(false);
  const destroy = mutation.create<void, void>({
    mutation: async (_, { abortSignal }) => {
      const res = await apiClient.users[":id"].$delete({ param: { id: props.user.id } }, { init: { signal: abortSignal } });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message ?? messages().deleteUserFailed);
      const user = props.user;
      await showAccountActionNotice(
        {
          action: "user.delete",
          id: user.id,
          uid: user.uid,
          name: user.uid,
          email: user.mail ?? "",
          firstName: user.givenname,
          lastName: user.sn,
          provider: user.provider,
          profile: user.profile,
          category: user.provider === "ipa" ? "freeipa" : user.profile === "guest" ? "guest" : "login",
        },
        messages(),
      );
    },
    onSuccess: () => {
      toast.success(messages().userDeleted);
      props.onDeleted();
    },
    onError: (error) => prompts.error(error.message),
  });
  const loading = () => confirming() || destroy.loading();
  const run = async () => {
    if (loading()) return;
    setConfirming(true);
    try {
      const confirmed = await prompts.confirm(
        <div class="flex flex-col gap-2">
          <p class="font-medium break-words">
            {props.user.displayName || props.user.uid} · {props.user.mail}
          </p>
          <p>{messages().deleteUserExplanation({ freeIpa: props.user.provider === "ipa" })}</p>
          <p class="text-sm text-dimmed">{messages().deleteUserNoTransfer}</p>
        </div>,
        {
          title: messages().deleteUserQuestion({ uid: props.user.uid }),
          icon: "ti ti-trash",
          confirmText: messages().delete,
          cancelText: messages().cancel,
          variant: "danger",
        },
      );
      if (confirmed) await destroy.mutate();
    } finally {
      setConfirming(false);
    }
  };
  return { run, loading };
}
