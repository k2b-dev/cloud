import { mutation } from "@k2b/stdlib/solid";
import { prompts, toast } from "@k2b/ui";
import { createSignal } from "solid-js";
import { apiClient } from "@/api/client";
import type { User } from "@/contracts";
import { showAccountActionNotice } from "../action-notice";
import { type AccountsMessages, useAccountsMessages } from "../messages";

export type DeleteTarget = Pick<User, "id" | "uid" | "mail" | "givenname" | "sn" | "displayName" | "provider" | "profile">;

/** Deletes the account and shows the follow-up notice; throws an Error with the server's message or the fallback. */
export const deleteUserRequest = async (user: DeleteTarget, t: AccountsMessages, signal?: AbortSignal) => {
  const res = await apiClient.users[":id"].$delete({ param: { id: user.id } }, { init: { signal } });
  if (!res.ok) {
    // Only a JSON body carries a message; anything else (proxy or framework error page) gets the localized fallback.
    const body = res.headers.get("content-type")?.includes("application/json") ? await res.json().catch(() => null) : null;
    throw new Error(body?.message ?? t.deleteUserFailed);
  }
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
    t,
  );
};

/** The v1 deletion with a confirmation and a toast, for the duplicate email list. */
export function createDeleteUserAction(props: { user: DeleteTarget; onDeleted: () => void }) {
  const messages = useAccountsMessages();
  const [confirming, setConfirming] = createSignal(false);
  const destroy = mutation.create<void, void>({
    mutation: (_, { abortSignal }) => deleteUserRequest(props.user, messages(), abortSignal),
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
          <p class="font-medium break-words">{[props.user.displayName || props.user.uid, props.user.mail].filter(Boolean).join(" · ")}</p>
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
