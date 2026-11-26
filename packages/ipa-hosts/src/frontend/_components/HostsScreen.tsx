import { formatRelative } from "@k2b/cloud/shared";
import { AdminWorkspace } from "@k2b/cloud/ssr/islands";
import { useLocale } from "@k2b/ui";
import {
  Bar,
  Button,
  Cells,
  Chip,
  confirm,
  Dialog,
  Empty,
  Facts,
  Field,
  Input,
  List,
  Lookup,
  Menu,
  type NavProps,
  Notice,
  Pane,
  Row,
  Section,
  Table,
  Tabs,
  Text,
  useToast,
} from "@k2b/ui/v2";
import type { LookupItem } from "@k2b/ui/v2/list-query";
import { createSignal, For, Index, Show } from "solid-js";
import { apiClient } from "@/api/client";
import { type IpaHost, type IpaHostgroup, normalizeMacAddress } from "@/contracts";
import { hostMessages } from "../messages";
import { readFingerprint } from "./ssh-fingerprint";

export type HostsTab = "groups" | "ungrouped";

export type HostsScreenProps = {
  nav: NavProps;
  tab: HostsTab;
  search: string;
  /** Counts of the list (`groups`, `ungrouped` as the search shows them) and of the whole mirror for the hero. */
  figures: {
    groups: number;
    hostsTotal: number;
    ungrouped: number;
    ungroupedAll: number;
    groupsAll: number;
    lastSyncedAt: string | null;
  };
  /** The colour of the host mirror: its figures carry it inside the Administration shell. */
  accent: string;
  groups: (IpaHostgroup & { hostDetails: IpaHost[] })[];
  ungrouped: IpaHost[];
  /** Pages of the visible list: the groups or the hosts without a group. */
  paging: { page: number; pages: number };
  /**
   * The group open beside the list (`group=<cn>`), read on its own with one page of its hosts (`hosts_page`) and the
   * number of all of them; `found` is null when there is none with that name.
   */
  group: {
    cn: string;
    found: (IpaHostgroup & { hostDetails: IpaHost[]; hostTotal: number }) | null;
    paging: { page: number; pages: number };
  } | null;
  /** The host open beside the list (`host=<fqdn>`), read on its own. */
  host: { fqdn: string; found: IpaHost | null } | null;
};

const PATH = "/admin/ipa-hosts";
const MAC_ADDRESS = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/;

/**
 * Hosts on v2: the host groups mirrored from FreeIPA and the hosts without a group. A group opens beside the list with
 * its hosts; a host opens with its facts and every deed on it (edit, groups, delete). Everything comes with the first
 * HTML; the address holds the view, the search, the page and what is open.
 */
export default function HostsScreen(props: HostsScreenProps) {
  const locale = useLocale();
  const t = () => hostMessages.resolve([locale()]).t;
  const toast = useToast();
  const number = (value: number) => value.toLocaleString(locale());

  /** The address of this view with some parameters changed; open records close unless they are named. */
  const href = (change: {
    tab?: HostsTab;
    search?: string;
    page?: number;
    group?: string | null;
    host?: string | null;
    hostsPage?: number;
  }) => {
    const params = new URLSearchParams();
    const tab = change.tab ?? props.tab;
    if (tab !== "groups") params.set("tab", tab);
    const search = change.search ?? props.search;
    if (search) params.set("search", search);
    const page = change.page ?? (change.tab || change.search !== undefined ? 1 : props.paging.page);
    if (page > 1) params.set(tab === "ungrouped" ? "ungrouped_page" : "page", String(page));
    if (change.group) params.set("group", change.group);
    if (change.group && (change.hostsPage ?? 1) > 1) params.set("hosts_page", String(change.hostsPage));
    if (change.host) params.set("host", change.host);
    const text = params.toString();
    return text ? `${PATH}?${text}` : PATH;
  };
  const openGroup = () => props.group?.cn ?? null;

  // ── Deeds ─────────────────────────────────────────────────────────────────────────────────────────────────────
  const [busy, setBusy] = createSignal(false);
  const [failure, setFailure] = createSignal<string | null>(null);
  // the next picture shows what the deed did; a toast before the page is replaced would never be seen
  const done = (next?: string) => {
    if (next) location.assign(next);
    else location.reload();
  };
  const run = async (deed: () => Promise<{ ok: boolean }>, next?: string) => {
    const response = await deed().catch(() => null);
    if (!response?.ok) {
      toast(t().notDone, { status: "bad", retry: () => void run(deed, next) });
      return false;
    }
    done(next);
    return true;
  };

  const sync = async () => {
    if (!(await confirm({ title: t().runSync, description: t().syncConfirm, confirm: t().startSync }))) return;
    const response = await apiClient.sync.$post().catch(() => null);
    if (!response?.ok) {
      toast(t().notDone, { status: "bad", retry: () => void sync() });
      return;
    }
    if (await confirm({ title: t().syncStarted, description: t().syncStartedBody, confirm: t().showLogs, cancel: t().stayHere })) {
      location.assign("/admin/observability/logs?source=ipa-hosts:sync");
    }
  };

  // the sync schedule: read when its dialog opens
  const [schedule, setSchedule] = createSignal<{ cron: string; timezone: string; loaded: boolean } | null>(null);
  const openSchedule = async () => {
    setFailure(null);
    const response = await apiClient.settings["sync-cron"].$get().catch(() => null);
    if (response?.ok) setSchedule({ ...(await response.json()), loaded: true });
    else {
      // without the stored schedule there is nothing to change: saving a guess would overwrite it
      setSchedule({ cron: "", timezone: "", loaded: false });
      setFailure(t().scheduleLoadFailed);
    }
  };
  const saveSchedule = async () => {
    const value = schedule();
    if (!value?.loaded || !value.cron.trim()) return;
    setBusy(true);
    const response = await apiClient.settings["sync-cron"].$put({ json: { cron: value.cron.trim() } }).catch(() => null);
    setBusy(false);
    if (!response?.ok) return setFailure(t().failedSaveSchedule);
    setSchedule(null);
    toast(t().saved, { status: "ok" });
  };

  // a host group: new or edited, name and description
  const [groupDraft, setGroupDraft] = createSignal<{ cn: string | null; name: string; description: string } | null>(null);
  const saveGroup = async () => {
    const draft = groupDraft();
    if (!draft) return;
    if (draft.cn === null && !draft.name.trim()) return setFailure(t().failedCreateGroup);
    setBusy(true);
    const response = await (draft.cn === null
      ? apiClient.hostgroups.$post({ json: { name: draft.name.trim(), description: draft.description.trim() || undefined } })
      : apiClient.hostgroups[":cn"].$patch({ param: { cn: draft.cn }, json: { description: draft.description } })
    ).catch(() => null);
    setBusy(false);
    if (!response?.ok) return setFailure(draft.cn === null ? t().failedCreateGroup : t().failedUpdateGroup);
    setGroupDraft(null);
    done(draft.cn === null ? href({ group: draft.name.trim() }) : undefined);
  };
  const deleteGroup = async (cn: string) => {
    if (!(await confirm({ title: t().deleteGroup, description: t().deleteGroupConfirm({ name: cn }), confirm: t().delete }))) return;
    await run(() => apiClient.hostgroups[":cn"].$delete({ param: { cn } }), href({ group: null }));
  };

  // a host: description, place, MAC addresses
  const [hostDraft, setHostDraft] = createSignal<{ description: string; locality: string; location: string; macs: string[] } | null>(null);
  const [macErrors, setMacErrors] = createSignal<string[]>([]);
  const saveHost = async (fqdn: string) => {
    const draft = hostDraft();
    if (!draft) return;
    const macs = draft.macs.map((value) => normalizeMacAddress(value));
    const errors = macs.map((value, index) =>
      !value ? t().macRequired : !MAC_ADDRESS.test(value) ? t().macFormat : macs.indexOf(value) !== index ? t().duplicateMac : "",
    );
    setMacErrors(errors);
    if (errors.some(Boolean)) return;
    setBusy(true);
    const response = await apiClient[":fqdn"]
      .$patch({
        param: { fqdn },
        json: { description: draft.description, locality: draft.locality, location: draft.location, macAddress: macs },
      })
      .catch(() => null);
    setBusy(false);
    if (!response?.ok) return setFailure(t().failedUpdateHost);
    setHostDraft(null);
    done();
  };
  const deleteHost = async (fqdn: string) => {
    if (!(await confirm({ title: t().deleteHost, description: t().deleteHostConfirm({ host: fqdn }), confirm: t().delete }))) return;
    await run(() => apiClient[":fqdn"].$delete({ param: { fqdn } }), href({ host: null, group: openGroup() }));
  };
  const removeFromGroup = async (fqdn: string, group: string) => {
    const agreed = await confirm({
      title: t().removeFromGroup,
      description: t().removeFromGroupConfirm({ host: fqdn, group }),
      confirm: t().remove,
    });
    if (agreed) await run(() => apiClient[":fqdn"].hostgroups.$delete({ param: { fqdn }, json: { hostgroup: group } }));
  };
  // adding a host to groups: the groups are searched as the person types
  const [adding, setAdding] = createSignal<string[] | null>(null);
  const loadGroups = (exclude: () => readonly string[]) => async (text: string, context: { signal: AbortSignal; limit: number }) => {
    if (!text.trim()) return { items: [] };
    const response = await apiClient.hostgroups.search.$get(
      { query: { q: text.trim(), exclude: exclude().join(",") } },
      { init: { signal: context.signal } },
    );
    if (!response.ok) throw new Error(t().failedSearchGroups);
    const data = await response.json();
    return {
      items: data.hostgroups
        .slice(0, context.limit)
        .map((group): LookupItem => ({ value: group.cn, label: group.cn, meta: group.description ?? undefined })),
    };
  };
  // groups a host was added to while the dialog is open: the search no longer offers them, and closing shows them
  const [added, setAdded] = createSignal<string[]>([]);
  /**
   * Adds the host to every chosen group, one request each. Those that worked leave the choice; those that failed stay
   * chosen and are named, so "Hinzufügen" again sends only them. Closing the dialog after any success shows the result.
   */
  const addToGroups = async (fqdn: string) => {
    const chosen = adding() ?? [];
    if (chosen.length === 0) return;
    setBusy(true);
    const failed: string[] = [];
    for (const hostgroup of chosen) {
      const response = await apiClient[":fqdn"].hostgroups.$post({ param: { fqdn }, json: { hostgroup } }).catch(() => null);
      if (response?.ok) setAdded((groups) => [...groups, hostgroup]);
      else failed.push(hostgroup);
    }
    setBusy(false);
    if (failed.length === 0) {
      setAdding(null);
      return done();
    }
    setAdding(failed);
    setFailure(t().notAddedTo({ groups: failed.join(", ") }));
  };
  const closeAdding = () => {
    setAdding(null);
    if (added().length > 0) done();
  };

  // ── Parts ─────────────────────────────────────────────────────────────────────────────────────────────────────
  const place = (host: IpaHost) => [host.locality, host.location].filter(Boolean).join(" · ");
  /** A host marks only the exception, as dot and word: its client stored no SSH keys yet. */
  const hostState = (host: IpaHost) => (host.sshFingerprints.length === 0 ? <Chip status="warn">{t().noKeys}</Chip> : undefined);
  /** The second line of a host: what the mirror holds, else how many groups it is in, so every row has one height. */
  const hostLine = (host: IpaHost) =>
    [place(host), host.description, host.osVersion].filter(Boolean).join(" · ") ||
    (host.macAddress[0] ?? host.platform ?? t().memberOfCount({ count: host.memberofHostgroup.length }));
  const hostRow = (host: IpaHost, open: string) => (
    <Row icon="server" lines={[host.fqdn, hostLine(host)]} marks={hostState(host)} current={props.host?.fqdn === host.fqdn} href={open} />
  );
  /** The sub-groups in words: one or two by name, more by their number; the open group lists them all. */
  const nestedWords = (group: IpaHostgroup) =>
    group.hostgroups.length === 0
      ? ""
      : t().contains({
          what: group.hostgroups.length <= 2 ? group.hostgroups.join(", ") : t().nestedCount({ count: group.hostgroups.length }),
        });
  /** The hosts of a group whose names hold the search: a search finds a host in its groups and the row says which. */
  const foundHosts = (group: IpaHostgroup & { hostDetails: IpaHost[] }) => {
    const query = props.search.toLowerCase();
    // a group found by its own name or description needs no host to explain it
    if (!query || `${group.cn} ${group.description ?? ""}`.toLowerCase().includes(query)) return "";
    const found = group.hostDetails.filter((host) => host.fqdn.toLowerCase().includes(query)).map((host) => host.fqdn);
    if (found.length === 0) return "";
    return t().foundHosts({ names: found.length <= 2 ? found.join(", ") : t().hostCount({ count: found.length }) });
  };
  /** What a group is, in words: what a search found in it, its description and its sub-groups. */
  const groupLine = (group: IpaHostgroup & { hostDetails: IpaHost[] }) =>
    [foundHosts(group), group.description, nestedWords(group)].filter(Boolean).join(" · ");

  // a mirror that holds nothing yet: its one way on is a sync
  const emptyMirror = () => props.figures.hostsTotal === 0 && props.figures.groups === 0 && !props.search;
  /**
   * The one statement of the page with its figure: how many hosts have no group yet, the groups and the last sync. A
   * slot of its own, so the hero band of @k2b/ui (figure type) replaces it in one step. The mirror keeps no history, so
   * the hero has no trend.
   */
  const hero = () => {
    const f = props.figures;
    return (
      <Cells>
        <Cells.Cell
          icon={f.ungroupedAll > 0 ? "server-off" : "folders"}
          color={props.accent}
          label={f.ungroupedAll > 0 ? t().ungroupedLabel : t().allGroupedLabel}
          value={number(f.ungroupedAll > 0 ? f.ungroupedAll : f.hostsTotal)}
          meta={[
            t().groupCount({ count: f.groupsAll }),
            f.lastSyncedAt ? t().lastSynced({ when: formatRelative(f.lastSyncedAt, { locale: locale() }) }) : t().neverSynced,
            ...(props.search ? [t().searchFor({ query: props.search })] : []),
          ].join(" · ")}
        />
      </Cells>
    );
  };

  const list = () => (
    <Pane label={t().hosts} scrollKey={`ipa-hosts-${props.tab}`}>
      <Show when={!emptyMirror()}>{hero()}</Show>
      <Show
        when={props.tab === "groups"}
        fallback={
          <Show
            when={props.ungrouped.length > 0}
            fallback={
              <Empty
                icon={props.search ? "search-off" : "check"}
                text={props.search ? t().noUngroupedMatch({ query: props.search }) : t().noUngrouped}
              />
            }
          >
            {/* one line per host: its name, a state only where keys are missing, its place and system */}
            <Table
              label={t().ungroupedHosts}
              rows={props.ungrouped}
              rowKey={(host) => host.fqdn}
              sticky
              current={props.host?.fqdn}
              open={(host) => ({ href: href({ host: host.fqdn }) })}
              phone={(host) => ({ lines: [host.fqdn, hostLine(host)], marks: hostState(host) })}
              columns={[
                { title: t().host, width: { min: 200, default: 260 }, cell: (host) => host.fqdn },
                { title: t().state, width: { min: 130, default: 130 }, cell: (host: IpaHost) => hostState(host) ?? "" },
                { title: t().location, width: { min: 140, default: 180 }, cell: (host) => place(host) || "–", drop: true },
                ...(props.host
                  ? []
                  : [
                      {
                        title: t().platform,
                        width: { min: 140, default: 180 },
                        cell: (host: IpaHost) => [host.osVersion, host.platform].filter(Boolean).join(" · ") || "–",
                        drop: true,
                      },
                    ]),
              ]}
            />
          </Show>
        }
      >
        <Show
          when={props.groups.length > 0}
          fallback={
            <Empty
              icon={props.search ? "search-off" : "folders"}
              text={
                props.search ? t().noGroupMatch({ query: props.search }) : props.figures.hostsTotal === 0 ? t().syncToFill : t().noGroups
              }
              // the empty state holds its way on: an empty mirror is filled by a sync, a mirror without groups gets its first
              action={
                props.search
                  ? undefined
                  : emptyMirror()
                    ? { label: t().syncNow, icon: "refresh", onClick: () => void sync() }
                    : {
                        label: t().newGroup,
                        icon: "folder-plus",
                        onClick: () => (setFailure(null), setGroupDraft({ cn: null, name: "", description: "" })),
                      }
              }
            />
          }
        >
          {/* one line per group: its name, its number of hosts aligned on the right, what it is in words */}
          <Table
            label={t().hostgroups}
            rows={props.groups}
            rowKey={(group) => group.cn}
            sticky
            // the open group, or the first group of the open host: the list shows where the detail belongs
            current={openGroup() ?? props.host?.found?.memberofHostgroup[0]}
            open={(group) => ({ href: href({ group: group.cn }) })}
            phone={(group) => ({
              // without words of its own, a group names its first hosts; the number stands right already
              lines: [
                group.cn,
                groupLine(group) ||
                  group.hostDetails
                    .slice(0, 3)
                    .map((host) => host.fqdn)
                    .join(", ") ||
                  t().noHostsInGroup,
              ],
              time: t().hostCount({ count: group.hostDetails.length }),
            })}
            columns={[
              { title: t().hostgroup, width: { min: 180, default: 240 }, cell: (group) => group.cn },
              {
                title: t().hosts,
                width: { min: 80, default: 90 },
                align: "end",
                cell: (group) => number(group.hostDetails.length),
              },
              // what a group is, in words, while nothing stands open beside the table; the open group says it itself
              ...(props.group || props.host
                ? []
                : [
                    {
                      title: t().description,
                      width: { min: 180, default: 360 },
                      cell: (group: IpaHostgroup & { hostDetails: IpaHost[] }) => groupLine(group) || "–",
                      drop: true,
                    },
                  ]),
            ]}
          />
        </Show>
      </Show>
      <Show when={props.paging.pages > 1}>
        <Bar
          start={<Text type="meta">{`${number(props.paging.page)} / ${number(props.paging.pages)}`}</Text>}
          end={
            <>
              <Button
                icon="chevron-left"
                href={href({ page: props.paging.page - 1 })}
                disabled={props.paging.page <= 1}
                label={t().previous}
              />
              <Button
                icon="chevron-right"
                href={href({ page: props.paging.page + 1 })}
                disabled={props.paging.page >= props.paging.pages}
                label={t().next}
              />
            </>
          }
        />
      </Show>
    </Pane>
  );

  const groupRecord = (group: IpaHostgroup & { hostDetails: IpaHost[]; hostTotal: number }, paging: { page: number; pages: number }) => (
    <Pane
      detail
      label={group.cn}
      back={{ label: t().hostgroups, href: href({ group: null }) }}
      head={
        <Bar
          start={<Text type="lead">{group.cn}</Text>}
          end={
            <>
              <Menu
                label={t().moreActionsFor({ name: group.cn })}
                items={[{ label: t().delete, icon: "trash", danger: true, onClick: () => void deleteGroup(group.cn) }]}
              />
              <Button
                icon="pencil"
                keep
                onClick={() => (setFailure(null), setGroupDraft({ cn: group.cn, name: group.cn, description: group.description ?? "" }))}
              >
                {t().edit}
              </Button>
              <Button variant="ghost" icon="x" label={t().close} href={href({ group: null })} />
            </>
          }
        />
      }
    >
      <Show when={group.description || group.hostgroups.length > 0}>
        <Section icon="settings" title={t().details}>
          <Facts
            items={[
              ...(group.description ? [{ label: t().description, value: group.description }] : []),
              ...(group.hostgroups.length > 0 ? [{ label: t().nested, value: group.hostgroups.join(", ") }] : []),
            ]}
          />
        </Section>
      </Show>
      <Section icon="server" title={t().hostsOfGroup} count={number(group.hostTotal)}>
        <Show when={group.hostDetails.length > 0} fallback={<Empty icon="server-off" text={t().noHostsInGroup} />}>
          <List label={t().hostsOfGroup}>
            <For each={group.hostDetails}>
              {(host) => hostRow(host, href({ group: group.cn, host: host.fqdn, hostsPage: paging.page }))}
            </For>
          </List>
        </Show>
        <Show when={paging.pages > 1}>
          <Bar
            start={<Text type="meta">{`${number(paging.page)} / ${number(paging.pages)}`}</Text>}
            end={
              <>
                <Button
                  icon="chevron-left"
                  href={href({ group: group.cn, hostsPage: paging.page - 1 })}
                  disabled={paging.page <= 1}
                  label={t().previous}
                />
                <Button
                  icon="chevron-right"
                  href={href({ group: group.cn, hostsPage: paging.page + 1 })}
                  disabled={paging.page >= paging.pages}
                  label={t().next}
                />
              </>
            }
          />
        </Show>
      </Section>
    </Pane>
  );

  const hostRecord = (host: IpaHost) => {
    // back to the group's page this host was opened from
    const back = openGroup() ? href({ group: openGroup(), host: null, hostsPage: props.group?.paging.page }) : href({ host: null });
    return (
      <Pane
        detail
        label={host.fqdn}
        back={{ label: openGroup() ?? (props.tab === "groups" ? t().hostgroups : t().ungroupedHosts), href: back }}
        head={
          <Bar
            start={<Text type="lead">{host.fqdn}</Text>}
            end={
              <>
                <Menu
                  label={t().moreActionsFor({ name: host.fqdn })}
                  items={[{ label: t().delete, icon: "trash", danger: true, onClick: () => void deleteHost(host.fqdn) }]}
                />
                <Button
                  icon="pencil"
                  keep
                  onClick={() => {
                    setFailure(null);
                    setMacErrors([]);
                    setHostDraft({
                      description: host.description ?? "",
                      locality: host.locality ?? "",
                      location: host.location ?? "",
                      macs: [...host.macAddress],
                    });
                  }}
                >
                  {t().edit}
                </Button>
                <Button variant="ghost" icon="x" label={t().close} href={back} />
              </>
            }
          />
        }
      >
        <Show when={host.sshFingerprints.length === 0}>
          <Notice tone="warn" title={t().noKeysTitle}>
            {t().noKeysText}
          </Notice>
        </Show>
        <Cells>
          <Cells.Cell
            icon="folders"
            label={t().memberOf}
            value={number(host.memberofHostgroup.length)}
            meta={host.memberofHostgroup.slice(0, 2).join(", ") || t().noGroupYet}
          />
          <Cells.Cell
            icon="key"
            label={t().sshKeys}
            value={number(host.sshFingerprints.length)}
            meta={
              [...new Set(host.sshFingerprints.map((fingerprint) => readFingerprint(fingerprint).type).filter(Boolean))].join(", ") ||
              t().noKeys
            }
          />
          <Cells.Cell
            icon="network"
            label={t().macAddressesLabel}
            value={number(host.macAddress.length)}
            meta={host.macAddress[0] ?? t().noMac}
          />
        </Cells>
        <Section icon="settings" title={t().details}>
          <Facts
            items={[
              ...(host.description ? [{ label: t().description, value: host.description }] : []),
              ...(place(host) ? [{ label: t().location, value: place(host) }] : []),
              ...(host.platform || host.osVersion
                ? [{ label: t().platform, value: [host.osVersion, host.platform].filter(Boolean).join(" · ") }]
                : []),
              ...host.macAddress.map((mac, index) => ({
                label: index === 0 ? t().macAddressesLabel : "",
                value: mac,
                mono: true,
                copy: mac,
              })),
            ]}
          />
        </Section>
        <Section
          icon="folders"
          title={t().memberOf}
          actions={
            host.memberofHostgroup.length > 0
              ? [{ label: t().addToGroup, icon: "folder-plus", onClick: () => (setFailure(null), setAdding([])) }]
              : undefined
          }
        >
          <Show
            when={host.memberofHostgroup.length > 0}
            fallback={
              <Empty
                icon="folder-off"
                text={t().noGroupYet}
                action={{ label: t().addToGroup, icon: "folder-plus", onClick: () => (setFailure(null), setAdding([])) }}
              />
            }
          >
            <List label={t().memberOf}>
              <For each={host.memberofHostgroup}>
                {(cn) => (
                  <Row
                    icon="folders"
                    lines={[cn]}
                    href={href({ group: cn })}
                    end={
                      <Button variant="ghost" icon="folder-minus" onClick={() => void removeFromGroup(host.fqdn, cn)}>
                        {t().remove}
                      </Button>
                    }
                  />
                )}
              </For>
            </List>
          </Show>
        </Section>
        <Show when={host.sshFingerprints.length > 0}>
          <Section icon="key" title={t().sshFingerprints}>
            {/* k2b-ui gap: Facts mono breaks an ID or hash at any sign; IDs need one line with an ellipsis and copy (DP). */}
            <Facts
              items={host.sshFingerprints.map((fingerprint) => {
                const key = readFingerprint(fingerprint);
                return {
                  label: key.type ?? t().sshKey,
                  value: key.comment ? (
                    <>
                      {key.hash} <Text muted>{key.comment}</Text>
                    </>
                  ) : (
                    key.hash
                  ),
                  mono: true,
                  copy: key.hash,
                };
              })}
            />
          </Section>
        </Show>
        <Dialog
          title={t().addToGroup}
          open={adding() !== null}
          onOpenChange={(open) => !open && closeAdding()}
          foot={
            <>
              <Button onClick={closeAdding}>{t().cancel}</Button>
              <Button
                variant="primary"
                icon="folder-plus"
                busy={busy()}
                disabled={(adding() ?? []).length === 0}
                onClick={() => void addToGroups(host.fqdn)}
              >
                {t().add}
              </Button>
            </>
          }
        >
          <Show when={failure()}>{(text) => <Notice tone="bad">{text()}</Notice>}</Show>
          <Lookup
            label={t().searchGroups}
            value={adding() ?? []}
            onChange={setAdding}
            load={loadGroups(() => [...host.memberofHostgroup, ...added()])}
            minChars={1}
          />
        </Dialog>
        <Dialog
          title={t().editNamed({ name: host.fqdn })}
          open={hostDraft() !== null}
          onOpenChange={(open) => !open && setHostDraft(null)}
          foot={
            <>
              <Button onClick={() => setHostDraft(null)}>{t().cancel}</Button>
              <Button variant="primary" icon="check" busy={busy()} onClick={() => void saveHost(host.fqdn)}>
                {t().save}
              </Button>
            </>
          }
        >
          <Show when={failure()}>{(text) => <Notice tone="bad">{text()}</Notice>}</Show>
          <Field label={t().description}>
            <Input
              value={hostDraft()?.description ?? ""}
              placeholder={t().optionalDescription}
              onInput={(value) => setHostDraft((draft) => draft && { ...draft, description: value })}
            />
          </Field>
          <Field label={t().locality}>
            <Input
              value={hostDraft()?.locality ?? ""}
              placeholder={t().localityPlaceholder}
              onInput={(value) => setHostDraft((draft) => draft && { ...draft, locality: value })}
            />
          </Field>
          <Field label={t().location}>
            <Input
              value={hostDraft()?.location ?? ""}
              placeholder={t().locationPlaceholder}
              onInput={(value) => setHostDraft((draft) => draft && { ...draft, location: value })}
            />
          </Field>
          <Index each={hostDraft()?.macs ?? []}>
            {(mac, index) => (
              <Field label={t().macAddress({ number: index + 1 })} error={macErrors()[index] || undefined}>
                <Input
                  value={mac()}
                  placeholder="AA:BB:CC:DD:EE:FF"
                  onInput={(value) =>
                    setHostDraft((draft) => draft && { ...draft, macs: draft.macs.map((entry, at) => (at === index ? value : entry)) })
                  }
                  end={
                    <Button
                      variant="ghost"
                      icon="trash"
                      label={t().removeMac({ number: index + 1 })}
                      onClick={() => setHostDraft((draft) => draft && { ...draft, macs: draft.macs.filter((_, at) => at !== index) })}
                    />
                  }
                />
              </Field>
            )}
          </Index>
          <Text type="meta" muted>
            {(hostDraft()?.macs.length ?? 0) === 0 ? t().noMac : t().macHint}
          </Text>
          <Bar
            end={
              <Button icon="plus" onClick={() => setHostDraft((draft) => draft && { ...draft, macs: [...draft.macs, ""] })}>
                {t().addMac}
              </Button>
            }
          />
        </Dialog>
      </Pane>
    );
  };

  const missing = (text: string) => (
    <Pane detail label={text} back={{ label: t().hosts, href: href({ group: null, host: null }) }}>
      <Empty icon="file-off" text={text} action={{ label: t().hosts, href: href({ group: null, host: null }) }} />
    </Pane>
  );

  return (
    <AdminWorkspace
      nav={props.nav}
      detail={props.group || props.host ? 460 : undefined}
      // the main action follows what is open: a host takes groups, the groups view takes a new group, the rest none
      // the main action follows what is open: an empty mirror is filled by a sync, the groups view takes a new group;
      // an open host takes groups in its own section, so the phone shows one way to add, not two
      primary={
        emptyMirror()
          ? undefined
          : props.tab === "groups" && !props.group && !props.host
            ? {
                label: t().newGroup,
                icon: "folder-plus",
                onClick: () => (setFailure(null), setGroupDraft({ cn: null, name: "", description: "" })),
              }
            : undefined
      }
      head={
        <Bar
          start={
            <Tabs
              label={t().views}
              items={[
                {
                  label: t().hostgroups,
                  icon: "folders",
                  href: href({ tab: "groups", group: null, host: null }),
                  count: props.figures.groupsAll,
                  current: props.tab === "groups",
                },
                {
                  label: t().ungrouped,
                  icon: "server-off",
                  href: href({ tab: "ungrouped", group: null, host: null }),
                  count: props.figures.ungroupedAll,
                  current: props.tab === "ungrouped",
                },
              ]}
            />
          }
          end={
            <>
              <Input
                type="search"
                icon="search"
                label={t().searchLabel}
                placeholder={t().search}
                value={props.search}
                onKeyDown={(event) => {
                  if (event.isComposing) return;
                  const input = event.currentTarget as HTMLInputElement;
                  if (event.key === "Enter") location.assign(href({ search: input.value.trim(), group: null, host: null }));
                  if (event.key === "Escape" && input.value) location.assign(href({ search: "", group: null, host: null }));
                }}
              />
              {/* the head keeps the search and the one create action; syncing is rarer and waits in "…" */}
              <Menu
                label={t().moreActions}
                items={[
                  { label: t().syncNow, icon: "refresh", onClick: () => void sync() },
                  { label: t().syncSettings, icon: "settings", onClick: () => void openSchedule() },
                ]}
              />
              {/* an empty mirror's way on stands in its empty state, not a second time in the head */}
              <Show when={!emptyMirror() && props.tab === "groups" && !props.group && !props.host}>
                <Button
                  variant="primary"
                  icon="folder-plus"
                  onClick={() => (setFailure(null), setGroupDraft({ cn: null, name: "", description: "" }))}
                >
                  {t().newGroup}
                </Button>
              </Show>
            </>
          }
        />
      }
    >
      <Pane.Split>
        {list()}
        <Show when={props.host}>
          {(open) => (
            <Show when={open().found} fallback={missing(t().hostNotFound)}>
              {(host) => hostRecord(host())}
            </Show>
          )}
        </Show>
        <Show when={!props.host && props.group}>
          {(open) => (
            <Show when={open().found} fallback={missing(t().groupNotFound)}>
              {(group) => groupRecord(group(), open().paging)}
            </Show>
          )}
        </Show>
      </Pane.Split>
      <Dialog
        title={groupDraft()?.cn ? t().editNamed({ name: groupDraft()?.cn ?? "" }) : t().newGroup}
        open={groupDraft() !== null}
        onOpenChange={(open) => !open && setGroupDraft(null)}
        foot={
          <>
            <Button onClick={() => setGroupDraft(null)}>{t().cancel}</Button>
            <Button variant="primary" icon="check" busy={busy()} onClick={() => void saveGroup()}>
              {groupDraft()?.cn ? t().save : t().create}
            </Button>
          </>
        }
      >
        <Show when={failure()}>{(text) => <Notice tone="bad">{text()}</Notice>}</Show>
        <Show when={groupDraft()?.cn === null}>
          <Field label={t().name}>
            <Input
              value={groupDraft()?.name ?? ""}
              placeholder={t().groupNamePlaceholder}
              onInput={(value) => setGroupDraft((draft) => draft && { ...draft, name: value })}
            />
          </Field>
        </Show>
        <Field label={t().description}>
          <Input
            multiline
            value={groupDraft()?.description ?? ""}
            placeholder={t().optionalDescription}
            onInput={(value) => setGroupDraft((draft) => draft && { ...draft, description: value })}
          />
        </Field>
      </Dialog>
      <Dialog
        title={t().syncSettings}
        open={schedule() !== null}
        onOpenChange={(open) => !open && setSchedule(null)}
        foot={
          <>
            <Button onClick={() => setSchedule(null)}>{t().cancel}</Button>
            <Button variant="primary" icon="check" busy={busy()} disabled={!schedule()?.loaded} onClick={() => void saveSchedule()}>
              {t().save}
            </Button>
          </>
        }
      >
        <Show when={failure()}>{(text) => <Notice tone="bad">{text()}</Notice>}</Show>
        <Field label={t().syncSchedule} hint={t().syncScheduleDescription({ timezone: schedule()?.timezone ?? "" })}>
          <Input
            value={schedule()?.cron ?? ""}
            placeholder="*/5 * * * *"
            onInput={(cron) => setSchedule((value) => value && { ...value, cron })}
          />
        </Field>
      </Dialog>
    </AdminWorkspace>
  );
}
