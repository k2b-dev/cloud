import { AdminWorkspace } from "@k2b/cloud/ssr/islands";
import { swapPage } from "@k2b/ssr/nav";
import { mutation } from "@k2b/stdlib/solid";
import { useLocale } from "@k2b/ui";
import {
  Bar,
  Button,
  Cells,
  Chip,
  Inline,
  Input,
  List,
  Mark,
  Menu,
  type NavProps,
  Notice,
  Pane,
  Row,
  Section,
  type Status,
  StatusRow,
  Table,
  Text,
  useToast,
} from "@k2b/ui/v2";
import { createMemo, createSignal, Show } from "solid-js";
import { apiClient } from "../../../api/client";
import { contactDirectoryMessages } from "../../../contact-directory-messages";
import { usesContactDirectoryDefaults } from "../../../contact-directory-settings";
import type { ContactDirectoryAdminView } from "../../../service/contact-directory";
import { mailPageMessages } from "../../pages-messages";
import { readApiError } from "../api-response";
import { openMailContactDirectoryDialog } from "../MailContactDirectoryDialog";
import { mailSettingsMessages } from "../mail-settings-messages";
import { repairMailboxAccess } from "../mailbox-access-repair";

/** Mail's colour (its app accent), the colour of a mailbox wherever administration shows one. */
const MAIL_COLOR = "#0f766e";

/** One mailbox as the table shows it; the page words and formats it, so the first render matches the server. */
export type MailAdminMailboxRow = {
  id: string;
  name: string;
  /** The health as a dot and a word; no status for a paused mailbox. */
  health: { label: string; status?: Status };
  /** The last sync: a relative time for the cell, the full time for its tooltip. */
  sync: { text: string; title: string; iso: string } | null;
  administrators: number;
  people: number;
  /** The logical size, formatted; `null` before the first reconciliation. */
  storage: string | null;
  attention: number;
};

export type MailAdminMailboxesProps = {
  nav: NavProps;
  rows: MailAdminMailboxRow[];
  /** The key figures; `null` where their source could not be loaded. */
  figures: {
    mailboxes: number | null;
    withoutAdministrator: number | null;
    attention: number | null;
    storage: { value: string; meta: string } | null;
  };
  contactDirectory: ContactDirectoryAdminView | null;
  /** What could not be loaded, worded for the page; the rest of the page stays. */
  failure: string | null;
  query: string;
  nextCursor: string | null;
};

const listHref = (params: { q?: string; cursor?: string | null }) => {
  const query = new URLSearchParams();
  if (params.q) query.set("q", params.q);
  if (params.cursor) query.set("cursor", params.cursor);
  return query.size ? `/admin/mail?${query}` : "/admin/mail";
};

/**
 * Cloud administration › Mail › Mailboxes on v2, after the home recipe and filtered-table: four key figures, then
 * one row per mailbox with its health, last sync, access, storage and what needs attention, and the access repair as
 * the row's one action; the contact directory is one setting at the end. No message content shows here.
 */
export default function MailAdminMailboxes(props: MailAdminMailboxesProps) {
  const locale = useLocale();
  const t = createMemo(() => mailPageMessages.resolve([locale()]).t);
  const settings = createMemo(() => mailSettingsMessages.resolve([locale()]).t);
  const directoryText = createMemo(() => contactDirectoryMessages.resolve([locale()]).t);
  const toast = useToast();
  const number = (value: number) => new Intl.NumberFormat(locale()).format(value);
  const [directory, setDirectory] = createSignal(props.contactDirectory);

  const repair = mutation.create<void, { id: string; name: string }>({
    mutation: (row) => repairMailboxAccess({ mailboxId: row.id, mailboxName: row.name }, settings(), locale()),
    onError: (error) => toast(error.message, { status: "bad" }),
  });
  const reconcile = mutation.create<void, void>({
    mutation: async (_input, { abortSignal }) => {
      const response = await apiClient.admin.storage.reconcile.$post(undefined, { init: { signal: abortSignal } });
      if (!response.ok) throw new Error(await readApiError(response, settings().failedReconcileStorage));
    },
    onSuccess: () => toast(settings().storageReconciliationQueued, { status: "ok" }),
    onError: (error) => toast(error.message, { status: "bad", retry: () => void reconcile.mutate() }),
  });
  const configureDirectory = async () => {
    const view = directory();
    if (!view) return;
    const saved = await openMailContactDirectoryDialog(view, locale());
    if (saved) setDirectory({ ...view, ...saved, issues: [] });
  };
  const directoryApp = (view: ContactDirectoryAdminView) =>
    view.apps?.find((app) => app.appId === view.config.appId)?.appName ?? view.config.appId;
  const directoryNeedsAttention = (view: ContactDirectoryAdminView) =>
    view.issues.length > 0 || Object.values(view.unreadable ?? {}).some(Boolean);
  const figure = (value: number | null) => (value === null ? t().unavailable : number(value));
  const search = (text: string) => void swapPage(listHref({ q: text.trim() }));

  return (
    <AdminWorkspace
      nav={props.nav}
      head={
        <Bar
          end={
            <>
              <Input
                type="search"
                icon="search"
                label={t().searchMailboxesLabel}
                placeholder={t().searchMailboxesPlaceholder}
                value={props.query}
                onKeyDown={(event) => {
                  if (event.isComposing) return;
                  const input = event.currentTarget as HTMLInputElement;
                  if (event.key === "Enter") search(input.value);
                  if (event.key === "Escape" && input.value) {
                    input.value = "";
                    search("");
                  }
                }}
              />
              <Menu
                label={t().moreActions}
                items={[{ label: settings().refreshStorageSnapshot, icon: "refresh", onClick: () => void reconcile.mutate() }]}
              />
            </>
          }
        />
      }
    >
      <Pane
        label={t().adminMailboxes}
        scrollKey="mail-admin-mailboxes"
        status={
          <StatusRow
            lead={
              props.figures.mailboxes === null
                ? t().adminMailboxes
                : t().mailboxesShown({ shown: number(props.rows.length), total: number(props.figures.mailboxes) })
            }
          />
        }
      >
        <Show when={props.failure}>
          {(text) => (
            <Notice tone="bad" title={t().partialAdminError}>
              {text()}
            </Notice>
          )}
        </Show>
        <Cells>
          <Cells.Cell
            icon="inbox"
            color={MAIL_COLOR}
            label={t().adminMailboxes}
            value={figure(props.figures.mailboxes)}
            meta={t().active}
          />
          <Cells.Cell
            icon="user-exclamation"
            label={t().needOwner}
            value={
              props.figures.withoutAdministrator ? (
                <Chip status="bad">{number(props.figures.withoutAdministrator)}</Chip>
              ) : (
                figure(props.figures.withoutAdministrator)
              )
            }
            meta={t().noAdministrator}
          />
          <Cells.Cell
            icon="alert-triangle"
            label={t().needAttention}
            value={props.figures.attention ? <Chip status="warn">{number(props.figures.attention)}</Chip> : figure(props.figures.attention)}
            meta={t().failedCommands}
          />
          <Cells.Cell
            icon="database"
            label={t().logicalStorage}
            value={props.figures.storage?.value ?? t().unavailable}
            meta={props.figures.storage?.meta}
          />
        </Cells>
        <Table
          label={t().activeMailboxes}
          rows={props.rows}
          rowKey={(row) => row.id}
          // opening a mailbox opens its access, the one thing administration does with it (also on the phone, where
          // the row has no column of deeds)
          open={(row) => ({ onOpen: () => void repair.mutate({ id: row.id, name: row.name }) })}
          empty={
            props.query
              ? {
                  icon: "search-off",
                  text: t().noMatchingMailboxes({ query: props.query }),
                  action: { label: t().clearSearch, icon: "x", href: "/admin/mail" },
                }
              : { icon: "inbox", text: t().noActiveMailboxes }
          }
          phone={(row) => ({
            mark: { icon: "inbox", color: MAIL_COLOR },
            lines: [row.name, row.sync ? `${row.health.label} · ${row.sync.text}` : row.health.label],
            time: row.storage ?? undefined,
            marks:
              row.administrators === 0 ? (
                <Chip status="bad">{t().needOwner}</Chip>
              ) : row.attention > 0 ? (
                <Chip status="warn">{number(row.attention)}</Chip>
              ) : undefined,
          })}
          // columns that drop give way from the last one as the table gets narrower: the ID first, then storage; the
          // mailbox, its health, its last sync, what needs attention and its access (with the repair) stay
          columns={[
            {
              title: t().adminMailboxes,
              width: { min: 180, default: 240 },
              cell: (row) => (
                // k2b-ui gap: a Mark in an Inline gives way to a long name beside it (the recipes' pattern); reported
                <Inline>
                  <Mark icon="inbox" color={MAIL_COLOR} />
                  <Text>{row.name}</Text>
                </Inline>
              ),
            },
            {
              title: t().health,
              width: { min: 120, default: 130 },
              cell: (row) =>
                row.health.status ? <Chip status={row.health.status}>{row.health.label}</Chip> : <Chip>{row.health.label}</Chip>,
            },
            {
              title: t().lastSync,
              width: { min: 120, default: 140 },
              cell: (row) =>
                row.sync ? (
                  <time dateTime={row.sync.iso} title={row.sync.title}>
                    {row.sync.text}
                  </time>
                ) : (
                  <Text muted>{t().never}</Text>
                ),
            },
            { title: t().storage, width: { min: 90, default: 100 }, align: "end", cell: (row) => row.storage ?? "–", drop: true },
            { title: t().mailboxIdColumn, width: { min: 80, default: 90 }, cell: (row) => <Text muted>{row.id}</Text>, drop: true },
            {
              title: t().attention,
              width: { min: 100, default: 110 },
              align: "end",
              cell: (row) =>
                row.attention > 0 ? (
                  <Text weight="medium" tone="warn">
                    {number(row.attention)}
                  </Text>
                ) : (
                  <Text muted>0</Text>
                ),
            },
            {
              title: t().access,
              width: { min: 170, default: 200 },
              // the access repair is the row's one deed: a mailbox nobody can manage gets its people back here
              cell: (row) => (
                <Inline>
                  {row.administrators === 0 ? (
                    <Chip status="bad">{t().needOwner}</Chip>
                  ) : (
                    <Text>{t().accessCounts({ administrators: row.administrators, total: row.people })}</Text>
                  )}
                  <Button
                    variant="ghost"
                    icon="shield"
                    label={settings().managePermissionsFor({ name: row.name })}
                    busy={repair.loading()}
                    onClick={() => void repair.mutate({ id: row.id, name: row.name })}
                  />
                </Inline>
              ),
            },
          ]}
        />
        <Show when={props.nextCursor}>
          {(next) => (
            <Bar
              end={
                <Button href={listHref({ q: props.query, cursor: next() })} forward>
                  {t().nextPage}
                </Button>
              }
            />
          )}
        </Show>
        <Show when={directory()}>
          {(view) => (
            <Section icon="address-book" title={directoryText().title}>
              <List label={directoryText().title}>
                <Row
                  mark={{ icon: "address-book", color: "#2563eb" }}
                  lines={[
                    directoryApp(view()),
                    <>
                      {usesContactDirectoryDefaults(view().config) ? directoryText().defaults : directoryText().custom}
                      <Show when={directoryNeedsAttention(view())}>
                        {" · "}
                        <Text tone="warn">{directoryText().needsAttention}</Text>
                      </Show>
                    </>,
                  ]}
                  action={{ label: directoryText().configure, icon: "adjustments", onClick: () => void configureDirectory() }}
                />
              </List>
            </Section>
          )}
        </Show>
        <Text type="meta" muted>
          {t().adminDescription}
        </Text>
      </Pane>
    </AdminWorkspace>
  );
}
