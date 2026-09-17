import { refreshCurrentPath } from "@k2b/ssr/nav";
import { mutation } from "@k2b/stdlib/solid";
import { Button, DataTable, InlineGuidance, Placeholder, prompts } from "@k2b/ui";
import { createSignal, onCleanup, Show } from "solid-js";
import { apiClient } from "../api/client";
import { ErrorSchema, type InventoryEntry } from "../contracts";
import { DirectoryStatus, IssueMessage } from "./feedback";
import { useFilesMessages } from "./messages";

export default function Inventory(props: { items: InventoryEntry[] }) {
  const t = useFilesMessages();
  const [confirming, setConfirming] = createSignal(false);
  const adopt = mutation.create({
    mutation: async (entry: InventoryEntry, { abortSignal }) => {
      if (!entry.identityId) throw new Error(t().adoptFailed);
      const response = await apiClient.admin.adopt.$post(
        { json: { area: entry.area, kind: entry.kind, identityId: entry.identityId } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) {
        const error = ErrorSchema.safeParse(await response.json());
        throw new Error(error.success ? error.data.message : t().adoptFailed);
      }
    },
    onSuccess: () => refreshCurrentPath(),
  });
  onCleanup(() => adopt.abort());
  const assign = async (entry: InventoryEntry) => {
    if (adopt.loading() || confirming()) return;
    setConfirming(true);
    try {
      const confirmed = await prompts.confirm(`${t().adoptDescription}\n${entry.path}`, {
        title: `${t().adopt}: ${entry.name}`,
        confirmText: t().adopt,
      });
      if (confirmed) await adopt.mutate(entry);
    } finally {
      setConfirming(false);
    }
  };
  return (
    <div class="flex min-w-0 flex-col gap-3">
      <Show when={adopt.error()}>
        {(error) => (
          <InlineGuidance tone="danger" role="alert">
            {error().message}
          </InlineGuidance>
        )}
      </Show>
      <DataTable<InventoryEntry>
        ariaLabel={t().inventory}
        rows={props.items}
        columns={[
          { id: "name", header: t().name, value: "name" },
          { id: "path", header: t().path, value: "path" },
          { id: "status", header: t().status },
          { id: "actions", header: t().actions },
        ]}
        getRowId={(row) => `${row.identityId ?? "directory"}:${row.path}`}
        empty={<Placeholder description={t().inventoryEmpty} />}
        renderCell={({ row, col }) => {
          if (col.id === "name") return <span class="break-all">{row.name}</span>;
          if (col.id === "path") return <code class="break-all text-xs">{row.path}</code>;
          if (col.id === "status")
            return (
              <div class="flex max-w-sm flex-col items-start gap-1">
                <DirectoryStatus status={row.status} />
                <Show when={row.reason}>
                  <p class="text-xs text-dimmed">
                    <IssueMessage code={row.reason} />
                  </p>
                </Show>
              </div>
            );
          return (
            <Show when={row.canAdopt && row.identityId}>
              <Button
                size="sm"
                variant="secondary"
                disabled={confirming()}
                loading={adopt.loading()}
                loadingLabel={t().assigning}
                onClick={() => void assign(row)}
              >
                {t().adopt}
              </Button>
            </Show>
          );
        }}
      />
    </div>
  );
}
