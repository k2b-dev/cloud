import { Button, useLocale } from "@k2b/ui";
import { createSignal, onMount } from "solid-js";
import { keyCreationSupport, openCreateKeyDialog } from "./keys-dialogs";
import { keysMessages } from "./keys-messages";
import { keysState } from "./keys-state";

/**
 * "Create key" in the head of the keys column, off at two active keys. It is the page's filled action only before an
 * app's first start; otherwise the app page's notice carries the one filled action. A notice's way out arrives with
 * `?create=1` and opens the dialog once. The button waits for the browser check, so the two ways never stack dialogs.
 */
export default function KeysCreate(props: {
  app: { id: string; name: string };
  active: number;
  disabledAccount: boolean;
  neverStarted: boolean;
}) {
  const locale = useLocale();
  const t = () => keysMessages.resolve([locale()]).t;
  const [ready, setReady] = createSignal(false);
  let open = false;
  const active = () => keysState.activeCount() ?? props.active;
  const blocked = () =>
    !ready() ||
    active() >= 2 ||
    keysState.support() === "insecure" ||
    keysState.support() === "no-ed25519" ||
    (keysState.disabledAccount() ?? props.disabledAccount);
  const create = async () => {
    if (open || blocked()) return;
    open = true;
    try {
      await openCreateKeyDialog(props.app, locale(), () => keysState.setRevision((value) => value + 1));
    } finally {
      open = false;
    }
  };
  onMount(async () => {
    keysState.setSupport(await keyCreationSupport());
    setReady(true);
    const url = new URL(window.location.href);
    if (url.searchParams.get("create") !== "1") return;
    url.searchParams.delete("create");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    void create();
  });
  return (
    <Button size="sm" variant={props.neverStarted ? "primary" : "secondary"} disabled={blocked()} onClick={() => void create()}>
      <i class="ti ti-plus" aria-hidden="true" />
      {t().create}
    </Button>
  );
}
