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
  const [schedule, setSchedule] = createSignal<{ cron: string; timezone: string } | null>(null);
  const openSchedule = async () => {
    setFailure(null);
    const response = await apiClient.settings["sync-cron"].$get().catch(() => null);
    if (response?.ok) setSchedule(await response.json());
    else {
      setSchedule({ cron: "*/5 * * * *", timezone: "Europe/Berlin" });
      setFailure(t().scheduleLoadFailed);
    }
  };
  const saveSchedule = async () => {
    const value = schedule();
    if (!value?.cron.trim()) return;
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
  const loadGroups = (exclude: readonly string[]) => async (text: string, context: { signal: AbortSignal; limit: number }) => {
    if (!text.trim()) return { items: [] };
    const response = await apiClient.hostgroups.search.$get(
      { query: { q: text.trim(), exclude: exclude.join(",") } },
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
  const addToGroups = async (fqdn: string) => {
    const chosen = adding() ?? [];
    if (chosen.length === 0) return;
    setBusy(true);
    let ok = true;
    for (const hostgroup of chosen) {
      const response = await apiClient[":fqdn"].hostgroups.$post({ param: { fqdn }, json: { hostgroup } }).catch(() => null);
      if (!response?.ok) ok = false;
    }
    setBusy(false);
    if (!ok) return setFailure(t().failedAddGroup);
    setAdding(null);
    done();
  };

  // ── Parts ─────────────────────────────────────────────────────────────────────────────────────────────────────
  const place = (host: IpaHost) => [host.locality, host.location].filter(Boolean).join(" · ");
  const hostColumns = [
    {
      title: "FQDN",
      width: { min: 220, default: 320 },
      cell: (host: IpaHost) => ({ lines: [host.fqdn, host.description || "—"] as const }),
    },
    { title: t().location, width: { min: 140, default: 200 }, cell: (host: IpaHost) => place(host) || "—", drop: true },
    {
      title: "MAC",
      width: { min: 170, default: 190 },
      cell: (host: IpaHost) =>
        host.macAddress.length > 1 ? `${host.macAddress[0]} +${host.macAddress.length - 1}` : (host.macAddress[0] ?? "—"),
      drop: true,
    },
  ];
  const hostPhone = (host: IpaHost) => ({ lines: [host.fqdn, place(host) || host.description || "—"] as const });

  const list = () => (
    <Pane
      label={t().hosts}
      scrollKey={`ipa-hosts-${props.tab}`}
      status={
        <StatusRow
          lead={props.figures.ungrouped > 0 ? t().unassignedLead({ count: props.figures.ungrouped }) : t().assignedLead}
          facts={props.search ? [{ before: t().search, value: props.search }] : []}
          filters={
            props.figures.ungrouped > 0 ? (
              <Chip status="warn" icon="server-off">
                {t().needsAssignment}
              </Chip>
            ) : undefined
          }
        />
      }
    >
      <Cells>
        <Cells.Cell
          icon="folders"
          label={t().hostgroups}
          value={number(props.figures.groups)}
          meta={props.search ? t().filtered : t().mirroredFromIpa}
        />
        <Cells.Cell
          icon="server"
          label={t().hostsInGroups}
          value={number(props.figures.hostsInGroups)}
          meta={t().ofTotal({ total: props.figures.hostsTotal })}
        />
        <Cells.Cell
          icon={props.figures.ungrouped > 0 ? "server-off" : "check"}
          label={t().ungrouped}
          value={props.figures.ungrouped > 0 ? <Text tone="warn">{number(props.figures.ungrouped)}</Text> : "0"}
          meta={props.figures.ungrouped > 0 ? t().needsAssignment : t().allAssigned}
          href={props.figures.ungrouped > 0 && props.tab !== "ungrouped" ? href({ tab: "ungrouped", group: null, host: null }) : undefined}
        />
      </Cells>
      {/* k2b-ui gap: row mark – a table row has no mark (object symbol in its colour) before its first line */}
      <Show
        when={props.tab === "groups"}
        fallback={
          <Table
            label={t().ungroupedHosts}
            rows={props.ungrouped}
            rowKey={(host) => host.fqdn}
            sticky
            current={props.host?.fqdn}
            open={(host) => ({ href: href({ host: host.fqdn }) })}
            empty={{
              icon: props.search ? "search-off" : "check",
              text: props.search ? t().noUngroupedMatch({ query: props.search }) : t().noUngrouped,
            }}
            phone={hostPhone}
            columns={hostColumns}
          />
        }
      >
        <Table
          label={t().hostgroups}
          rows={props.groups}
          rowKey={(group) => group.cn}
          sticky
          current={openGroup() ?? undefined}
          open={(group) => ({ href: href({ group: group.cn }) })}
          empty={{
            icon: props.search ? "search-off" : "folders",
            text: props.search ? t().noGroupMatch({ query: props.search }) : t().noGroups,
          }}
          phone={(group) => ({ lines: [group.cn, group.description || t().hostCount({ count: group.hostDetails.length })] as const })}
          columns={[
            {
              title: t().name,
              width: { min: 200, default: 260 },
              cell: (group) => ({ lines: [group.cn, group.description || "—"] as const }),
            },
            {
              title: t().nested,
              width: { min: 140, default: 180 },
              cell: (group) =>
                group.hostgroups.length > 0
                  ? `${group.hostgroups[0]}${group.hostgroups.length > 1 ? ` +${group.hostgroups.length - 1}` : ""}`
                  : "—",
              drop: true,
            },
            { title: t().hosts, width: { min: 90, default: 100 }, align: "end", cell: (group) => number(group.hostDetails.length) },
          ]}
        />
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
          end={<Button variant="ghost" icon="x" label={t().close} href={href({ group: null })} />}
        />
      }
    >
      <Facts
        items={[
          { label: t().description, value: group.description || "—" },
          {
            label: t().nested,
            value: group.hostgroups.length > 0 ? <For each={group.hostgroups}>{(cn) => <Chip icon="folder">{cn}</Chip>}</For> : "—",
          },
          { label: t().hosts, value: t().hostCount({ count: group.hostDetails.length }) },
        ]}
      />
      <Bar
        end={
          <>
            <Button icon="trash" onClick={() => void deleteGroup(group.cn)}>
              {t().delete}
            </Button>
            <Button
              icon="pencil"
              onClick={() => (setFailure(null), setGroupDraft({ cn: group.cn, name: group.cn, description: group.description ?? "" }))}
            >
              {t().edit}
            </Button>
          </>
        }
      />
      <Section icon="server" title={t().hostsOfGroup}>
        <Show when={group.hostDetails.length > 0} fallback={<Empty icon="server-off" text={t().noHostsInGroup} />}>
          <List label={t().hostsOfGroup}>
            <For each={group.hostDetails}>
              {(host) => (
                <Row
                  icon="server"
                  lines={[host.fqdn, place(host) || host.description || "—"]}
                  href={href({ group: group.cn, host: host.fqdn })}
                />
              )}
            </For>
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
        head={<Bar start={<Text type="lead">{host.fqdn}</Text>} end={<Button variant="ghost" icon="x" label={t().close} href={back} />} />}
      >
        <Facts
          items={[
            { label: "FQDN", value: host.fqdn, mono: true, copy: host.fqdn },
            { label: t().description, value: host.description || "—" },
            { label: t().location, value: place(host) || "—" },
            ...host.macAddress.map((mac, index) => ({ label: t().macAddress({ number: index + 1 }), value: mac, mono: true, copy: mac })),
            ...(host.platform ? [{ label: t().platform, value: host.platform }] : []),
            ...(host.osVersion ? [{ label: t().osVersion, value: host.osVersion }] : []),
          ]}
        />
        <Bar
          end={
            <>
              <Button icon="trash" onClick={() => void deleteHost(host.fqdn)}>
                {t().delete}
              </Button>
              <Button
                icon="pencil"
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
            </>
          }
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
          onOpenChange={(open) => !open && setAdding(null)}
          foot={
            <>
              <Button onClick={() => setAdding(null)}>{t().cancel}</Button>
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
            load={loadGroups(host.memberofHostgroup)}
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
      primary={{
        label: t().newGroup,
        icon: "folder-plus",
        onClick: () => (setFailure(null), setGroupDraft({ cn: null, name: "", description: "" })),
      }}
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
                  count: props.figures.ungrouped > 0 ? number(props.figures.ungrouped) : undefined,
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
              <Button
                variant="primary"
                icon="folder-plus"
                onClick={() => (setFailure(null), setGroupDraft({ cn: null, name: "", description: "" }))}
              >
                {t().newGroup}
              </Button>
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
            <Button icon="check" busy={busy()} onClick={() => void saveSchedule()}>
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
