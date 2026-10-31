import { Button, useLocale } from "@k2b/ui";
import { onMount } from "solid-js";
import { keyCreationSupport, openCreateKeyDialog } from "./keys-dialogs";
import { keysMessages } from "./keys-messages";
import { keysState } from "./keys-state";

/** "Create key" in the head of the keys column. Filled when the app has no active key, off at two active keys. */
export default function KeysCreate(props: { app: { id: string; name: string }; active: number; disabledAccount: boolean }) {
  const locale = useLocale();
  const t = () => keysMessages.resolve([locale()]).t;
  onMount(() => void keyCreationSupport().then(keysState.setSupport));
  const active = () => keysState.activeCount() ?? props.active;
  const blocked = () =>
    active() >= 2 ||
    keysState.support() === "insecure" ||
    keysState.support() === "no-ed25519" ||
    (keysState.disabledAccount() ?? props.disabledAccount);
  return (
    <Button
      size="sm"
      variant={active() === 0 ? "primary" : "secondary"}
      disabled={blocked()}
      onClick={() => void openCreateKeyDialog(props.app, locale(), () => keysState.setRevision((value) => value + 1))}
    >
      <i class="ti ti-plus" aria-hidden="true" />
      {t().create}
    </Button>
  );
}
