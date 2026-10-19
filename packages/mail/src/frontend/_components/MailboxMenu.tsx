import { documentNavigate, refreshCurrentPath } from "@k2b/ssr/nav";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { Dropdown, type DropdownSection, prompts, toast, useLocale } from "@k2b/ui";
import { createMemo, onCleanup, Show } from "solid-js";
import { apiClient } from "../../api/client";
import { readApiError } from "./api-response";
import { registerMailtoHandler } from "./mail-compose-route";
import { mailSidebarMessages } from "./mail-sidebar-messages";

export type MailboxMenuOptions = {
  mailboxId: string;
  syncEnabled: boolean;
  needsConnection: boolean;
  canWrite: boolean;
  canAdmin: boolean;
  /** The person sees only the conversations assigned to them; every entry here needs mailbox-wide access. */
  assignedOnly: boolean;
  managementOpening: "health" | "links" | "remote-content" | "subscriptions" | null;
  settingsOpening: boolean;
  detailsOpening: boolean;
  onOpenDetails: () => void;
  onOpenHealth: () => void;
  onOpenSharedLinks: () => void;
  onOpenRemoteContent: () => void;
  onOpenSubscriptions: () => void;
  onOpenSettings: () => void;
};

type MailboxMenuItem = DropdownSection["items"][number] & { id: string };
export type MailboxMenuSection = Omit<DropdownSection, "items"> & { items: MailboxMenuItem[] };

/**
 * The mailbox's details, tools, and settings, shared by "…" in the head and on the open mailbox's sidebar row. Each
 * entry shows only for people who may use it: nothing for a person who sees only assigned conversations.
 */
export function createMailboxMenu(options: () => MailboxMenuOptions) {
  const locale = useLocale();
  const messages = createMemo(() => mailSidebarMessages.resolve([locale()]).t);
  const sync = mutations.create<void, void, { idempotencyKey: string }>({
    onBefore: () => ({ idempotencyKey: crypto.randomUUID() }),
    mutation: async (_input, { abortSignal, idempotencyKey }) => {
      const response = await apiClient.mailboxes[":mailboxId"].commands.$post(
        { param: { mailboxId: options().mailboxId }, json: { kind: "sync_mailbox", idempotencyKey } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, messages().failedStartSync));
    },
    onSuccess: () => {
      toast.success(messages().syncQueued);
      refreshCurrentPath();
    },
    onError: (error) => toast.error(error.message),
  });
  onCleanup(() => sync.abort());

  const registerEmailLinks = async () => {
    const result = registerMailtoHandler(navigator, window.location.origin);
    if (result.kind === "requested") {
      await prompts.alert(messages().browserHandlerInstructions, { title: messages().checkBrowser });
      return;
    }
    if (result.kind === "unsupported") {
      await prompts.alert(messages().handlerUnsupported, { title: messages().emailLinksUnsupported });
      return;
    }
    await prompts.error(messages().emailLinkRegistrationFailed, { title: messages().couldNotRegisterEmailLinks });
  };

  const sections = (): MailboxMenuSection[] => {
    const current = options();
    if (current.assignedOnly) return [];
    const t = messages();
    return [
      {
        sectionLabel: t.mailbox,
        items: [
          {
            id: "details",
            label: current.canWrite ? t.mailboxDetails : t.aboutMailbox,
            icon: "ti ti-info-circle",
            action: current.onOpenDetails,
            disabled: current.detailsOpening,
          },
          ...(current.canAdmin
            ? [
                {
                  id: "sync",
                  label: current.syncEnabled ? t.syncMailbox : t.mailboxPaused,
                  icon: current.syncEnabled ? "ti ti-refresh" : "ti ti-player-play",
                  action: current.syncEnabled ? () => sync.mutate() : current.onOpenHealth,
                  // The mailbox notice names the missing connection; a sync request would queue nothing.
                  disabled: current.syncEnabled && current.needsConnection,
                },
                { id: "health", label: t.mailboxHealth, icon: "ti ti-heartbeat", action: current.onOpenHealth },
              ]
            : []),
          {
            id: "automations",
            label: t.automations,
            icon: "ti ti-route",
            action: () => documentNavigate(`/app/mail/${current.mailboxId}/automations`),
          },
        ],
      },
      {
        sectionLabel: t.manage,
        items: [
          { id: "mailing-lists", label: t.mailingLists, icon: "ti ti-news", action: current.onOpenSubscriptions },
          { id: "remote-images", label: t.remoteImages, icon: "ti ti-photo-shield", action: current.onOpenRemoteContent },
          ...(current.canAdmin
            ? [{ id: "shared-links", label: t.sharedLinks, icon: "ti ti-link", action: current.onOpenSharedLinks }]
            : []),
        ],
      },
      {
        sectionLabel: t.thisBrowser,
        items: [{ id: "email-links", label: t.emailLinkSetup, icon: "ti ti-link", action: () => void registerEmailLinks() }],
      },
      {
        items: [{ id: "settings", label: t.settings, icon: "ti ti-settings", action: current.onOpenSettings }],
      },
    ];
  };
  /** A dialog's code can still be loading: the trigger keeps its place and focus and shows progress. */
  const busy = () => {
    const current = options();
    return current.managementOpening !== null || current.settingsOpening || current.detailsOpening || sync.loading();
  };
  return { sections, busy, syncing: sync.loading };
}

export type MailboxMenu = ReturnType<typeof createMailboxMenu>;

/** "…" for the mailbox. Renders nothing when the person may use no entry. */
export function MailboxMenuButton(props: { menu: MailboxMenu; label: string; size?: "xs" | "sm"; class?: string }) {
  return (
    <Show when={props.menu.sections().length > 0}>
      <Dropdown.Root items={props.menu.sections()} position="bottom-right" label={props.label} phone="sheet">
        <Dropdown.Trigger
          iconOnly
          type="button"
          variant={props.size === "xs" ? "text" : "ghost"}
          size={props.size ?? "sm"}
          class={props.class}
          label={props.label}
          disabled={props.menu.syncing()}
          aria-busy={props.menu.busy() ? "true" : undefined}
        >
          <i class={props.menu.busy() ? "ti ti-loader-2 animate-spin" : "ti ti-dots"} aria-hidden="true" />
        </Dropdown.Trigger>
      </Dropdown.Root>
    </Show>
  );
}
