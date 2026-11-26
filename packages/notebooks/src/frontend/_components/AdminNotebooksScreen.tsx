import { AdminWorkspace } from "@k2b/cloud/ssr/islands";
import { navigateTo } from "@k2b/ssr/nav";
import { type DateContext, dates } from "@k2b/stdlib";
import { useLocale } from "@k2b/ui";
import type { NavProps, Person } from "@k2b/ui/v2";
import {
  Avatar,
  Band,
  Bar,
  Button,
  Cells,
  Chip,
  Digest,
  Icon,
  Inline,
  Input,
  Mark,
  Menu,
  Notice,
  Pane,
  Row,
  Section,
  Spark,
  Table,
  Text,
  useToast,
} from "@k2b/ui/v2";
import { For, onCleanup, Show } from "solid-js";
import { describeNoteActivity } from "../activity-messages";
import { notebooksAdminMessages } from "../admin-messages";
import { openNotebooksAppSettings } from "./AdminNotebooksAppSettings";
import { deleteNotebook, openPermissionDialog } from "./admin-notebook-actions";

/** Who an access entry or a change names: a person, a group, an account, or everyone signed in. */
export type AdminNotebookPrincipal = {
  kind: "user" | "group" | "service_account" | "authenticated";
  id: string | null;
  name: string;
  avatarHash: string | null;
};

export type AdminNotebookRow = {
  id: string;
  shortId: string;
  name: string;
  icon: string | null;
  permissionCount: number;
  noteCount: number;
  /** When anything last happened in the notebook; unknown before the activity log reaches back. */
  lastActivityAt: string | null;
  /** The first who have access, people first; `permissionCount` says how many there are in all. */
  access: AdminNotebookPrincipal[];
};

/** The open notebook: what the detail beside the list shows. */
export type AdminNotebookDetail = {
  shortId: string;
  name: string;
  icon: string | null;
  description: string | null;
  createdAt: string;
  noteCount: number;
  lastActivityAt: string | null;
  /** The changes on each of the last 30 days, oldest first; the last is today. */
  changesPerDay: number[];
  /** Who has access and how, up to the first 50; `accessTotal` says how many there are in all. */
  access: { principal: AdminNotebookPrincipal; permission: string }[];
  accessTotal: number;
  /** Who changed it in the last 30 days, most changes first. */
  writers: (AdminNotebookPrincipal & { changes: number; lastAt: string })[];
  /** What happened last, newest first. */
  history: { id: string; actor: AdminNotebookPrincipal; action: string; noteTitle: string | null; at: string }[];
};

/** The figures over every notebook the search matches, not only the page. */
export type AdminNotebooksSummary = {
  orphaned: number;
  /** Notebooks with any change in the last 30 days. */
  active: number;
  /** Notebooks with a change on each of the last 30 days, oldest first. */
  activePerDay: number[];
  /** The first notebooks nobody can reach, by name. */
  orphanedNames: string[];
  /** The first notebooks without a change in the last 30 days, by name. */
  quietNames: string[];
};

export type AdminNotebooksScreenProps = {
  nav: NavProps;
  /** The Notebooks colour: the notebooks belong to Notebooks, so their signs carry it. */
  color?: string;
  rows: AdminNotebookRow[];
  total: number;
  page: number;
  pages: number;
  search: string;
  summary: AdminNotebooksSummary;
  /** The notebook the address opens (`?open=`), beside the list. */
  detail?: AdminNotebookDetail;
  dateConfig: DateContext;
  /** The moment the server read the activity, the base of every relative time. */
  now: string;
};

/** A notebook's sign: its own icon, or the notebooks' one. */
const notebookSign = (icon: string | null) => (icon ?? "ti ti-notebook").replace(/^ti ti-/, "");

/** The address of the notebooks with the search, the page and the open notebook; reload and back keep all three. */
const pageHref = (search: string, page: number, open?: string) => {
  const params = new URLSearchParams();
  if (search) params.set("search", search);
  if (page > 1) params.set("page", String(page));
  if (open) params.set("open", open);
  const query = params.toString();
  return `/admin/notebooks${query ? `?${query}` : ""}`;
};

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
const DAY = 86_400_000;

/** How many signs of a notebook's name an exception shows. */
const NAMED_SIGNS = 24;
/** The first `signs` signs of `text` and "…", counted as people see them (an emoji or an accent is one sign). */
const shorten = (text: string, signs: number) => {
  const graphemes = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map((part) => part.segment);
  return graphemes.length <= signs
    ? text
    : `${graphemes
        .slice(0, signs - 1)
        .join("")
        .trimEnd()}…`;
};

/**
 * The notebooks of the installation for administrators, on v2.
 *
 * Screen brief: an administrator checks which notebooks are in use, which nobody can reach, and what can be cleaned
 * up. (1) How many notebooks were used in the last 30 days, with its daily trend (the hero); (2) the exceptions: the
 * notebooks nobody can reach and those without a change for 30 days, each with the first names; (3) per notebook who
 * has access (the one data column), its notes and its last change. A notebook opens beside the list: its changes per
 * day, who has access, who writes in it and what happened, with its deeds (access, delete). The eye lands on the
 * figure, then on a red exception, then on the rows.
 *
 * k2b-ui gaps: the hero band (DP), the tinted head of the open notebook (DP) and the detail's second column from
 * 1680 px (DR, #4340); until then the nearest parts stand in their place.
 */
export default function AdminNotebooksScreen(props: AdminNotebooksScreenProps) {
  const locale = useLocale();
  const t = () => notebooksAdminMessages.resolve([locale()]).t;
  const toast = useToast();
  const when = (iso: string) => dates.formatDateTimeRelative(iso, { ...props.dateConfig, base: props.now });
  /** A count in the digits and separators of the language, such as 12.480. */
  const count = (value: number) => new Intl.NumberFormat(locale()).format(value);
  /**
   * The first names of an exception, each cut to a few words, and "+n" for the rest: a name may be 120 signs, and the
   * line has no way to cut a part of it (k2b-ui gap: a quiet part of an `Inline` that gives way with "…", DP). Each
   * name is isolated, so an Arabic name does not turn the order of the list around.
   */
  const named = (names: string[], total: number) =>
    t().named({ names: names.map((name) => `⁨${shorten(name, NAMED_SIGNS)}⁩`).join(", "), more: total - names.length });
  const quiet = () => props.total - props.summary.active;
  /** No change for longer than the window: the last change says so in the waiting tone. */
  const stale = (iso: string | null) => iso !== null && Date.parse(props.now) - Date.parse(iso) > 30 * DAY;
  /** The last change, relative to the moment the server read it; unknown where the activity log does not reach back. */
  const lastChange = (iso: string | null) =>
    iso === null ? <Text muted>{t().unknown}</Text> : stale(iso) ? <Text tone="warn">{when(iso)}</Text> : when(iso);
  /** A principal as a face: a person with their picture, a group or an account with its initials. */
  const face = (principal: AdminNotebookPrincipal): Person => ({
    name: principal.kind === "authenticated" ? t().everyone : principal.name,
    image:
      principal.kind === "user" && principal.id && principal.avatarHash
        ? `/api/accounts/users/${encodeURIComponent(principal.id)}/avatar?rev=${encodeURIComponent(principal.avatarHash)}`
        : undefined,
  });
  const kindWord = (kind: AdminNotebookPrincipal["kind"]) =>
    ({ user: t().kindUser, group: t().kindGroup, service_account: t().kindAccount, authenticated: t().kindGroup })[kind];
  const permissionWord = (permission: string) =>
    permission === "admin" ? t().permissionAdmin : permission === "write" ? t().permissionWrite : t().permissionRead;
  const listHref = () => pageHref(props.search, props.page);
  // an access list still loading when the page goes opens no dialog over another page
  const leaving = new AbortController();
  onCleanup(() => leaving.abort());
  const editAccess = (notebook: { shortId: string; name: string }) =>
    openPermissionDialog({ notebookId: notebook.shortId, notebookName: notebook.name }, locale(), leaving.signal).catch(() => {
      // a failure says so in fixed words; a load the leaving page cut short says nothing
      if (leaving.signal.aborted) return;
      toast(t().loadPermissionsFailed, { status: "bad" });
    });
  return (
    <AdminWorkspace
      nav={props.nav}
      head={
        <Bar
          // the admin bar names the page (and the shell's title on the phone), so the head holds only its deeds
          end={
            <>
              {/* k2b-ui gap: a head search that also works before the island runs (Input send, #4279); a desktop head
                  search folded to its symbol (#4255) */}
              <Input
                type="search"
                icon="search"
                label={t().searchLabel}
                placeholder={t().searchPlaceholder}
                value={props.search}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  navigateTo(pageHref((event.currentTarget as HTMLInputElement).value.trim(), 1));
                }}
              />
              {/* k2b-ui gap: Setting – the app's settings open in the v1 panel dialog until v2 has Setting (#4223) */}
              <Button icon="settings" keep onClick={() => void openNotebooksAppSettings()}>
                {t().settings}
              </Button>
            </>
          }
        />
      }
    >
      <Pane.Split>
        {/* the list keeps its width while a notebook is open; the detail takes the rest of a large screen */}
        <Pane label={t().notebooks} width={props.detail ? { min: 440, default: 600 } : undefined} scrollKey="admin-notebooks">
          {/* Nothing found is said once, by the empty table, without figures. */}
          <Show when={props.total > 0}>
            {/* k2b-ui gap: hero band (DP) – the figure in type step 30 and the Notebooks ink, its 30-day chart beside it,
                the exceptions under a hairline; until then the figure is the lead type and its trend a Spark, in a Band */}
            <Band label={t().activeIn30}>
              <Inline>
                <Text type="lead">{count(props.summary.active)}</Text>
                <Text weight="medium">{t().activeIn30}</Text>
                <Text type="meta">{t().ofNotebooks({ count: props.total })}</Text>
                <Spark
                  values={props.summary.activePerDay}
                  label={t().activeTrend({
                    today: props.summary.activePerDay.at(-1) ?? 0,
                    most: Math.max(0, ...props.summary.activePerDay),
                  })}
                />
              </Inline>
              {/* each exception on its own line, with the first names; nothing when all is well (neutral) */}
              <Show when={props.summary.orphaned > 0}>
                <Inline>
                  <Chip status="bad">{t().noAccessCount({ count: props.summary.orphaned })}</Chip>
                  <Text type="meta">{named(props.summary.orphanedNames, props.summary.orphaned)}</Text>
                </Inline>
              </Show>
              <Show when={quiet() > 0}>
                <Inline>
                  <Chip status="warn">{t().quietCount({ count: quiet() })}</Chip>
                  <Text type="meta">{named(props.summary.quietNames, quiet())}</Text>
                </Inline>
              </Show>
            </Band>
          </Show>
          <Table
            label={t().notebookRecords}
            rows={props.rows}
            rowKey={(row) => row.id}
            current={props.detail ? props.rows.find((row) => row.shortId === props.detail?.shortId)?.id : undefined}
            open={(row) => ({ href: pageHref(props.search, props.page, row.shortId) })}
            columns={[
              {
                title: t().notebook,
                width: { min: 160, default: 200 },
                mark: (row) => ({ icon: notebookSign(row.icon), color: props.color }),
                cell: (row) => row.name,
              },
              {
                title: t().access,
                // the one picture of the row: who can reach it; nobody is the exception, in red with its word
                width: { min: 120, default: 148 },
                cell: (row) =>
                  row.permissionCount === 0 ? (
                    <Chip status="bad">{t().nobody}</Chip>
                  ) : (
                    // k2b-ui gap: Avatar.Stack takes no total (DP); the server sends the first three, so the rest
                    // stand as a quiet "+n" after them
                    <Inline>
                      <Avatar.Stack people={row.access.map(face)} label={t().withAccess({ count: row.permissionCount })} />
                      <Show when={row.permissionCount > row.access.length}>
                        <Text type="meta">{`+${count(row.permissionCount - row.access.length)}`}</Text>
                      </Show>
                    </Inline>
                  ),
              },
              { title: t().notes, align: "end", width: { min: 72, default: 88 }, cell: (row) => count(row.noteCount) },
              // the last column takes the rest of the row
              { title: t().lastChange, cell: (row) => lastChange(row.lastActivityAt) },
            ]}
            phone={(row) => ({
              mark: { icon: notebookSign(row.icon), color: props.color },
              lines: [
                row.name,
                row.permissionCount === 0 ? (
                  // the exception stands in the meta line, in red with its symbol and word
                  <>
                    <Icon name="lock" tone="bad" />
                    <Text tone="bad">{t().nobodyHasAccess}</Text> · {t().noteCount({ count: row.noteCount })}
                  </>
                ) : (
                  `${t().withAccess({ count: row.permissionCount })} · ${t().noteCount({ count: row.noteCount })}`
                ),
              ],
              time: lastChange(row.lastActivityAt),
            })}
            empty={
              props.search
                ? {
                    icon: "notebook",
                    text: t().noMatching({ search: props.search }),
                    action: { label: t().resetSearch, icon: "x", href: pageHref("", 1) },
                  }
                : { icon: "notebook", text: t().noNotebooks }
            }
          />
          <Show when={props.pages > 1}>
            <Bar
              start={<Text type="meta">{t().pageOf({ page: props.page, pages: props.pages })}</Text>}
              end={
                <>
                  <Button icon="chevron-left" href={pageHref(props.search, props.page - 1)} disabled={props.page <= 1}>
                    {t().previous}
                  </Button>
                  <Button href={pageHref(props.search, props.page + 1)} disabled={props.page >= props.pages} forward>
                    {t().next}
                  </Button>
                </>
              }
            />
          </Show>
        </Pane>
        <Show when={props.detail}>
          {(detail) => (
            <Pane
              detail
              label={detail().name}
              back={{ label: t().notebooks, href: listHref() }}
              head={
                <Bar
                  start={
                    // k2b-ui gap: the tinted head of the open object (DP) – sign 40, name 18, one meta line and three key
                    // facts on the app tint; until then the sign and the name stand in the head, the facts in Cells
                    <Inline>
                      <Mark icon={notebookSign(detail().icon)} color={props.color} />
                      <Text type="lead">{detail().name}</Text>
                    </Inline>
                  }
                  end={
                    <>
                      <Menu
                        label={t().actionsFor({ name: detail().name })}
                        items={[
                          { label: t().permissions, icon: "shield", onClick: () => editAccess(detail()) },
                          {
                            label: t().delete,
                            icon: "trash",
                            danger: true,
                            // the menu closes before the question; the question and the toast say the rest
                            onClick: () =>
                              void deleteNotebook({ notebookId: detail().shortId, notebookName: detail().name }, locale(), toast),
                          },
                        ]}
                      />
                      <Button variant="ghost" icon="x" label={t().close} href={listHref()} />
                    </>
                  }
                />
              }
            >
              {/* a problem stands right at the head */}
              <Show when={detail().accessTotal === 0}>
                <Notice
                  tone="bad"
                  title={t().nobodyHasAccess}
                  actions={[{ label: t().permissions, icon: "shield", onClick: () => editAccess(detail()) }]}
                >
                  {t().nobodyHasAccessText}
                </Notice>
              </Show>
              <Show when={detail().description}>
                {(description) => (
                  <Band>
                    <Text muted>{description()}</Text>
                  </Band>
                )}
              </Show>
              <Cells>
                <Cells.Cell
                  icon="pencil"
                  color={props.color}
                  label={t().changesLabel}
                  value={count(sum(detail().changesPerDay))}
                  meta={t().changesToday({ count: detail().changesPerDay.at(-1) ?? 0 })}
                  trend={{
                    values: detail().changesPerDay,
                    label: t().changesTrend({
                      name: detail().name,
                      total: sum(detail().changesPerDay),
                      today: detail().changesPerDay.at(-1) ?? 0,
                    }),
                  }}
                />
                <Cells.Cell icon="clock" label={t().lastChange} value={lastChange(detail().lastActivityAt)} />
                <Cells.Cell
                  icon="notes"
                  label={t().notes}
                  value={count(detail().noteCount)}
                  meta={t().createdOn({ date: dates.formatDate(detail().createdAt, props.dateConfig) })}
                />
              </Cells>
              {/* k2b-ui gap: from 1680 px the detail becomes two columns under one head (DR, #4340): access on the
                  left, who writes and the history on the right; until then they stand one under the other */}
              <Section
                icon="shield"
                title={t().access}
                count={count(detail().accessTotal)}
                actions={[{ label: t().permissions, icon: "shield", onClick: () => editAccess(detail()) }]}
              >
                <Show when={detail().access.length > 0} fallback={<Text muted>{t().noAccessEntries}</Text>}>
                  <For each={detail().access}>
                    {(entry) => (
                      <Row
                        {...(entry.principal.kind === "user" ? { avatar: face(entry.principal) } : {})}
                        {...(entry.principal.kind === "user"
                          ? {}
                          : { icon: entry.principal.kind === "service_account" ? "robot" : "users" })}
                        lines={[face(entry.principal).name]}
                        meta={`${kindWord(entry.principal.kind)} · ${permissionWord(entry.permission)}`}
                      />
                    )}
                  </For>
                </Show>
              </Section>
              <Section icon="users" title={t().writers} count={detail().writers.length || undefined}>
                <Show when={detail().writers.length > 0} fallback={<Text muted>{t().noWriters}</Text>}>
                  <For each={detail().writers}>
                    {(writer) => (
                      <Row
                        avatar={face(writer)}
                        lines={[writer.name]}
                        meta={t().writerChanges({ count: writer.changes })}
                        time={when(writer.lastAt)}
                      />
                    )}
                  </For>
                </Show>
              </Section>
              <Section icon="history" title={t().history}>
                <Show when={detail().history.length > 0} fallback={<Text muted>{t().noHistory}</Text>}>
                  <Digest
                    label={t().history}
                    activity={detail().history.map((entry) => ({
                      person: face(entry.actor),
                      text: (
                        <>
                          <Text weight="strong">{face(entry.actor).name}</Text>{" "}
                          {describeNoteActivity(entry.action, { self: false, locale: locale() })}
                        </>
                      ),
                      place: entry.noteTitle ?? undefined,
                      time: when(entry.at),
                    }))}
                  />
                </Show>
              </Section>
            </Pane>
          )}
        </Show>
      </Pane.Split>
    </AdminWorkspace>
  );
}
