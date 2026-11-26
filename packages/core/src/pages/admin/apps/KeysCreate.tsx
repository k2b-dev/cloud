import { useLocale } from "@k2b/ui";
import { Button } from "@k2b/ui/v2";
import { createSignal, onMount, Show } from "solid-js";
import { type CreatedKey, CreateKeyDialog, keyCreationSupport, OnceDialog } from "./keys-dialogs";
import { keysMessages } from "./keys-messages";
import { keysState } from "./keys-state";

/**
 * "Create key" in the head of the open app's keys, off at two active keys. It is the page's filled action only before
 * an app's first start; otherwise the app page's notice carries the one filled action. A notice's way out arrives with
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
  const [creating, setCreating] = createSignal(false);
  const [created, setCreated] = createSignal<CreatedKey | null>(null);
  const active = () => keysState.activeCount() ?? props.active;
  const blocked = () =>
    !ready() ||
    active() >= 2 ||
    keysState.support() === "insecure" ||
    keysState.support() === "no-ed25519" ||
    (keysState.disabledAccount() ?? props.disabledAccount);
  const create = () => {
    if (creating() || created() || blocked()) return;
    setCreating(true);
  };
  onMount(async () => {
    keysState.setSupport(await keyCreationSupport());
    setReady(true);
    const url = new URL(window.location.href);
    if (url.searchParams.get("create") !== "1") return;
    url.searchParams.delete("create");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    create();
  });
  return (
    <>
      <Button variant={props.neverStarted ? "primary" : "secondary"} icon="plus" disabled={blocked()} onClick={create}>
        {t().create}
      </Button>
      {/* a new dialog for every creation, so its pair, name and problem start fresh */}
      <Show when={creating()}>
        <CreateKeyDialog
          app={props.app}
          t={t()}
          locale={locale()}
          open
          onClose={() => setCreating(false)}
          onCreated={(key) => {
            setCreating(false);
            keysState.setRevision((value) => value + 1);
            setCreated(key);
          }}
        />
      </Show>
      <OnceDialog app={props.app} t={t()} created={created()} onClose={() => setCreated(null)} />
    </>
  );
}
