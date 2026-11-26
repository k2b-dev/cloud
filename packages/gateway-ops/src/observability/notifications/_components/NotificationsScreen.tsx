import { AdminWorkspace } from "@k2b/cloud/ssr/islands";
import { useLocale } from "@k2b/ui";
import {
  Bar,
  Button,
  Chip,
  confirm,
  Dialog,
  Empty,
  Facts,
  Field,
  FilterBar,
  Icon,
  Input,
  type NavProps,
  Notice,
  Pane,
  StatusRow,
  Table,
  Tabs,
  Text,
  useToast,
} from "@k2b/ui/v2";
import { createMemo, createSignal, Show } from "solid-js";
import { gatewayOpsMessages } from "../../../messages";
import { type KeyCell, KeyCells } from "../../_components/KeyCells";
import { apiClient } from "../api-client";
import {
  type LegacyState,
  legacyQuery,
  NOTIFICATIONS_PAGE_MAX,
  NOTIFICATIONS_PER_PAGE,
  type NotificationsView,
  notificationsHref,
  type RegistryState,
  registryQuery,
} from "../query";

/** One notification definition an app registered, worded by the server. */
export type DefinitionRow = {
  id: string;
  label: string;
  description: string;
  kind: string;
  app: { id: string; label: string; icon: string };
  recipientKind: string;
  recommended: string[];
  required: string[];
  events: string;
  failures: number;
  lastSeen: string;
  active: boolean;
};

/** One notification sent before the delivery pipeline. */
export type LegacyRow = {
  id: string;
  status: "sent" | "pending" | "error";
  recipient: string;
  subject: string;
  sentBy: string | null;
  created: string;
  error: string | null;
};

/** The open earlier notification, read on its own: its content too, for editing. */
export type OpenedNotification = LegacyRow & { content: string };

export type NotificationsScreenProps = {
  nav: NavProps;
  view: NotificationsView;
  apps: { id: string; label: string }[];
  page: number;
  registry: { state: RegistryState; rows: DefinitionRow[]; total: number; cells: KeyCell[] } | null;
  legacy: {
    state: LegacyState;
    rows: LegacyRow[];
    total: number;
    cells: KeyCell[];
    pendingSystem: number;
    /** With a search: its hits and how many of them failed or wait. */
    searchFacts: string[];
  } | null;
  /** The earlier notification open beside the list (`notification=<id>`) … */
  open: string | null;
  /** … as the server read it; null when there is none with that id. */
  opened: OpenedNotification | null;
};

const CHANNEL_ICON: Record<string, string> = { email: "mail", browser: "browser", push: "device-mobile", chat: "message" };

/**
 * Notifications on v2: the definitions apps register and the notifications sent before the delivery pipeline. The
 * deliveries themselves are runs. Each view is one address; a filter is a new address.
 */
export default function NotificationsScreen(props: NotificationsScreenProps) {
  const locale = useLocale();
  const t = () => gatewayOpsMessages.resolve([locale()]).t;
  const toast = useToast();
  const number = (value: number) => value.toLocaleString(locale());
  const definitions = createMemo(() => registryQuery(locale(), props.apps));
  const earlier = createMemo(() => legacyQuery(locale()));
  const goRegistry = (next: RegistryState, page = 1) => location.assign(notificationsHref("registry", definitions().serialize(next), page));
  const goLegacy = (next: LegacyState, page = 1) => location.assign(notificationsHref("legacy", earlier().serialize(next), page));
  const search = () => (props.view === "registry" ? props.registry?.state.search : props.legacy?.state.search) ?? "";
  const searchFor = (text: string) => {
    const value = text.trim() || undefined;
    if (props.registry) goRegistry({ ...props.registry.state, search: value });
    if (props.legacy) goLegacy({ ...props.legacy.state, search: value });
  };
  const total = () => props.registry?.total ?? props.legacy?.total ?? 0;
  const pages = () => Math.min(NOTIFICATIONS_PAGE_MAX, Math.max(1, Math.ceil(total() / NOTIFICATIONS_PER_PAGE)));
  const pageHref = (page: number) =>
    props.registry
      ? notificationsHref("registry", definitions().serialize(props.registry.state), page)
      : notificationsHref("legacy", earlier().serialize(props.legacy?.state ?? earlier().reset()), page);

  /** The earlier notifications' address on this page, with one of them open or none. */
  const legacyHref = (extra: { open?: string | null } = {}) => {
    const href = notificationsHref("legacy", earlier().serialize(props.legacy?.state ?? earlier().reset()), props.page);
    return extra.open ? `${href}&notification=${encodeURIComponent(extra.open)}` : href;
  };
  const opened = () => props.opened;

  const channel = (name: string, required: boolean) => (
    <Chip icon={required ? "lock" : (CHANNEL_ICON[name] ?? "send")}>
      {name === "email" ? t().email : name === "browser" ? t().browser : name}
    </Chip>
  );

  // ── Earlier notifications: send again, edit, read the error ────────────────────────────────────────────────────
  const [editing, setEditing] = createSignal<OpenedNotification | null>(null);
  const [draft, setDraft] = createSignal({ recipient: "", subject: "", content: "" });
  const [busy, setBusy] = createSignal(false);
  const [sending, setSending] = createSignal(false);
  const [failure, setFailure] = createSignal<string | null>(null);
  const send = async (row: LegacyRow) => {
    const pending = row.status === "pending";
    const agreed = await confirm({
      title: pending ? t().sendNotificationTitle : t().resendNotificationTitle,
      description: t().sendNotificationConfirm({ resend: !pending, recipient: row.recipient }),
      confirm: pending ? t().send : t().resend,
    });
    if (!agreed) return;
    setSending(true);
    const response = await apiClient[":id"].resend.$post({ param: { id: row.id } }).catch(() => null);
    if (!response?.ok) {
      setSending(false);
      toast(t().notSent, { status: "bad", retry: () => void send(row) });
      return;
    }
    toast(t().notificationResent, { status: "ok" });
    location.reload();
  };
  const edit = (row: OpenedNotification) => {
    setDraft({ recipient: row.recipient, subject: row.subject, content: row.content });
    setFailure(null);
    setEditing(row);
  };
  const save = async () => {
    const row = editing();
    if (!row) return;
    const values = { recipient: draft().recipient.trim(), subject: draft().subject.trim(), content: draft().content };
    if (!values.recipient || !values.subject || !values.content.trim()) {
      setFailure(t().updateNotificationFailed);
      return;
    }
    setBusy(true);
    const response = await apiClient[":id"].$patch({ param: { id: row.id }, json: values }).catch(() => null);
    setBusy(false);
    if (!response?.ok) {
      setFailure(t().updateNotificationFailed);
      return;
    }
    setEditing(null);
    toast(t().notificationUpdated, { status: "ok" });
    location.reload();
  };
  const sendAllPending = async () => {
    const count = props.legacy?.pendingSystem ?? 0;
    const agreed = await confirm({
      title: t().sendAllPendingTitle,
      description: t().sendPendingConfirm({ count }),
      confirm: t().sendNotificationCount({ count }),
    });
    if (!agreed) return;
    const response = await apiClient["pending-system"]["send-all"].$post().catch(() => null);
    const result = response?.ok ? await response.json() : null;
    if (!result || !("sent" in result)) {
      toast(t().notSent, { status: "bad", retry: () => void sendAllPending() });
      return;
    }
    toast(t().sentNotifications({ count: result.sent }), { status: result.failed === 0 ? "ok" : "bad" });
    location.reload();
  };

  const statusChip = (status: LegacyRow["status"]) =>
    status === "sent" ? (
      <Chip status="ok">{t().sent}</Chip>
    ) : status === "error" ? (
      <Chip status="bad">{t().failed}</Chip>
    ) : (
      <Chip icon="clock">{t().pending}</Chip>
    );

  return (
    <AdminWorkspace
      nav={props.nav}
      detail={props.view === "legacy" && props.open ? 440 : undefined}
      head={
        <Bar
          start={
            <Tabs
              label={t().notificationView}
              items={[
                {
                  label: t().registryView,
                  icon: "list-details",
                  href: notificationsHref("registry", new URLSearchParams()),
                  current: props.view === "registry",
                },
                {
                  label: t().legacyView,
                  icon: "mail",
                  href: notificationsHref("legacy", new URLSearchParams()),
                  current: props.view === "legacy",
                },
              ]}
            />
          }
          end={
            <>
              <Input
                type="search"
                icon="search"
                label={t().search}
                placeholder={t().search}
                value={search()}
                onKeyDown={(event) => {
                  if (event.isComposing) return;
                  const input = event.currentTarget as HTMLInputElement;
                  if (event.key === "Enter") searchFor(input.value);
                  if (event.key === "Escape" && input.value) searchFor("");
                }}
              />
              <Show when={props.legacy && props.legacy.pendingSystem > 0}>
                <Button icon="send" onClick={() => void sendAllPending()}>
                  {t().sendNotificationCount({ count: props.legacy?.pendingSystem ?? 0 })}
                </Button>
              </Show>
            </>
          }
        />
      }
    >
      <Pane.Split>
        <Pane
          label={props.view === "registry" ? t().registeredNotificationKinds : t().legacyEmailEntries}
          scrollKey={`gateway-ops-notifications-${props.view}`}
          status={
            <>
              <Show when={props.registry}>
                {(registry) => (
                  <FilterBar
                    query={definitions()}
                    state={registry().state}
                    onChange={(next) => goRegistry(next)}
                    base={definitions().reset()}
                    icons={{ status: "circle-check", app: "apps" }}
                  />
                )}
              </Show>
              <Show when={props.legacy}>
                {(legacy) => (
                  <FilterBar
                    query={earlier()}
                    state={legacy().state}
                    onChange={(next) => goLegacy(next)}
                    base={earlier().reset()}
                    icons={{ status: "circle-dashed" }}
                  />
                )}
              </Show>
              <StatusRow
                lead={
                  props.registry
                    ? t().definitionsCount({ count: number(props.registry.rows.length), total: number(props.registry.total) })
                    : t().entriesCount({ count: number(props.legacy?.rows.length ?? 0), total: number(props.legacy?.total ?? 0) })
                }
                facts={(props.legacy?.searchFacts ?? []).map((fact) => ({ after: fact }))}
              />
            </>
          }
        >
          <Show when={props.registry}>
            {(registry) => (
              <>
                <KeyCells cells={registry().cells} />
                <Table
                  label={t().registeredNotificationKinds}
                  rows={registry().rows}
                  rowKey={(row) => row.id}
                  sticky
                  empty={
                    registry().state.search
                      ? { icon: "filter-off", text: t().noMatchingRegisteredNotifications }
                      : { icon: "bell-off", text: t().noRegisteredDefinitions }
                  }
                  phone={(row) => ({
                    lines: [row.label, [row.app.label, row.kind].join(" · ")],
                    time: row.lastSeen,
                    marks: row.active ? <Chip status="ok">{t().active}</Chip> : <Chip icon="archive">{t().inactive}</Chip>,
                  })}
                  columns={[
                    {
                      title: t().notification,
                      width: { min: 240, default: 360 },
                      cell: (row) => ({ lines: [row.label, row.description || row.kind] }),
                    },
                    {
                      title: t().app,
                      width: { min: 110, default: 150 },
                      // k2b-ui gap: a table cell has no mark (object symbol in its colour) beside text that may be cut
                      cell: (row) => (
                        <>
                          <Icon name={row.app.icon} /> {row.app.label}
                        </>
                      ),
                      drop: true,
                    },
                    {
                      title: t().recommended,
                      width: { min: 140, default: 200 },
                      cell: (row) => (
                        <>
                          {row.required.map((name) => channel(name, true))}
                          {row.recommended.filter((name) => !row.required.includes(name)).map((name) => channel(name, false))}
                          {row.recommended.length + row.required.length === 0 ? "—" : null}
                        </>
                      ),
                      drop: true,
                    },
                    { title: t().events7d, width: { min: 100, default: 110 }, align: "end", cell: (row) => row.events },
                    {
                      title: t().failures7d,
                      width: { min: 100, default: 110 },
                      align: "end",
                      cell: (row) => (row.failures > 0 ? <Chip status="bad">{number(row.failures)}</Chip> : "—"),
                      drop: true,
                    },
                    { title: t().lastSeenLabel, width: { min: 120, default: 140 }, cell: (row) => row.lastSeen, drop: true },
                    {
                      title: t().state,
                      width: { min: 110, default: 120 },
                      cell: (row) => (row.active ? <Chip status="ok">{t().active}</Chip> : <Chip icon="archive">{t().inactive}</Chip>),
                    },
                  ]}
                />
              </>
            )}
          </Show>
          <Show when={props.legacy}>
            {(legacy) => (
              <>
                <KeyCells cells={legacy().cells} />
                <Table
                  label={t().legacyEmailEntries}
                  rows={legacy().rows}
                  rowKey={(row) => row.id}
                  sticky
                  current={props.open ?? undefined}
                  open={(row) => ({ href: legacyHref({ open: row.id }) })}
                  empty={
                    legacy().state.search || legacy().state.filters.status
                      ? {
                          icon: "filter-off",
                          text: t().noMatchingLegacyNotifications,
                          action: { label: t().clear, icon: "filter-off", href: notificationsHref("legacy", new URLSearchParams()) },
                        }
                      : { icon: "mail-off", text: t().noLegacyNotifications }
                  }
                  phone={(row) => ({ lines: [row.subject, row.recipient], time: row.created, marks: statusChip(row.status) })}
                  columns={[
                    { title: t().subject, width: { min: 240, default: 380 }, cell: (row) => ({ lines: [row.subject, row.recipient] }) },
                    { title: t().status, width: { min: 130, default: 150 }, cell: (row) => statusChip(row.status) },
                    { title: t().sentBy, width: { min: 120, default: 160 }, cell: (row) => row.sentBy ?? t().system, drop: true },
                    { title: t().created, width: { min: 130, default: 150 }, cell: (row) => row.created },
                  ]}
                />
              </>
            )}
          </Show>
          <Show when={pages() > 1}>
            <Bar
              start={<Text type="meta">{`${props.page.toLocaleString(locale())} / ${pages().toLocaleString(locale())}`}</Text>}
              end={
                <>
                  <Button icon="chevron-left" href={pageHref(props.page - 1)} disabled={props.page <= 1}>
                    {t().previous}
                  </Button>
                  <Button href={pageHref(props.page + 1)} disabled={props.page >= pages()} forward>
                    {t().next}
                  </Button>
                </>
              }
            />
          </Show>
        </Pane>
        <Show when={props.view === "legacy" && props.open}>
          <Pane
            detail
            label={opened()?.subject ?? t().legacyEmailEntries}
            back={{ label: t().legacyEmailEntries, href: legacyHref() }}
            head={
              <Bar
                start={<Text type="lead">{opened()?.subject ?? t().legacyEmailEntries}</Text>}
                end={<Button variant="ghost" icon="x" label={t().close} href={legacyHref()} />}
              />
            }
          >
            <Show
              when={opened()}
              fallback={
                <Empty icon="mail-off" text={t().notificationNotFound} action={{ label: t().legacyEmailEntries, href: legacyHref() }} />
              }
            >
              {(row) => (
                <>
                  <Show when={row().error}>
                    {(error) => (
                      <Notice tone="bad" title={t().notificationError}>
                        {error()}
                      </Notice>
                    )}
                  </Show>
                  <Facts
                    items={[
                      { label: t().status, value: statusChip(row().status) },
                      { label: t().recipient, value: row().recipient, mono: true, copy: row().recipient },
                      { label: t().subject, value: row().subject },
                      { label: t().sentBy, value: row().sentBy ?? t().system },
                      { label: t().created, value: row().created },
                    ]}
                  />
                  <Bar
                    end={
                      <>
                        <Button icon="pencil" onClick={() => edit(row())}>
                          {t().edit}
                        </Button>
                        <Button icon="send" busy={sending()} onClick={() => void send(row())}>
                          {row().status === "pending" ? t().send : t().resend}
                        </Button>
                      </>
                    }
                  />
                </>
              )}
            </Show>
          </Pane>
        </Show>
      </Pane.Split>
      <Dialog
        title={t().editNotification}
        open={editing() !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        foot={
          <>
            <Button onClick={() => setEditing(null)}>{t().cancel}</Button>
            <Button icon="device-floppy" busy={busy()} onClick={() => void save()}>
              {t().save}
            </Button>
          </>
        }
      >
        <Field label={t().recipient} error={failure() ?? undefined}>
          <Input type="email" value={draft().recipient} onInput={(value) => setDraft({ ...draft(), recipient: value })} />
        </Field>
        <Field label={t().subject}>
          <Input value={draft().subject} onInput={(value) => setDraft({ ...draft(), subject: value })} />
        </Field>
        <Field label={t().contentHtml}>
          <Input multiline value={draft().content} onInput={(value) => setDraft({ ...draft(), content: value })} />
        </Field>
      </Dialog>
    </AdminWorkspace>
  );
}
