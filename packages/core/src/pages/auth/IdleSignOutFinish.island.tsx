import { finishIdleSignOut } from "@k2b/cloud/browser/session";
import { Button, NoticeCard, useLocale } from "@k2b/ui";
import { createSignal, onMount, Show } from "solid-js";
import { authMessages } from "./messages";

/**
 * After a shared workstation signed out for lack of input: ends the session the page left and clears its data in this
 * browser. Says so when that did not fully work and offers to try again.
 */
export default function IdleSignOutFinish() {
  const locale = useLocale();
  const t = () => authMessages.resolve([locale()]).t;
  const [failed, setFailed] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const finish = async () => {
    setBusy(true);
    setFailed((await finishIdleSignOut()) === "failed");
    setBusy(false);
  };
  onMount(() => void finish());
  return (
    <Show when={failed()}>
      <NoticeCard
        tone="warning"
        layout="card"
        icon
        actions={
          <Button variant="warning" size="sm" type="button" disabled={busy()} onClick={() => void finish()}>
            {t().tryAgain}
          </Button>
        }
      >
        {t().idleCleanupFailed}
      </NoticeCard>
    </Show>
  );
}
