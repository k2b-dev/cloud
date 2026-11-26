import { AdminWorkspace } from "@k2b/cloud/ssr/islands";
import { navigateTo } from "@k2b/ssr/nav";
import { useLocale } from "@k2b/ui";
import type { NavProps } from "@k2b/ui/v2";
import { Bar, Button, Chip, Icon, Input, Menu, Pane, StatusRow, Table, Text, useToast } from "@k2b/ui/v2";
import { onCleanup, Show } from "solid-js";
import { notebooksAdminMessages } from "../admin-messages";
import { openNotebooksAppSettings } from "./AdminNotebooksAppSettings";
import { deleteNotebook, openPermissionDialog } from "./admin-notebook-actions";

export type AdminNotebookRow = {
  id: string;
  shortId: string;
  name: string;
  description: string | null;
  icon: string | null;
  permissionCount: number;
};

export type AdminNotebooksScreenProps = {
  nav: NavProps;
  rows: AdminNotebookRow[];
  total: number;
  page: number;
  pages: number;
  search: string;
  orphaned: number;
  permissions: number;
};

/** A notebook's sign: its own icon, or the notebooks' one; it stands in the app's colour (notebooks have none of their own). */
const notebookSign = (row: AdminNotebookRow) => (row.icon ?? "ti ti-notebook").replace(/^ti ti-/, "");

/** The address of a page of the notebooks, with the search. */
const pageHref = (search: string, page: number) => {
  const params = new URLSearchParams();
  if (search) params.set("search", search);
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return `/admin/notebooks${query ? `?${query}` : ""}`;
};

/**
 * The notebooks of the installation for administrators, on v2: the admin bar, a head with the search and the app's
 * settings, how many notebooks there are and how many nobody can reach, and the notebooks as a table with their sign,
 * description and access; each row's menu manages its access or deletes it.
 */
export default function AdminNotebooksScreen(props: AdminNotebooksScreenProps) {
  const locale = useLocale();
  const t = () => notebooksAdminMessages.resolve([locale()]).t;
  const toast = useToast();
  // an access list still loading when the page goes opens no dialog over another page
  const leaving = new AbortController();
  onCleanup(() => leaving.abort());
  /** A notebook's deeds: its access (the platform's dialog) and deleting it after asking. */
  const actions = (row: AdminNotebookRow) => (
    <Menu
      label={t().actionsFor({ name: row.name })}
      items={[
        {
          label: t().permissions,
          icon: "shield",
          // the menu stays busy while the access loads and closes as the dialog opens; a failure says why
          onClick: () =>
            openPermissionDialog({ notebookId: row.shortId, notebookName: row.name }, locale(), leaving.signal).catch(
              (error: Error) => void toast(error.message, { status: "bad" }),
            ),
        },
        {
          label: t().delete,
          icon: "trash",
          danger: true,
          // the menu closes before the question; the question and the toast say the rest
          onClick: () => void deleteNotebook({ notebookId: row.shortId, notebookName: row.name }, locale(), toast),
        },
      ]}
    />
  );
  return (
    <AdminWorkspace
      nav={props.nav}
      head={
        <Bar
          start={<Text weight="strong">{t().notebooks}</Text>}
          end={
            <>
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
      <Pane
        label={t().notebooks}
        status={
          // k2b-ui gap: StatusRow takes no toned chip, and its facts leave on the phone; the notebooks nobody can reach
          // therefore stand in the lead, which stays. Nothing found has no figures to state.
          <StatusRow
            lead={
              props.orphaned > 0
                ? t().statusNoAccess({ count: props.total, orphaned: props.orphaned })
                : t().statusNotebooks({ count: props.total })
            }
            facts={props.total > 0 ? [{ value: props.permissions, after: t().factAccessEntries }] : undefined}
          />
        }
      >
        <Table
          label={t().notebookRecords}
          rows={props.rows}
          rowKey={(row) => row.id}
          columns={[
            {
              title: t().notebook,
              cell: (row) => (
                <>
                  <Icon name={notebookSign(row)} tone="app" /> {row.name}
                </>
              ),
              width: { min: 200, default: 280 },
            },
            { title: t().description, cell: (row) => row.description || t().noDescription, drop: true },
            {
              title: t().permissions,
              // nobody can reach a notebook without access entries: that one is the exception
              cell: (row) =>
                row.permissionCount === 0 ? (
                  <Chip status="bad">{t().accessCount({ count: 0 })}</Chip>
                ) : (
                  t().accessCount({ count: row.permissionCount })
                ),
            },
            {
              title: t().actions,
              align: "end",
              cell: (row) => actions(row),
            },
          ]}
          phone={(row) => ({
            lines: [
              <>
                <Icon name={notebookSign(row)} tone="app" /> {row.name}
              </>,
              row.description || t().noDescription,
            ],
            // the phone's rows have no columns, so the deeds stand among their marks
            marks: (
              <>
                {row.permissionCount === 0 ? <Chip status="bad">{t().accessCount({ count: 0 })}</Chip> : undefined}
                {actions(row)}
              </>
            ),
          })}
          empty={{ icon: "notebook", text: props.search ? t().noMatching({ search: props.search }) : t().noNotebooks }}
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
    </AdminWorkspace>
  );
}
