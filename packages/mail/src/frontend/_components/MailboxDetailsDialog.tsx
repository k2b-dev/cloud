import { PermissionEditor } from "@k2b/cloud/access/ui";
import { type DateContext, dates } from "@k2b/stdlib";
import {
  Button,
  CopyButton,
  DescriptionList,
  dialogCore,
  PanelDialog,
  panelDialogOptions,
  StatusBadge,
  type StatusTone,
  useLocale,
} from "@k2b/ui";
import { createMemo, For, Show } from "solid-js";
import type { Mailbox, MailboxHealth, SenderIdentity } from "../../contracts";
import type { MailboxDetails } from "../../service/mailbox-details";
import { mailMailboxDetailsMessages } from "./mail-mailbox-details-messages";

export type MailboxDetailsDialogProps = {
  mailbox: Pick<Mailbox, "name" | "description" | "health" | "healthReason">;
  permission: "read" | "write" | "admin";
  identities: readonly SenderIdentity[];
  folderCount: number;
  details: MailboxDetails;
  dateConfig: DateContext;
};

type MailboxAddress = { address: string; names: string[]; receiving: boolean; defaultSender: boolean };

/**
 * One row per address, compared without case: the receiving address first, then each address Mail can send from
 * once. An identity sends only once it is verified.
 */
export const mailboxAddresses = (account: MailboxDetails["account"], identities: readonly SenderIdentity[]): MailboxAddress[] => {
  const byAddress = new Map<string, MailboxAddress>();
  const entry = (address: string) => {
    const key = address.toLowerCase();
    const current = byAddress.get(key) ?? { address, names: [], receiving: false, defaultSender: false };
    byAddress.set(key, current);
    return current;
  };
  if (account) entry(account.email).receiving = true;
  for (const identity of identities) {
    if (identity.status !== "verified") continue;
    const current = entry(identity.fromAddress);
    if (identity.displayName && !current.names.includes(identity.displayName)) current.names.push(identity.displayName);
    current.defaultSender ||= identity.isDefault;
  }
  return [...byAddress.values()];
};

/**
 * What everyone who can read the mailbox may know about it: its addresses, how it is connected, and who has which
 * access. It changes nothing; managers continue to the access settings.
 */
export function MailboxDetailsDialog(props: MailboxDetailsDialogProps & { close: (result?: "manage-access") => void }) {
  const locale = useLocale();
  const t = createMemo(() => mailMailboxDetailsMessages.resolve([locale()]).t);
  const addresses = createMemo(() => mailboxAddresses(props.details.account, props.identities));
  // A short state rather than the workspace banner's request, which only managers can act on.
  const connection = createMemo((): { tone: StatusTone; label: string } => {
    const health: Record<MailboxHealth, { tone: StatusTone; label: string }> = {
      active: { tone: "ok", label: t().connected },
      paused: { tone: "warning", label: t().paused },
      degraded: { tone: "warning", label: t().notSynchronizing },
      auth_required: { tone: "warning", label: t().signInRequired },
      connection_required: { tone: "warning", label: t().notConnected },
      disconnected: { tone: "warning", label: t().notConnected },
      verifying: { tone: "info", label: t().checking },
      bootstrapping: { tone: "info", label: t().settingUp },
      reconnecting: { tone: "info", label: t().reconnecting },
    };
    return health[props.mailbox.health];
  });
  const lastSync = () => props.details.lastSyncAt;
  const permissionLabel = () => ({ read: t().view, write: t().edit, admin: t().manage })[props.permission];
  // The editor only shows entries here; it never calls these.
  const readOnly = () => Promise.reject(new Error("read-only"));

  return (
    <PanelDialog>
      <PanelDialog.Header
        title={props.mailbox.name}
        subtitle={props.mailbox.description ?? undefined}
        icon="ti ti-info-circle"
        close={() => props.close()}
        closeLabel={t().closeDetails}
      />
      <PanelDialog.Body>
        <PanelDialog.Section title={t().addresses} subtitle={t().addressesDescription}>
          <Show when={addresses().length > 0} fallback={<p class="text-sm text-dimmed">{t().noAddresses}</p>}>
            <ul class="flex flex-col gap-1" data-mailbox-addresses>
              <For each={addresses()}>
                {(entry) => {
                  const facts = () =>
                    [entry.names.join(", "), entry.receiving ? t().receivingAddress : "", entry.defaultSender ? t().defaultSender : ""]
                      .filter(Boolean)
                      .join(" · ");
                  return (
                    <li class="flex min-w-0 items-center gap-2">
                      <div class="flex min-w-0 flex-1 flex-col">
                        {/* An address is read and compared whole, so it wraps instead of being cut off. */}
                        <span class="text-sm [overflow-wrap:anywhere]">{entry.address}</span>
                        <Show when={facts()}>
                          <span class="text-xs text-dimmed">{facts()}</span>
                        </Show>
                      </div>
                      <CopyButton class="shrink-0" text={entry.address} label={t().copyAddress({ address: entry.address })} iconOnly />
                    </li>
                  );
                }}
              </For>
            </ul>
          </Show>
        </PanelDialog.Section>
        <PanelDialog.Section title={t().mailbox}>
          <DescriptionList
            layout="compact"
            items={[
              { term: t().yourAccess, description: permissionLabel() },
              {
                term: t().connection,
                description: <StatusBadge variant="dot" tone={connection().tone} label={connection().label} />,
              },
              ...(props.details.account ? [{ term: t().server, description: props.details.account.server }] : []),
              {
                term: t().lastSync,
                description: lastSync() ? (
                  <time dateTime={lastSync()!} title={dates.formatDateTime(lastSync()!, props.dateConfig)}>
                    {dates.formatDateTimeRelative(lastSync()!, props.dateConfig)}
                  </time>
                ) : (
                  t().notSyncedYet
                ),
              },
              { term: t().folders, description: <span class="tabular-nums">{props.folderCount}</span> },
            ]}
          />
        </PanelDialog.Section>
        <PanelDialog.Section
          title={t().access}
          subtitle={t().accessDescription}
          actions={
            props.permission === "admin" ? (
              <Button variant="secondary" size="sm" type="button" onClick={() => props.close("manage-access")}>
                <i class="ti ti-shield" aria-hidden="true" />
                {t().manageAccess}
              </Button>
            ) : undefined
          }
        >
          <PermissionEditor
            initialEntries={props.details.access}
            canEdit={false}
            grantAccess={readOnly}
            updateAccess={readOnly}
            revokeAccess={readOnly}
          />
        </PanelDialog.Section>
      </PanelDialog.Body>
    </PanelDialog>
  );
}

/** Resolves to `"manage-access"` when a manager continues to the access settings. */
export const openMailboxDetailsDialog = (props: MailboxDetailsDialogProps) =>
  dialogCore.open<"manage-access">((close) => <MailboxDetailsDialog {...props} close={close} />, { ...panelDialogOptions, history: true });
