import { Button, DataTable, Format, NoticeCard, Placeholder, prompts, SettingsSection, StatusBadge, toast } from "@k2b/ui";
import { createEffect, createSignal, Show } from "solid-js";
import { apiClient } from "../api/client";
import type { SharePage } from "../contracts";
import type { AdminSnapshot } from "./admin-location";
import { useAdminMessages } from "./admin-messages";
import { useBrowserMessages } from "./browser-messages";
import { apiFailure } from "./file-preview";
import { useFilesMessages } from "./messages";

/** Grant management remains available when identities, directories or the storage backend are unavailable. */
export default function AdminShares(props: { shares: SharePage; uploads: NonNullable<AdminSnapshot["uploads"]> }) {
  const a = useAdminMessages();
  const b = useBrowserMessages();
  const t = useFilesMessages();
  const [shares, setShares] = createSignal(props.shares);
  const [uploads, setUploads] = createSignal(props.uploads);
  const [busy, setBusy] = createSignal<string | null>(null);
  createEffect(() => {
    setShares(props.shares);
    setUploads(props.uploads);
  });
  const more = async (kind: "shares" | "uploads") => {
    const after = kind === "shares" ? shares().next : uploads().next;
    if (!after || busy()) return;
    setBusy(kind);
    try {
      if (kind === "shares") {
        const response = await apiClient.admin.shares.$get({ query: { after } });
        if (!response.ok) await apiFailure(response, a().actionFailed);
        const page = await response.json();
        setShares((current) => ({ items: [...current.items, ...page.items], next: page.next }));
      } else {
        const response = await apiClient.admin.uploads.$get({ query: { after } });
        if (!response.ok) await apiFailure(response, a().actionFailed);
        const page = await response.json();
        setUploads((current) => ({ items: [...current.items, ...page.items], next: page.next }));
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : a().actionFailed);
    } finally {
      setBusy(null);
    }
  };
  const revoke = async (id: string) => {
    if (busy() || !(await prompts.confirm(b().revokeQuestion, { title: b().revoke, variant: "danger", confirmText: b().revoke }))) return;
    setBusy(id);
    try {
      const response = await apiClient.admin.shares[":id"].revoke.$post({ param: { id } });
      if (!response.ok) await apiFailure(response, b().revokeFailed);
      const updated = await response.json();
      setShares((current) => ({ ...current, items: current.items.map((item) => (item.id === id ? updated : item)) }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : b().revokeFailed);
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <SettingsSection title={b().sharesTitle}>
        <Show when={shares().items.length} fallback={<Placeholder title={b().noShares} />}>
          <DataTable
            rows={shares().items}
            getRowId={(row) => row.id}
            density="compact"
            columns={[
              { id: "title", header: b().shareName },
              { id: "owner", header: b().createdBy },
              { id: "expires", header: b().shareExpires },
              { id: "state", header: b().shareState },
              { id: "actions", header: t().actions, align: "right" as const },
            ]}
            renderCell={({ row, col }) => {
              if (col.id === "title")
                return (
                  <div class="min-w-0">
                    <div class="font-medium">{row.title}</div>
                    <div class="text-xs text-dimmed">
                      {row.base.name} · {row.kind === "inbox" ? b().inboxShare : b().downloadShare}
                    </div>
                  </div>
                );
              if (col.id === "owner") return row.createdBy;
              if (col.id === "expires") return row.expiresAt ? <Format.DateTime value={row.expiresAt} /> : b().noExpiry;
              if (col.id === "state")
                return (
                  <StatusBadge
                    tone={row.state === "active" ? "ok" : "neutral"}
                    label={row.state === "active" ? b().stateActive : row.state === "expired" ? b().stateExpired : b().stateRevoked}
                  />
                );
              return (
                <Show when={row.state !== "revoked"}>
                  <Button size="sm" variant="secondary" disabled={!!busy()} loading={busy() === row.id} onClick={() => void revoke(row.id)}>
                    {b().revoke}
                  </Button>
                </Show>
              );
            }}
          />
        </Show>
        <Show when={shares().next}>
          <Button variant="secondary" loading={busy() === "shares"} onClick={() => void more("shares")}>
            {b().moreShares}
          </Button>
        </Show>
      </SettingsSection>
      <SettingsSection title={a().unresolvedUploads}>
        <NoticeCard tone="info" title={a().reservedBudget} detail={a().unresolvedUploadsHint} />
        <Show when={uploads().items.length} fallback={<Placeholder icon="ti ti-circle-check" title={a().noUnresolvedUploads} />}>
          <DataTable
            rows={uploads().items}
            getRowId={(row) => row.id}
            density="compact"
            columns={[
              { id: "path", header: t().path },
              { id: "size", header: t().size },
              { id: "state", header: b().shareState },
              { id: "updated", header: t().modified },
            ]}
            renderCell={({ row, col }) => {
              if (col.id === "path")
                return (
                  <div class="break-all">
                    <div>{row.path}</div>
                    <code class="text-xs text-dimmed">{row.id}</code>
                  </div>
                );
              if (col.id === "size") return <Format.Bytes value={row.size} />;
              if (col.id === "updated") return <Format.DateTime value={row.updatedAt} />;
              return row.error === "storage_changed"
                ? a().uploadStorageChanged
                : row.error === "session_creation_unknown" || row.error === "opening"
                  ? a().uploadOpeningUnknown
                  : a().uploadReceiptUnknown;
            }}
          />
        </Show>
        <Show when={uploads().next}>
          <Button variant="secondary" loading={busy() === "uploads"} onClick={() => void more("uploads")}>
            {b().moreShares}
          </Button>
        </Show>
      </SettingsSection>
    </>
  );
}
