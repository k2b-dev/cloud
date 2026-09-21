import type { LinkNavigateEvent } from "@k2b/ssr/nav";
import { AppWorkspace, Button, ButtonLink, DataTable, Format, Placeholder, prompts, StatusBadge, Tag, Tooltip, toast } from "@k2b/ui";
import { createEffect, createSignal, Show } from "solid-js";
import { apiClient } from "../api/client";
import type { SharePage, ShareView } from "../contracts";
import { baseLabel } from "./base-label";
import { useBrowserMessages } from "./browser-messages";
import { apiFailure } from "./file-preview";
import { useFilesMessages } from "./messages";
import { useSharePasswordMessages } from "./share-password-messages";
import { filesUrl } from "./urls";

/** Owners retain access to their link management even after losing access to its former storage. */
export default function SharesOverview(props: {
  shares: SharePage | ShareView[];
  baseId?: string | null;
  onNavigate?: (event: LinkNavigateEvent) => void | Promise<void>;
}) {
  const b = useBrowserMessages();
  const p = useSharePasswordMessages();
  const t = useFilesMessages();
  const page = () => (Array.isArray(props.shares) ? { items: props.shares, next: null } : props.shares);
  const [shares, setShares] = createSignal(page().items);
  const [next, setNext] = createSignal(page().next);
  createEffect(() => {
    setShares(page().items);
    setNext(page().next);
  });
  const [loading, setLoading] = createSignal(false);
  const more = async () => {
    const after = next();
    if (!after || loading()) return;
    setLoading(true);
    try {
      const response = await apiClient.shares.$get({ query: { after } });
      if (!response.ok) await apiFailure(response, b().revokeFailed);
      const result = await response.json();
      setShares((current) => [...current, ...result.items]);
      setNext(result.next);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : b().revokeFailed);
    } finally {
      setLoading(false);
    }
  };
  const [busy, setBusy] = createSignal<string | null>(null);
  const revoke = async (share: ShareView) => {
    const confirmed = await prompts.confirm(b().revokeQuestion, {
      title: b().revoke,
      icon: "ti ti-link-off",
      variant: "danger",
      confirmText: b().revoke,
    });
    if (!confirmed) return;
    setBusy(share.id);
    try {
      const response = await apiClient.shares[":id"].revoke.$post({ param: { id: share.id } });
      if (!response.ok) await apiFailure(response, b().revokeFailed);
      const updated = await response.json();
      setShares((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      toast.success(b().revoked);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : b().revokeFailed);
    } finally {
      setBusy(null);
    }
  };
  const stateBadge = (share: ShareView) =>
    share.state === "active" ? (
      <StatusBadge tone="ok" variant="text" label={b().stateActive} />
    ) : share.state === "expired" ? (
      <StatusBadge tone="neutral" variant="text" label={b().stateExpired} />
    ) : (
      <StatusBadge tone="error" variant="text" label={b().stateRevoked} />
    );
  return (
    <AppWorkspace.Main scroll class="filesv2-browser">
      <header class="filesv2-browser__header">
        <div class="min-w-0">
          <h1 class="truncate text-base font-semibold text-primary">{b().sharesTitle}</h1>
          <p class="mt-0.5 text-xs text-dimmed">{b().sharesDescription}</p>
        </div>
        <ButtonLink
          size="sm"
          variant="ghost"
          href={filesUrl(props.baseId ?? undefined)}
          navigation="enhanced"
          onNavigate={props.onNavigate}
        >
          <i class="ti ti-arrow-left" aria-hidden="true" />
          {b().backToFiles}
        </ButtonLink>
      </header>
      <Show
        when={shares().length}
        fallback={
          <Placeholder class="mx-3 flex-1" variant="panel" icon="ti ti-world-share" title={b().sharesTitle} description={b().noShares} />
        }
      >
        <DataTable
          class="mx-3 mb-3"
          rows={shares()}
          getRowId={(share) => share.id}
          density="compact"
          highlightColumns={false}
          ariaLabel={b().sharesTitle}
          columns={[
            { id: "title", header: b().shareName },
            { id: "kind", header: b().shareKind },
            { id: "scope", header: b().shareStorage },
            { id: "expires", header: b().shareExpires },
            { id: "state", header: b().shareState },
            { id: "actions", header: <span class="sr-only">{t().actions}</span>, align: "right" as const },
          ]}
          renderCell={({ row, col }) => {
            if (col.id === "title")
              return (
                <div class="flex min-w-0 flex-col">
                  <span class="truncate font-medium">
                    {row.title}{" "}
                    <Show when={row.passwordProtected}>
                      <i class="ti ti-lock" role="img" aria-label={p().protected} title={p().protected} />
                    </Show>
                  </span>
                  <span class="truncate text-xs text-dimmed">
                    {row.kind === "inbox" ? `/${row.scope}` : b().shareItems(row.items.length)} · {b().createdBy} {row.createdBy} ·{" "}
                    {b().shareAccess(row.accessCount)}
                  </span>
                </div>
              );
            if (col.id === "kind")
              return (
                <Tag size="sm" icon={row.kind === "inbox" ? "ti ti-inbox" : "ti ti-download"}>
                  {row.kind === "inbox" ? b().inboxShare : b().downloadShare}
                </Tag>
              );
            if (col.id === "scope")
              return (
                <ButtonLink
                  size="xs"
                  variant="text"
                  href={filesUrl(row.base.id, row.scope)}
                  navigation="enhanced"
                  onNavigate={props.onNavigate}
                >
                  {baseLabel(row.base, b())}
                  {row.scope ? ` / ${row.scope}` : ""}
                </ButtonLink>
              );
            if (col.id === "expires") return row.expiresAt ? <Format.DateTime value={row.expiresAt} /> : b().noExpiry;
            if (col.id === "state") return stateBadge(row);
            return (
              <div class="flex items-center justify-end gap-1">
                <Show when={row.state === "active"}>
                  <Tooltip.Anchor content={b().revoke}>
                    <Button
                      size="sm"
                      variant="ghost"
                      class="hover:text-danger"
                      loading={busy() === row.id}
                      onClick={() => void revoke(row)}
                      aria-label={b().revoke}
                    >
                      <i class="ti ti-link-off" aria-hidden="true" />
                    </Button>
                  </Tooltip.Anchor>
                </Show>
              </div>
            );
          }}
        />
      </Show>
      <Show when={next()}>
        <div class="p-3">
          <Button variant="secondary" loading={loading()} onClick={() => void more()}>
            {b().moreShares}
          </Button>
        </div>
      </Show>
    </AppWorkspace.Main>
  );
}
