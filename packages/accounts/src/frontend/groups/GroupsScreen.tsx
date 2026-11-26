import { useLocale } from "@k2b/ui";
import { Bar, Button, Chip, FilterBar, Inline, Input, ListOrder, Mark, Notice, Pane, StatusRow, Table, Text, Workspace } from "@k2b/ui/v2";
import { createMemo, createSignal, Show } from "solid-js";
import AccountsNav from "../AccountsNav";
import { usePageSwap } from "../lib/page-swap";
import { useListMessages } from "../list-messages";
import { groupDetailMessages } from "./detail/messages";
import { groupTags, markOf } from "./group-mark";
import NewGroupDialog from "./NewGroupDialog";
import { useGroupCreated } from "./new-group";
import { GROUPS_PAGE_PATH, type GroupScope, type GroupsState, groupsHref, groupsQuery } from "./query";

/** One group as the list shows it; the server words the name and builds the link with the list's context. */
export type GroupListEntry = {
  id: string;
  name: string;
  description: string | null;
  provider: "ipa" | "local";
  posix: boolean;
  managed: boolean;
  /** A personal Linux group that belongs to one user. */
  personal?: boolean;
  href: string;
};

export type GroupsScreenProps = {
  state: GroupsState;
  defaultScope: GroupScope;
  page: number;
  pages: number;
  total: number;
  groups: GroupListEntry[];
  isAdmin: boolean;
  freeIpaEnabled: boolean;
  linuxEnabled: boolean;
  pendingRequests: number;
  /** Parameters of the address that did not apply, already worded. */
  ignored: string | null;
};

/**
 * The groups on v2: which groups and who manages them as statements, the name search in the head, one row per group.
 * Every change shows the list again from the server, which filters it with the person's access.
 */
export default function GroupsScreen(props: GroupsScreenProps) {
  const locale = useLocale();
  const t = useListMessages();
  const { showChanges, openPage } = usePageSwap();
  const groupCreated = useGroupCreated();
  // the form lives while the dialog is open: a new dialog starts empty
  const [creating, setCreating] = createSignal(false);
  const query = createMemo(() => groupsQuery(locale(), props.defaultScope));
  const personal = () => groupDetailMessages.resolve([locale()]).t.personal;
  const [state, setState] = createSignal<GroupsState>(props.state);
  const [ignored, setIgnored] = createSignal(props.ignored);
  const [refreshing, setRefreshing] = createSignal(false);
  const number = (value: number) => new Intl.NumberFormat(locale()).format(value);
  const changed = () => query().serialize(state()).toString() !== query().serialize(query().reset()).toString();

  /** The bar wrote the address; a new filter starts at page 1, and the server shows the list for it. */
  const change = (next: GroupsState) => {
    setState(next);
    setRefreshing(true);
    const params = new URLSearchParams(location.search);
    if (params.has("page") && query().serialize(next).toString() !== query().serialize(props.state).toString()) {
      params.delete("page");
      history.replaceState(history.state, "", `${location.pathname}${params.size ? `?${params}` : ""}${location.hash}`);
    }
    void showChanges();
  };
  const search = (text: string) => {
    const next = query().set(state(), "q", text.trim());
    if (next) {
      setRefreshing(true);
      void openPage(groupsHref(query(), next));
    }
  };
  const emptyText = () =>
    changed() || state().search ? t().noGroupMatches : state().filters.scope === "managed" ? t().groupsEmptyManaged : t().groupsEmptyView;

  return (
    <Workspace
      sidebar={<AccountsNav active="groups" pendingRequests={props.pendingRequests} isAdmin={props.isAdmin} />}
      head={
        <Bar
          // the relations of groups are a view inside each group's record now
          start={<Text type="body">{t().groups}</Text>}
          end={
            <>
              <Input
                type="search"
                icon="search"
                label={t().searchGroups}
                placeholder={t().searchGroups}
                value={state().search ?? ""}
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
              <Show when={props.isAdmin}>
                <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
                  {t().newGroup}
                </Button>
              </Show>
            </>
          }
        />
      }
      primary={props.isAdmin ? { label: t().newGroup, icon: "plus", onClick: () => setCreating(true) } : undefined}
    >
      <Show when={creating()}>
        <NewGroupDialog
          open
          freeIpaEnabled={props.freeIpaEnabled}
          linuxEnabled={props.linuxEnabled}
          close={(result) => {
            setCreating(false);
            if (result) void groupCreated(result);
          }}
        />
      </Show>
      <Pane
        label={t().groups}
        scrollKey="accounts-groups"
        status={
          <>
            <FilterBar
              query={query()}
              state={state()}
              onChange={change}
              icons={{ scope: "users-group", provider: "building" }}
              results={t().groupsCount({ count: number(props.total) })}
            />
            <StatusRow
              lead={t().groupsCount({ count: number(props.total) })}
              loading={refreshing()}
              filters={<ListOrder query={query()} state={state()} onChange={change} />}
            />
          </>
        }
      >
        <Show when={ignored()}>
          {(text) => (
            <Notice tone="warn" title={t().ignoredParts} actions={[{ label: t().hide, onClick: () => setIgnored(null) }]}>
              {text()}
            </Notice>
          )}
        </Show>
        <Table
          label={t().groups}
          rows={props.groups}
          rowKey={(group) => group.id}
          sticky
          open={(group) => ({ href: group.href })}
          empty={
            changed() || state().search
              ? { icon: "filter-off", text: emptyText(), action: { label: t().resetFilters, icon: "filter-off", href: GROUPS_PAGE_PATH } }
              : { icon: "users-group", text: emptyText() }
          }
          phone={(group) => ({
            lines: [group.name, group.description || t().noDescription],
            mark: markOf(group),
            marks: group.managed ? <Chip yours>{t().managed}</Chip> : undefined,
          })}
          columns={[
            {
              title: t().group,
              width: { min: 180, default: 260 },
              cell: (group) => (
                <Inline>
                  <Mark icon={markOf(group).icon} color={markOf(group).color} />
                  <Text weight="strong">{group.name}</Text>
                </Inline>
              ),
            },
            { title: t().description, width: { min: 180, default: 320 }, cell: (group) => group.description || "–", drop: true },
            {
              title: t().managedBy,
              width: { min: 100, default: 120 },
              cell: (group) => (group.provider === "ipa" ? "FreeIPA" : t().local),
              drop: true,
            },
            {
              title: t().flags,
              width: { min: 180, default: 200 },
              // at most two chips: yours, then what the group is (personal, else POSIX)
              cell: (group) => (
                <Inline>
                  <Show when={group.managed}>
                    <Chip yours>{t().managed}</Chip>
                  </Show>
                  <Show
                    when={group.personal}
                    fallback={
                      <Show when={group.posix}>
                        <Chip tag icon={groupTags.posix.icon} color={groupTags.posix.color}>
                          POSIX
                        </Chip>
                      </Show>
                    }
                  >
                    <Chip tag icon={groupTags.personal.icon} color={groupTags.personal.color}>
                      {personal()}
                    </Chip>
                  </Show>
                </Inline>
              ),
              drop: true,
            },
          ]}
        />
        <Show when={props.pages > 1}>
          <Bar
            start={<Text type="meta">{t().pageOf({ page: props.page, pages: props.pages })}</Text>}
            end={
              <>
                <Button icon="chevron-left" href={groupsHref(query(), state(), props.page - 1)} disabled={props.page <= 1}>
                  {t().previous}
                </Button>
                <Button href={groupsHref(query(), state(), props.page + 1)} disabled={props.page >= props.pages} forward>
                  {t().next}
                </Button>
              </>
            }
          />
        </Show>
      </Pane>
    </Workspace>
  );
}
