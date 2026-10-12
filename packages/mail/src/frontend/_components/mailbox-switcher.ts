import { importOnDemand } from "@k2b/cloud/browser/reload";
import { type AppWorkspaceSidebarSwitcherProps, type AppWorkspaceSwitcherOption, useLocale } from "@k2b/ui";
import { type Accessor, createSignal, getOwner, runWithOwner } from "solid-js";
import { apiClient } from "../../api/client";
import { mailOverviewMessages } from "../mail-overview-messages";
import type { MailboxCreationContext } from "./create-mailbox-dialog";
import { mailSidebarMessages } from "./mail-sidebar-messages";

/** The mailbox's sidebar switcher for the sidebar and the phone menu; the other mailboxes load when it is first reached. */
export function createMailboxSwitcher(
  mailbox: Accessor<{ id: string; name: string; address?: string }>,
  canCreate: boolean,
  context: MailboxCreationContext,
): Accessor<AppWorkspaceSidebarSwitcherProps> {
  const locale = useLocale();
  const t = () => mailSidebarMessages.resolve([locale()]).t;
  const [options, setOptions] = createSignal<AppWorkspaceSwitcherOption[]>();
  const [failed, setFailed] = createSignal(false);
  let requested = false;
  const [creating, setCreating] = createSignal(false);
  const owner = getOwner();
  let creation: ReturnType<typeof import("./create-mailbox-dialog").createMailboxCreation> | undefined;
  const create = async () => {
    if (!canCreate || creating()) return;
    setCreating(true);
    try {
      const dialog = await importOnDemand(() => import("./create-mailbox-dialog"));
      if (!dialog) return;
      creation ??= runWithOwner(owner, () => dialog.createMailboxCreation(context, () => mailOverviewMessages.resolve([locale()]).t));
      await creation?.mutate();
    } finally {
      setCreating(false);
    }
  };
  const load = async () => {
    if (requested) return;
    requested = true;
    setFailed(false);
    try {
      // The readable-mailboxes endpoint returns one list and accepts at most 200, without pagination.
      const response = await apiClient.mailboxes.$get({ query: { limit: "200" } });
      if (!response.ok) throw new Error();
      const items = await response.json();
      if (!Array.isArray(items)) throw new Error();
      setOptions(
        items.map((item) => ({
          id: item.id,
          label: item.name,
          description: item.receivingAddress ?? undefined,
          href: `/app/mail/${item.id}`,
        })),
      );
    } catch {
      requested = false;
      setFailed(true);
    }
  };
  return () => ({
    currentId: mailbox().id,
    label: mailbox().name,
    icon: "ti ti-inbox",
    description: mailbox().address,
    switchLabel: t().switchMailbox,
    options: options(),
    error: failed() ? t().failedLoadMailboxes : undefined,
    onLoad: () => void load(),
    actions: [
      ...(canCreate ? [{ id: "new", label: t().newMailbox, icon: "ti ti-plus", action: () => void create(), disabled: creating() }] : []),
      { id: "all", label: t().allMailboxes, icon: "ti ti-layout-grid", href: "/app/mail" },
    ],
  });
}
