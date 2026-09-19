import { mutation, query } from "@k2b/stdlib/solid";
import { Button, DataTable, Format, InlineGuidance, Placeholder, prompts } from "@k2b/ui";
import { createSignal, onCleanup, Show } from "solid-js";
import { apiClient } from "../api/client";
import { type AdminLocator, ErrorSchema, type FileVersion } from "../contracts";
import { useAdminMessages } from "./admin-messages";
import { useFilesMessages } from "./messages";

export default function AdminVersions(props: { locator: AdminLocator; fullPath: string; name: string; onClose: () => void }) {
  const a = useAdminMessages();
  const t = useFilesMessages();
  const lifetime = new AbortController();
  const [confirming, setConfirming] = createSignal(false);
  const failure = async (response: { json: () => Promise<unknown> }) => {
    const parsed = ErrorSchema.safeParse(await response.json().catch(() => null));
    throw new Error(parsed.success && parsed.data.code !== "unavailable" ? parsed.data.message : a().actionFailed);
  };
  const versions = query.create({
    source: () => props.locator,
    load: async (locator, { abortSignal }) => {
      const response = await apiClient.admin.versions.$get({ query: locator }, { init: { signal: abortSignal } });
      if (!response.ok) return failure(response);
      return response.json();
    },
  });
  const remove = mutation.create({
    mutation: async (id: string, { abortSignal }) => {
      const response = await apiClient.admin.versions.$delete(
        { json: { ...props.locator, id, confirmPath: props.fullPath } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) await failure(response);
    },
    onSuccess: () => versions.refresh(),
  });
  onCleanup(() => {
    lifetime.abort();
    remove.abort();
  });
  const busy = () => confirming() || remove.loading();
  const confirmDelete = async (version: FileVersion) => {
    if (busy()) return;
    setConfirming(true);
    try {
      const confirmed = await prompts.form({
        title: a().deleteVersion,
        variant: "danger",
        confirmText: a().deleteVersion,
        signal: lifetime.signal,
        fields: {
          explanation: {
            type: "info",
            content: (
              <div class="space-y-2">
                <p>{a().confirmDeleteVersion}</p>
                <p>
                  <Format.DateTime value={version.created} /> · <Format.Bytes value={version.size} />
                </p>
                <code class="break-all">{version.id}</code>
              </div>
            ),
          },
          path: {
            type: "text",
            label: a().confirmPath,
            description: props.fullPath,
            required: true,
            validate: (value) => (value === props.fullPath ? null : a().pathMismatch),
          },
        },
      });
      if (confirmed && !lifetime.signal.aborted) await remove.mutate(version.id);
    } finally {
      setConfirming(false);
    }
  };
  return (
    <div class="flex min-w-0 flex-col gap-4">
      <div class="min-w-0">
        <h3 class="break-all font-semibold">{props.name}</h3>
        <p class="break-all text-sm text-dimmed">{props.fullPath}</p>
      </div>
      <InlineGuidance tone="warning" icon="ti ti-history">
        {a().versionsGuidance}
      </InlineGuidance>
      <Show when={remove.error()}>
        {(error) => (
          <InlineGuidance tone="danger" role="alert">
            {error().message}
          </InlineGuidance>
        )}
      </Show>
      <Show
        when={!versions.error()}
        fallback={
          <div class="flex flex-col items-start gap-2">
            <InlineGuidance tone="danger" role="alert">
              {versions.error()?.message}
            </InlineGuidance>
            <Button variant="secondary" onClick={() => void versions.refresh()}>
              {t().refresh}
            </Button>
          </div>
        }
      >
        <Show when={!versions.loading() || versions.data()} fallback={<Placeholder state="loading" description={a().loadingVersions} />}>
          <DataTable<FileVersion>
            surface="plain"
            density="compact"
            rows={versions.data() ?? []}
            ariaLabel={a().versions}
            columns={[
              { id: "created", header: a().versionCreated },
              { id: "size", header: t().size, align: "right" },
              { id: "comment", header: a().versionComment },
              { id: "actions", header: t().actions, align: "right" },
            ]}
            getRowId={(row) => row.id}
            empty={<Placeholder description={a().noVersions} />}
            renderCell={({ row, col }) => {
              if (col.id === "created")
                return (
                  <div>
                    <Format.DateTime value={row.created} />
                    <Show when={row.pinned}>
                      <p class="text-xs text-dimmed">{a().versionPinned}</p>
                    </Show>
                  </div>
                );
              if (col.id === "size") return <Format.Bytes value={row.size} />;
              if (col.id === "comment")
                return (
                  <div class="max-w-xs break-words">
                    {row.comment || "—"}
                    <Show when={row.author}>
                      <p class="text-xs text-dimmed">{row.author}</p>
                    </Show>
                  </div>
                );
              return (
                <Button size="sm" variant="danger" disabled={busy() || versions.loading()} onClick={() => void confirmDelete(row)}>
                  {a().deleteVersion}
                </Button>
              );
            }}
          />
        </Show>
      </Show>
      <div class="flex justify-end">
        <Button variant="secondary" onClick={props.onClose}>
          {a().close}
        </Button>
      </div>
    </div>
  );
}
