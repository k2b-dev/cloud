import { openAccessDialog } from "@k2b/cloud/access/ui";
import { AdminWorkspace } from "@k2b/cloud/ssr/islands";
import { navigateTo, refreshCurrentPath } from "@k2b/ssr/nav";
import { useLocale } from "@k2b/ui";
import { Bar, Button, Cells, Chip, confirm, Input, Menu, type NavProps, Pane, Table, Text, useToast } from "@k2b/ui/v2";
import { createSignal, Show } from "solid-js";
import { apiClient } from "@/api/client";
import type { AccessEntry } from "@/contracts";
import { useSpaceMessages } from "../[id]/messages";
import { adminMessages } from "../admin-messages";
import { SPACE_MARK_ICON } from "./spaces-nav";
import { readResponseError } from "../lib/response";

export type AdminSpaceRow = { id: string; name: string; description: string | null; color: string; permissionCount: number };

export type AdminSpacesProps = {
  nav: NavProps;
  rows: AdminSpaceRow[];
  search: string;
  page: number;
  totalPages: number;
  total: number;
  orphaned: number;
  accessEntries: number;
};

/**
 * Spaces in the administration on v2: every Space with its description and how many access rules reach it, the
 * Spaces nobody can reach counted in the status row, a search by name, and per Space its permissions and deletion.
 */
export default function AdminSpaces(props: AdminSpacesProps) {
  const locale = useLocale();
  const t = () => adminMessages.resolve([locale()]).t;
  const m = useSpaceMessages();
  const toast = useToast();
  const [busy, setBusy] = createSignal<string | null>(null);
  const number = (value: number) => new Intl.NumberFormat(locale()).format(value);
  const pageHref = (page: number) => {
    const params = new URLSearchParams();
    if (props.search) params.set("search", props.search);
    if (page > 1) params.set("page", String(page));
    return `/admin/spaces${params.size ? `?${params}` : ""}`;
  };

  const permissions = async (space: AdminSpaceRow) => {
    setBusy(space.id);
    try {
      const response = await apiClient.admin[":id"].access.$get({ param: { id: space.id } });
      if (!response.ok) throw new Error(await readResponseError(response, m.loadPermissionsFailed));
      const initialEntries = await response.json();
      setBusy(null);
      await openAccessDialog({
        target: { type: "spaces.space", id: space.id },
        resourceName: space.name,
        subtitle: m.accessDialogSubtitle,
        initialEntries,
        grantAccess: async (principal, permission) => {
          const granted = await apiClient.admin[":id"].access.$post({ param: { id: space.id }, json: { principal, permission } });
          if (!granted.ok) throw new Error(await readResponseError(granted, m.adminGrantAccessFailed));
          return (await granted.json()) as AccessEntry;
        },
        updateAccess: async (accessId, permission) => {
          const updated = await apiClient.admin[":id"].access[":accessId"].$patch({
            param: { id: space.id, accessId },
            json: { permission },
          });
          if (!updated.ok) throw new Error(await readResponseError(updated, m.adminUpdateAccessFailed));
        },
        revokeAccess: async (accessId) => {
          const revoked = await apiClient.admin[":id"].access[":accessId"].$delete({ param: { id: space.id, accessId } });
          if (!revoked.ok) throw new Error(await readResponseError(revoked, m.adminRevokeAccessFailed));
        },
      });
      refreshCurrentPath();
    } catch (error) {
      toast(error instanceof Error ? error.message : m.loadPermissionsFailed, { status: "bad", retry: () => void permissions(space) });
    } finally {
      setBusy(null);
    }
  };
  const remove = async (space: AdminSpaceRow) => {
    if (busy()) return;
    if (!(await confirm({ title: m.deleteSpace, description: m.adminDeleteConfirm({ name: space.name }), confirm: m.delete }))) return;
    setBusy(space.id);
    try {
      const response = await apiClient.admin[":id"].$delete({ param: { id: space.id } });
      if (!response.ok) throw new Error(await readResponseError(response, m.adminDeleteFailed));
      toast(m.spaceDeleted, { status: "ok" });
      refreshCurrentPath();
    } catch (error) {
      toast(error instanceof Error ? error.message : m.adminDeleteFailed, { status: "bad" });
    } finally {
      setBusy(null);
    }
  };

  return (
    <AdminWorkspace
      nav={props.nav}
      head={
        // The current place is the navigation's "Spaces" entry; the head holds only the search (review 26.11.).
        // k2b-ui gap: the search should be a symbol that opens over the head on click or "/"; Input has no such form.
        <Bar
          end={
            <Input
              type="search"
              icon="search"
              label={t().searchLabel}
              placeholder={t().searchPlaceholder}
              value={props.search}
              onKeyDown={(event) => {
                if (event.isComposing) return;
                const input = event.currentTarget as HTMLInputElement;
                const search = event.key === "Enter" ? input.value.trim() : event.key === "Escape" ? "" : null;
                if (search === null) return;
                navigateTo(search ? `/admin/spaces?search=${encodeURIComponent(search)}` : "/admin/spaces");
              }}
            />
          }
        />
      }
    >
      <Pane label={t().spaces} scrollKey="spaces-admin">
        {/* The one hero (identity B): how many Spaces there are, and the exception that needs the admin – Spaces nobody
            can open – in red; when every Space is reachable it says so in plain words. Spaces keeps no history of
            access or of new Spaces per day, so the figure has no trend (data gap).
            k2b-ui gap (DP, hero band): the study's band sets the figure in --t-figure 600 30/34 in the owner's ink and
            the exceptions as one line "● 2 without access" under it; Cells set the value in 600 18/24. */}
        <Cells>
          <Cells.Cell
            icon={SPACE_MARK_ICON}
            label={t().spaces}
            value={number(props.total)}
            meta={
              props.search
                ? t().shown({ shown: props.rows.length, total: props.total })
                : `${number(props.accessEntries)} ${t().accessEntries}`
            }
          />
          <Cells.Cell
            icon="lock-off"
            label={t().nobodyCanOpen}
            value={
              props.orphaned > 0 ? (
                <Chip status="bad">{t().spaceCount({ count: number(props.orphaned), one: props.orphaned === 1 })}</Chip>
              ) : (
                t().allReachable
              )
            }
            // The exception names which Spaces these are: the first ones of this page.
            meta={
              props.rows
                .filter((space) => space.permissionCount === 0)
                .slice(0, 2)
                .map((space) => space.name)
                .join(", ") || undefined
            }
          />
        </Cells>
        <Table
          label={t().spaces}
          rows={props.rows}
          rowKey={(space) => space.id}
          empty={{ icon: "layout-kanban", text: props.search ? t().noMatch({ query: props.search }) : t().noneFound }}
          phone={(space) => ({
            mark: { icon: SPACE_MARK_ICON, color: space.color },
            // A Space nobody can open says so once, in its red mark, not again as "0 access entries".
            lines:
              space.permissionCount === 0
                ? [space.name]
                : [space.name, t().accessCount({ count: space.permissionCount, shown: number(space.permissionCount) })],
            marks: space.permissionCount === 0 ? <Chip status="bad">{t().noAccess}</Chip> : undefined,
          })}
          columns={[
            {
              title: t().space,
              width: { min: 180, default: 260 },
              // Every Space carries its sign in its colour, as in the Spaces sidebar.
              mark: (space) => ({ icon: SPACE_MARK_ICON, color: space.color }),
              cell: (space) => space.name,
            },
            {
              title: t().description,
              width: { min: 200, default: 420 },
              // A Space without a description leaves the cell empty rather than repeating a grey filler.
              cell: (space) => space.description ?? "",
              drop: true,
            },
            {
              title: t().permissions,
              width: { min: 140, default: 170 },
              cell: (space) =>
                space.permissionCount === 0 ? (
                  <Chip status="bad">{t().noAccess}</Chip>
                ) : (
                  t().accessCount({ count: space.permissionCount, shown: number(space.permissionCount) })
                ),
            },
            {
              title: t().settings,
              width: { min: 64, default: 72 },
              align: "end",
              cell: (space) => (
                <Menu
                  label={m.actionsForSpace({ name: space.name })}
                  disabled={busy() === space.id}
                  items={[
                    { label: m.permissions, icon: "shield", onClick: () => void permissions(space) },
                    { label: m.delete, icon: "trash", danger: true, onClick: () => void remove(space) },
                  ]}
                />
              ),
            },
          ]}
        />
        <Show when={props.totalPages > 1}>
          <Bar
            start={<Text type="meta">{m.pageOf({ page: number(props.page), pages: number(props.totalPages) })}</Text>}
            end={
              <>
                <Button icon="chevron-left" href={pageHref(props.page - 1)} disabled={props.page <= 1}>
                  {m.previousPage}
                </Button>
                <Button href={pageHref(props.page + 1)} disabled={props.page >= props.totalPages} forward>
                  {m.nextPage}
                </Button>
              </>
            }
          />
        </Show>
      </Pane>
    </AdminWorkspace>
  );
}
