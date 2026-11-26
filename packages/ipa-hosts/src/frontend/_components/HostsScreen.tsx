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
  type NavProps,
  Notice,
  Pane,
  Row,
  Section,
  StatusRow,
  Tabs,
  Text,
  useToast,
} from "@k2b/ui/v2";
import type { LookupItem } from "@k2b/ui/v2/list-query";
import { createSignal, For, Index, Show } from "solid-js";
import { apiClient } from "@/api/client";
import { type IpaHost, type IpaHostgroup, normalizeMacAddress } from "@/contracts";
import { hostMessages } from "../messages";

export type HostsTab = "groups" | "ungrouped";

export type HostsScreenProps = {
  nav: NavProps;
  tab: HostsTab;
  search: string;
  figures: { groups: number; hostsInGroups: number; hostsTotal: number; ungrouped: number };
  groups: (IpaHostgroup & { hostDetails: IpaHost[] })[];
  ungrouped: IpaHost[];
  /** Pages of the visible list: the groups or the hosts without a group. */
  paging: { page: number; pages: number };
  /** The group open beside the list (`group=<cn>`), read on its own; null when there is none with that name. */
  group: { cn: string; found: (IpaHostgroup & { hostDetails: IpaHost[] }) | null } | null;
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
  const href = (change: { tab?: HostsTab; search?: string; page?: number; group?: string | null; host?: string | null }) => {
    const params = new URLSearchParams();
    const tab = change.tab ?? props.tab;
    if (tab !== "groups") params.set("tab", tab);
    const search = change.search ?? props.search;
    if (search) params.set("search", search);
    const page = change.page ?? (change.tab || change.search !== undefined ? 1 : props.paging.page);
    if (page > 1) params.set(tab === "ungrouped" ? "ungrouped_page" : "page", String(page));
    if (change.group) params.set("group", change.group);
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
  /** A group's own colour, the same on every visit: its mark in lists and records. */
  const PALETTE = ["#2563eb", "#0d9488", "#7c3aed", "#db2777", "#ea580c", "#16a34a", "#0891b2", "#ca8a04"];
  const groupColor = (cn: string) => PALETTE[[...cn].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 7) % PALETTE.length];
  /** A row marks only the exception: a host whose client stored no SSH keys yet (symbol and word). */
  const hostState = (host: IpaHost) => (host.sshFingerprints.length === 0 ? <Chip icon="key-off">{t().noKeys}</Chip> : undefined);
  /** The second line of a host: only what the mirror holds. */
  const hostLine = (host: IpaHost) =>
    [place(host), host.description, host.osVersion].filter(Boolean).join(" · ") || (host.macAddress[0] ?? host.platform ?? "");
  const hostRow = (host: IpaHost, open: string) => (
    <Row
      icon="server"
      lines={hostLine(host) ? [host.fqdn, hostLine(host)] : [host.fqdn]}
      marks={hostState(host)}
      current={props.host?.fqdn === host.fqdn}
      href={open}
    />
  );
  /** A row names one short sub-group; several or long ones it counts, and the open group lists them all. */
  const nestedChips = (group: IpaHostgroup) =>
    group.hostgroups.length === 1 && group.hostgroups[0]!.length <= 18 ? (
      <Chip icon="folder">{group.hostgroups[0]}</Chip>
    ) : (
      <Chip icon="folders">{t().nestedCount({ count: group.hostgroups.length })}</Chip>
    );

  const list = () => (
    <Pane
      label={t().hosts}
      scrollKey={`ipa-hosts-${props.tab}`}
      status={
        <StatusRow
          lead={
            props.figures.hostsTotal === 0 && props.figures.groups === 0
              ? t().emptyLead
              : props.figures.ungrouped > 0
                ? t().unassignedLead({ count: props.figures.ungrouped })
                : t().assignedLead
          }
          facts={props.search ? [{ before: t().search, value: props.search }] : []}
        />
      }
    >
      {/* the figures say what the lead does not; an empty mirror has nothing to count */}
      <Show when={props.figures.hostsTotal > 0 || props.figures.groups > 0}>
        <Cells>
          <Cells.Cell
            icon="folders"
            label={t().hostgroups}
            value={number(props.figures.groups)}
            meta={props.search ? t().filtered : t().mirroredFromIpa}
          />
          <Cells.Cell
            icon="server"
            label={t().hosts}
            value={number(props.figures.hostsTotal)}
            meta={t().inGroups({ count: props.figures.hostsInGroups })}
          />
        </Cells>
      </Show>
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
            <List label={t().ungroupedHosts}>
              <For each={props.ungrouped}>{(host) => hostRow(host, href({ host: host.fqdn }))}</For>
            </List>
          </Show>
        }
      >
        <Show
          when={props.groups.length > 0}
          fallback={
            <Empty
              icon={props.search ? "search-off" : "folders"}
              text={props.search ? t().noGroupMatch({ query: props.search }) : t().noGroups}
              // an empty mirror is filled by the first sync
              action={props.search ? undefined : { label: t().syncNow, icon: "refresh", onClick: () => void sync() }}
            />
          }
        >
          <List label={t().hostgroups}>
            <For each={props.groups}>
              {(group) => (
                <Row
                  icon="folders"
                  color={groupColor(group.cn)}
                  lines={group.description ? [group.cn, group.description] : [group.cn]}
                  time={t().hostCount({ count: group.hostDetails.length })}
                  marks={group.hostgroups.length > 0 ? nestedChips(group) : undefined}
                  current={openGroup() === group.cn && !props.host}
                  href={href({ group: group.cn })}
                />
              )}
            </For>
          </List>
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

  const groupRecord = (group: IpaHostgroup & { hostDetails: IpaHost[] }) => (
    <Pane
      detail
      label={group.cn}
      back={{ label: t().hostgroups, href: href({ group: null }) }}
      head={
        <Bar
          start={<Text type="lead">{group.cn}</Text>}
          end={
            <>
              <Button icon="trash" onClick={() => void deleteGroup(group.cn)}>
                {t().delete}
              </Button>
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
      <Facts
        items={[
          ...(group.description ? [{ label: t().description, value: group.description }] : []),
          { label: t().hosts, value: t().hostCount({ count: group.hostDetails.length }) },
          ...(group.hostgroups.length > 0
            ? [{ label: t().nested, value: <For each={group.hostgroups}>{(cn) => <Chip icon="folder">{cn}</Chip>}</For> }]
            : []),
        ]}
      />
      <Section icon="server" title={t().hostsOfGroup}>
        <Show when={group.hostDetails.length > 0} fallback={<Empty icon="server-off" text={t().noHostsInGroup} />}>
          <List label={t().hostsOfGroup}>
            <For each={group.hostDetails}>{(host) => hostRow(host, href({ group: group.cn, host: host.fqdn }))}</For>
          </List>
        </Show>
      </Section>
    </Pane>
  );

  const hostRecord = (host: IpaHost) => {
    const back = openGroup() ? href({ group: openGroup(), host: null }) : href({ host: null });
    return (
      <Pane
        detail
        label={host.fqdn}
        back={{ label: openGroup() ?? t().ungroupedHosts, href: back }}
        head={
          <Bar
            start={<Text type="lead">{host.fqdn}</Text>}
            end={
              <>
                <Button icon="trash" onClick={() => void deleteHost(host.fqdn)}>
                  {t().delete}
                </Button>
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
        <Facts
          items={[
            { label: "FQDN", value: host.fqdn, copy: host.fqdn },
            { label: t().sshKeys, value: host.sshFingerprints.length > 0 ? t().keysStored : t().noKeys },
            ...(host.description ? [{ label: t().description, value: host.description }] : []),
            ...(place(host) ? [{ label: t().location, value: place(host) }] : []),
            ...(host.platform || host.osVersion
              ? [{ label: t().platform, value: [host.osVersion, host.platform].filter(Boolean).join(" · ") }]
              : []),
            ...(host.macAddress.length > 0
              ? [{ label: t().macAddressesLabel, value: <For each={host.macAddress}>{(mac) => <Chip icon="network">{mac}</Chip>}</For> }]
              : []),
          ]}
        />
        <Section
          icon="folders"
          title={t().memberOf}
          actions={[{ label: t().addToGroup, icon: "folder-plus", onClick: () => (setFailure(null), setAdding([])) }]}
        >
          <Show when={host.memberofHostgroup.length > 0} fallback={<Notice tone="warn">{t().withoutGroup}</Notice>}>
            <List label={t().memberOf}>
              <For each={host.memberofHostgroup}>
                {(cn) => (
                  <Row
                    icon="folder"
                    lines={[cn]}
                    href={href({ group: cn })}
                    end={
                      <Button
                        variant="ghost"
                        icon="folder-minus"
                        label={t().removeFromGroup}
                        onClick={() => void removeFromGroup(host.fqdn, cn)}
                      />
                    }
                  />
                )}
              </For>
            </List>
          </Show>
        </Section>
        <Show when={host.sshFingerprints.length > 0}>
          <Section icon="key" title={t().sshFingerprints}>
            <Facts
              items={host.sshFingerprints.map((fingerprint, index) => ({
                label: String(index + 1),
                value: fingerprint,
                mono: true,
                copy: fingerprint,
              }))}
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
              <Button icon="folder-plus" busy={busy()} disabled={(adding() ?? []).length === 0} onClick={() => void addToGroups(host.fqdn)}>
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
              <Button icon="check" busy={busy()} onClick={() => void saveHost(host.fqdn)}>
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
      primary={
        props.host?.found
          ? { label: t().addToGroup, icon: "folder-plus", onClick: () => (setFailure(null), setAdding([])) }
          : props.tab === "groups" && !props.group
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
                  current: props.tab === "groups",
                },
                {
                  label: t().ungrouped,
                  icon: "server-off",
                  href: href({ tab: "ungrouped", group: null, host: null }),
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
              <Button variant="ghost" icon="refresh" label={t().syncNow} onClick={() => void sync()} />
              <Button variant="ghost" icon="settings" label={t().syncSettings} onClick={() => void openSchedule()} />
              <Show when={props.tab === "groups" && !props.group && !props.host}>
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
              {(group) => groupRecord(group())}
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
            <Button icon="check" busy={busy()} onClick={() => void saveGroup()}>
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
            <Button icon="check" busy={busy()} disabled={!schedule()?.loaded} onClick={() => void saveSchedule()}>
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
