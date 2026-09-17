import { Dropdown, prompts, useLocale } from "@k2b/ui";
import { createSignal } from "solid-js";
import { artifactMessages } from "./messages";
import { advancedMessages } from "./advanced-messages";
import { runnerHref } from "./runner-contracts";

/** Keep personal app controls available without loading Studio management. */
export function RunnerActions(props: { id: string; userId: string; serverAccess: boolean }) {
  const locale = useLocale(), t = () => artifactMessages.resolve([locale()]).t, a = () => advancedMessages.resolve([locale()]).t;
  const [busy, setBusy] = createSignal(false);
  async function action(run: () => Promise<unknown>) {
    if (busy()) return;
    setBusy(true);
    try { await run(); }
    catch (error) { await prompts.error(error instanceof Error ? error.message : t().REQUEST_FAILED); }
    finally { setBusy(false); }
  }
  const items = () => [
    { label: t().copyAppLink, icon: "ti ti-link", action: () => action(() => navigator.clipboard.writeText(new URL(runnerHref(props.id), location.origin).href)) },
    ...(props.serverAccess ? [
      { label: t().fork, icon: "ti ti-copy", action: () => action(async () => {
        const { artifactClient } = await import("./client");
        const { navigateTo } = await import("@k2b/ssr/nav");
        const copy = await artifactClient.fork(props.id);
        navigateTo((await artifactClient.editChat(copy.id)).href);
      }) },
      { label: "Secrets", icon: "ti ti-key", action: () => action(async () => {
        const { openSecretsDialog } = await import("./SecretsDialog");
        await openSecretsDialog({ resourceId: props.id });
      }) },
    ] : []),
    { label: a().local, icon: "ti ti-device-desktop", action: () => action(async () => {
      const { openDataDialog } = await import("./DataDialogs");
      await openDataDialog(props.id, props.serverAccess ? props.userId : "public-visitor", "local", a().local);
    }) },
  ];
  return <Dropdown.Root items={items()}><Dropdown.Trigger iconOnly variant="ghost" label={t().actions} disabled={busy()}><i class="ti ti-dots" aria-hidden="true" /></Dropdown.Trigger></Dropdown.Root>;
}
