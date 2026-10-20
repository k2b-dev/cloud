import { documentNavigate, refreshCurrentPath } from "@k2b/ssr/nav";
import { Dropdown, type DropdownItem, toast, useLocale } from "@k2b/ui";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { openBookSettingsDialog } from "./BookSettingsDialog";
import { openContactDuplicatesDialog } from "./ContactDuplicatesDialog";
import { connectContactsHead } from "./contacts-head-events";
import { resultsMessages } from "./results-messages";

export default function ContactsHeadActions(props: { bookId?: string; canWrite: boolean; canManage: boolean; initialHref: string }) {
  const locale = useLocale();
  const t = () => resultsMessages.resolve([locale()]).t;
  const [selection, setSelection] = createSignal(false);
  const [href, setHref] = createSignal(props.initialHref);
  const [busy, setBusy] = createSignal(false);
  let bridge: ReturnType<typeof connectContactsHead> | undefined;
  onMount(() => {
    bridge = connectContactsHead((state) => {
      setSelection(state.selectionMode);
      setHref(state.source);
    });
    onCleanup(bridge.dispose);
  });
  const run = async (action: () => Promise<void>) => {
    if (busy()) return;
    setBusy(true);
    try {
      await action();
    } catch (error) {
      // A toast keeps the head row still; the menu stays available for another try.
      toast.error(error instanceof Error ? error.message : t().couldNotUpdateContacts);
    } finally {
      setBusy(false);
    }
  };
  const items = (): DropdownItem[] => [
    ...(props.canManage
      ? [
          {
            label: t().bookSettings,
            icon: "ti ti-settings",
            action: () =>
              run(async () => {
                const result = await openBookSettingsDialog({ bookId: props.bookId! });
                if (result.deleted) documentNavigate("/app/contacts");
                else if (result.workspaceChanged) refreshCurrentPath();
              }),
          },
        ]
      : []),
    ...(props.canWrite
      ? [
          {
            label: t().duplicates,
            icon: "ti ti-users-group",
            action: () =>
              run(async () => {
                if (await openContactDuplicatesDialog(props.bookId!)) documentNavigate(href(), { replace: true });
              }),
          },
          {
            label: selection() ? t().stopSelecting : t().select,
            icon: "ti ti-list-check",
            action: () => {
              bridge?.toggleSelection();
            },
          },
        ]
      : []),
  ];
  return (
    <Show when={props.bookId && (props.canWrite || props.canManage)}>
      <div class="contacts-head-actions">
        <Dropdown items={items()} label={t().bookActions} disabled={busy()}>
          <Dropdown.Trigger iconOnly variant="ghost" label={t().bookActions}>
            <i class="ti ti-dots" aria-hidden="true" />
          </Dropdown.Trigger>
        </Dropdown>
      </div>
    </Show>
  );
}
