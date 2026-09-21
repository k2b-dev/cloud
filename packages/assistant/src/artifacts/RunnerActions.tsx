import { navigateTo } from "@k2b/ssr/nav";
import { Button, Dropdown, prompts, useLocale } from "@k2b/ui";
import { createSignal, Show } from "solid-js";
import { advancedMessages } from "./advanced-messages";
import { artifactMessages } from "./messages";
import { runnerHref } from "./runner-contracts";

/** Keep personal app controls available without loading Studio management. */
export function RunnerActions(props: { id: string; userId: string; serverAccess: boolean; canManage?: boolean }) {
  const locale = useLocale(),
    t = () => artifactMessages.resolve([locale()]).t,
    a = () => advancedMessages.resolve([locale()]).t;
  const [busy, setBusy] = createSignal(false);
  async function action(run: () => Promise<unknown>) {
    if (busy()) return;
    setBusy(true);
    try {
      await run();
    } catch (error) {
      await prompts.error(error instanceof Error ? error.message : t().REQUEST_FAILED);
    } finally {
      setBusy(false);
    }
  }
  const items = () => [
    {
      label: t().copyAppLink,
      icon: "ti ti-link",
      action: () => action(() => navigator.clipboard.writeText(new URL(runnerHref(props.id), location.origin).href)),
    },
    ...(props.serverAccess
      ? [
          {
            label: t().fork,
            icon: "ti ti-copy",
            action: () =>
              action(async () => {
                if (!(await prompts.confirm(t().forkConfirm, { title: t().fork, confirmText: t().fork }))) return;
                const { artifactClient } = await import("./client");
                const copy = await artifactClient.fork(props.id);
                navigateTo((await artifactClient.editChat(copy.id, true)).href);
              }),
          },
        ]
      : []),
    {
      label: a().local,
      icon: "ti ti-device-desktop",
      action: () =>
        action(async () => {
          const { openDataDialog } = await import("./DataDialogs");
          await openDataDialog(props.id, props.serverAccess ? props.userId : "public-visitor", "local", a().local);
        }),
    },
  ];
  return (
    <>
      <Show when={props.canManage}>
        <Button size="sm" variant="ghost" disabled={busy()} onClick={() => navigateTo(`/app/assistant/apps/${props.id}`)}>
          <i class="ti ti-settings" aria-hidden="true" />
          {t().manage}
        </Button>
      </Show>
      <Dropdown.Root items={items()} position="top-right">
        <Dropdown.Trigger size="sm" iconOnly variant="ghost" label={t().actions} disabled={busy()}>
          <i class="ti ti-dots" aria-hidden="true" />
        </Dropdown.Trigger>
      </Dropdown.Root>
    </>
  );
}
