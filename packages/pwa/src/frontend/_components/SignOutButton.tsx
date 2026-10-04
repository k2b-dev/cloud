import { PWA_SCOPE } from "@k2b/cloud/contracts";
import { Button, prompts, toast, useLocale } from "@k2b/ui";
import { createSignal } from "solid-js";
import { shellMessages } from "../../messages";
import { phoneAuth } from "../phone";

/** Signs this phone out of the app after a confirmation; Back answers the confirmation like Cancel. */
export default function SignOutButton(props: { cloud: string }) {
  const locale = useLocale();
  const t = () => shellMessages.resolve([locale()]).t;
  const [busy, setBusy] = createSignal(false);
  const signOut = async () => {
    const confirmed = await prompts.confirm(t().signOutConfirm({ cloud: props.cloud }), {
      title: t().signOut,
      confirmText: t().signOut,
      variant: "danger",
      history: true,
    });
    if (!confirmed) return;
    setBusy(true);
    const answer = await phoneAuth.signOut();
    if (answer.status === 204) return location.replace(PWA_SCOPE);
    setBusy(false);
    toast.error(answer.status === 0 ? t().offline : t().failed);
  };
  return (
    <Button variant="secondary" loading={busy()} onClick={() => void signOut()}>
      <i class="ti ti-logout" aria-hidden="true" />
      {t().signOut}
    </Button>
  );
}
