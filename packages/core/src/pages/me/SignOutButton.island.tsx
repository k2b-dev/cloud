import { Button, toast, useLocale } from "@k2b/ui";
import { createSignal } from "solid-js";
import { signOutCurrentSession } from "./account-session";
import { accountMessages } from "./messages";

export default function SignOutButton() {
  const locale = useLocale();
  const t = () => accountMessages.resolve([locale()]).t;
  const [signingOut, setSigningOut] = createSignal(false);

  const signOut = async () => {
    if (signingOut()) return;
    setSigningOut(true);
    try {
      await signOutCurrentSession(t().signOutFailed);
    } catch (error) {
      setSigningOut(false);
      toast.error(error instanceof Error ? error.message : t().signOutFailed);
    }
  };

  return (
    <Button type="button" variant="secondary" size="sm" loading={signingOut()} loadingLabel={t().signingOut} onClick={() => void signOut()}>
      <i class="ti ti-logout" />
      {t().signOut}
    </Button>
  );
}
