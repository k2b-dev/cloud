import { toast, useLocale } from "@k2b/ui";
import { Bar, Button, Chip, Dialog, Failed, Icon, Inline, Mark, type OnNavigate, Pane, StatusRow, Table, Text } from "@k2b/ui/v2";
import { createSignal, onCleanup, Show } from "solid-js";
import { apiClient } from "../api/client";
import type { BaseSummary, SharePage, ShareView } from "../contracts";
import { baseLabel } from "./base-label";
import { useBrowserMessages } from "./browser-messages";
import { apiFailure } from "./file-preview";
import { useMachineMessages } from "./machine-messages";
import { useSharePasswordMessages } from "./share-password-messages";
import { filesUrl } from "./urls";

/** A download link and an upload inbox each wear their own colour, so the two kinds part at a glance. */
const KIND_MARK = {
  download: { icon: "link", color: "#2563eb" },
  inbox: { icon: "inbox", color: "#0f766e" },
} as const;
const STATE = { active: "ok", expired: "warn", revoked: "bad" } as const;

/**
 * Every public link and upload inbox this person made, across storage, with what it opens, who made it, how often it
 * was used, until when it runs and its state. An owner keeps managing a link after losing access to its storage. The
 * server reads the first page; further pages add to it here.
 */
export default function SharesPane(props: {
  /** The server's first page, or null when it could not be read. */
  initial: SharePage | null;
  bases: readonly BaseSummary[];
  timeZone: string;
  onNavigate: OnNavigate;
}) {
  const b = useBrowserMessages();
  const p = useSharePasswordMessages();
  const machines = useMachineMessages();
  const locale = useLocale();
  const [page, setPage] = createSignal<SharePage | null>(props.initial);
  const [loading, setLoading] = createSignal(false);
  const [busy, setBusy] = createSignal<string | null>(null);
  const lifetime = new AbortController();
  onCleanup(() => lifetime.abort());
  const date = () => new Intl.DateTimeFormat(locale(), { dateStyle: "medium", timeZone: props.timeZone });

  /** Reads a page; `after` adds it to the loaded links, without it the list starts again. */
  const load = async (after?: string) => {
    setLoading(true);
    try {
      const response = await apiClient.shares.$get({ query: after ? { after } : {} }, { init: { signal: lifetime.signal } });
      if (!response.ok) await apiFailure(response, b().loadFailed);
      const result = await response.json();
      const before = after ? (page()?.items ?? []) : [];
      setPage({ items: [...new Map([...before, ...result.items].map((share) => [share.id, share])).values()], next: result.next });
    } catch (error) {
      if (lifetime.signal.aborted) return;
      if (after) toast.error(error instanceof Error ? error.message : b().loadFailed);
      else setPage(null);
    } finally {
      setLoading(false);
    }
  };

  const revoke = async (share: ShareView) => {
    if (busy()) return;
    const confirmed = await Dialog.confirm({
      title: b().v2RevokeTitle({ name: share.title }),
      description: b().revokeQuestion,
      confirm: b().revoke,
    });
    if (!confirmed) return;
    setBusy(share.id);
    try {
      const response = await apiClient.shares[":id"].revoke.$post({ param: { id: share.id } }, { init: { signal: lifetime.signal } });
      if (!response.ok) await apiFailure(response, b().revokeFailed);
      const updated = await response.json();
      setPage((current) => current && { ...current, items: current.items.map((item) => (item.id === updated.id ? updated : item)) });
      toast.success(b().revoked);
    } catch (error) {
      if (!lifetime.signal.aborted) toast.error(error instanceof Error ? error.message : b().revokeFailed);
    } finally {
      setBusy(null);
    }
  };

  /** The storage by its name for this person, as the sidebar names it; a storage gone from the list keeps its stored name. */
  const storage = (share: ShareView) => {
    const known = props.bases.find((base) => base.id === share.base.id);
    return known ? baseLabel(known, b(), locale()) : share.base.name;
  };
  const place = (share: ShareView) => [storage(share), ...share.scope.split("/").filter(Boolean)].join(" › ");
  const what = (share: ShareView) => (share.kind === "inbox" ? b().inboxShare : b().shareItems(share.items.length));
  const by = (share: ShareView) =>
    [share.createdByKind ? `${share.createdBy} (${machines().agent})` : share.createdBy, b().shareAccess(share.accessCount)].join(" · ");
  const expires = (share: ShareView) => (share.expiresAt ? date().format(new Date(share.expiresAt)) : b().noExpiry);
  const state = (share: ShareView) => (
    <Chip status={STATE[share.state]}>
      {share.state === "active" ? b().stateActive : share.state === "expired" ? b().stateExpired : b().stateRevoked}
    </Chip>
  );
  const active = () => page()?.items.filter((share) => share.state === "active").length ?? 0;

  return (
    <Pane
      label={b().sharesTitle}
      scrollKey="filesv2-shares"
      status={
        <StatusRow
          lead={page() ? b().v2ActiveShares({ count: active(), more: page()!.next ? "+" : "" }) : b().sharesTitle}
          loading={loading()}
        />
      }
    >
      <Show when={page()} fallback={<Failed text={b().loadFailed} onRetry={() => void load()} />}>
        {(shown) => (
          <>
            <Table
              label={b().sharesTitle}
              rows={shown().items}
              rowKey={(share) => share.id}
              // A link opens the folder it stands for; its deeds stay at the row's end.
              open={(share) => ({ href: filesUrl(share.base.id, share.scope), onNavigate: props.onNavigate })}
              empty={{ icon: "world-share", text: b().noShares }}
              phone={(share) => ({ lines: [share.title, place(share)], time: expires(share), marks: state(share) })}
              columns={[
                {
                  title: b().shareName,
                  width: { min: 220, default: 320 },
                  cell: (share) => ({
                    lines: [
                      <Inline>
                        <Mark {...KIND_MARK[share.kind]} label={share.kind === "inbox" ? b().inboxShare : b().downloadShare} />
                        <Text weight="medium">{share.title}</Text>
                        <Show when={share.passwordProtected}>
                          <Icon name="lock" label={p().protected} />
                        </Show>
                      </Inline>,
                      `${what(share)} · ${by(share)}`,
                    ],
                  }),
                },
                { title: b().v2Place, width: { min: 160, default: 240 }, drop: true, cell: place },
                { title: b().shareExpires, width: { min: 110, default: 140 }, drop: true, cell: expires },
                { title: b().shareState, width: { min: 110, default: 130 }, drop: true, cell: state },
                {
                  title: b().v2Deeds,
                  cell: (share) => (
                    <Show when={share.state === "active"}>
                      <Button
                        variant="text"
                        icon="link-off"
                        busy={busy() === share.id}
                        disabled={Boolean(busy())}
                        onClick={() => void revoke(share)}
                      >
                        {b().revoke}
                      </Button>
                    </Show>
                  ),
                },
              ]}
            />
            <Show when={shown().next}>
              {(next) => (
                <Bar
                  start={<Text type="meta">{b().v2SharesShown({ count: shown().items.length })}</Text>}
                  end={
                    <Button icon="chevron-down" busy={loading()} onClick={() => void load(next())}>
                      {b().moreShares}
                    </Button>
                  }
                />
              )}
            </Show>
          </>
        )}
      </Show>
    </Pane>
  );
}
