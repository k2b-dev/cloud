import { mutation } from "@k2b/stdlib/solid";
import { Button, InlineGuidance, prompts } from "@k2b/ui";
import { createSignal, onCleanup, Show } from "solid-js";
import { apiClient } from "../api/client";
import { type AdminBrowseResult, type ArchiveEntry, ErrorSchema, type FileEntry, type InventoryEntry } from "../contracts";
import AdminIssue from "./AdminIssue";
import type { AdminLocation, AdminSnapshot } from "./admin-location";
import { useAdminMessages } from "./admin-messages";
import { DirectoryStatus } from "./feedback";
import type { DirectoryAction } from "./Inventory";
import { useFilesMessages } from "./messages";

type ResponseLike = { ok: boolean; json: () => Promise<unknown> };
export function createAdminActions(props: { snapshot: () => AdminSnapshot; location: () => AdminLocation; refresh: () => Promise<void> }) {
  const a = useAdminMessages();
  const t = useFilesMessages();
  const [confirming, setConfirming] = createSignal(false);
  const [notice, setNotice] = createSignal<string | null>(null);
  const action = mutation.create({
    mutation: async (request: (signal: AbortSignal) => Promise<ResponseLike>, { abortSignal }) => {
      setNotice(null);
      const response = await request(abortSignal);
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        const parsed = ErrorSchema.safeParse(body);
        throw new Error(parsed.success && parsed.data.code !== "unavailable" ? parsed.data.message : a().actionFailed);
      }
      setNotice(body && typeof body === "object" && "state" in body && body.state === "pending" ? a().pending : a().success);
      await props.refresh();
    },
  });
  onCleanup(() => action.abort());
  const busy = () => confirming() || action.loading();
  const withConfirmation = async (fn: () => Promise<void>) => {
    if (busy()) return;
    setConfirming(true);
    try {
      await fn();
    } finally {
      setConfirming(false);
    }
  };
  const confirmDelete = async (path: string) =>
    !!(await prompts.form({
      title: a().delete,
      variant: "danger",
      confirmText: a().delete,
      fields: {
        explanation: { type: "info", content: a().confirmDelete },
        path: {
          type: "text",
          label: a().confirmPath,
          description: path,
          required: true,
          validate: (value) => (value === path ? null : a().pathMismatch),
        },
      },
    }));
  const retry = async (id: string) => {
    if (await prompts.confirm(a().retryConfirm, { title: a().retry, confirmText: a().retry }))
      await action.mutate((signal) => apiClient.admin.operations[":id"].retry.$post({ param: { id } }, { init: { signal } }));
  };
  const directory = (kind: DirectoryAction, row: InventoryEntry) =>
    withConfirmation(async () => {
      if (kind === "details") {
        const next = await prompts.dialog<"create">(
          (close) => (
            <div class="flex min-w-0 flex-col gap-5 text-sm text-primary">
              <div class="flex min-w-0 flex-col items-start gap-2">
                <h3 class="w-full break-all text-lg font-semibold leading-snug">{row.name}</h3>
                <DirectoryStatus status={row.status} />
              </div>
              <Show when={row.reason}>
                <InlineGuidance
                  tone={row.status === "conflict" ? "danger" : row.status === "missing" || row.status === "orphaned" ? "warning" : "info"}
                  icon="ti ti-info-circle"
                >
                  <AdminIssue code={row.reason} />
                </InlineGuidance>
              </Show>
              <dl class="grid min-w-0 grid-cols-2 gap-x-4 gap-y-4">
                <div>
                  <dt class="text-xs text-dimmed">{a().source}</dt>
                  <dd class="mt-1 font-medium">{t()[row.area]}</dd>
                </div>
                <div>
                  <dt class="text-xs text-dimmed">{a().kind}</dt>
                  <dd class="mt-1 font-medium">{row.kind === "users" ? t().users : t().groupPlural}</dd>
                </div>
                <div class="col-span-2 min-w-0">
                  <dt class="text-xs text-dimmed">{t().root}</dt>
                  <dd class="mt-1 break-all font-mono">{props.snapshot().result.configuration[row.area].root}</dd>
                </div>
                <div class="col-span-2 min-w-0">
                  <dt class="text-xs text-dimmed">{a().currentPath}</dt>
                  <dd class="mt-1 rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-subtle)] p-3 text-primary">
                    <code class="break-all">{row.path}</code>
                  </dd>
                </div>
              </dl>
              <Show
                when={row.area === "freeipa"}
                fallback={
                  <InlineGuidance tone="info" icon="ti ti-info-circle">
                    {a().cloudOwnership}
                  </InlineGuidance>
                }
              >
                <section class="space-y-2" aria-label={a().unixOwnership}>
                  <h4 class="font-medium">{a().unixOwnership}</h4>
                  <dl class="grid grid-cols-2 gap-4">
                    <div>
                      <dt class="text-xs text-dimmed">UID</dt>
                      <dd class="mt-1 font-mono">{row.uid ?? t().unknown}</dd>
                    </div>
                    <div>
                      <dt class="text-xs text-dimmed">GID</dt>
                      <dd class="mt-1 font-mono">{row.gid ?? t().unknown}</dd>
                    </div>
                  </dl>
                </section>
              </Show>
              <div class="flex flex-wrap justify-end gap-2">
                <Button variant="secondary" onClick={() => close()}>
                  {a().close}
                </Button>
                <Show when={row.actions.create}>
                  <Button onClick={() => close("create")}>{a().create}</Button>
                </Show>
              </div>
            </div>
          ),
          { title: a().directoryDetails, icon: "ti ti-folder", size: "medium" },
        );
        if (next !== "create") return;
        kind = "create";
      }
      if (kind === "retry") {
        if (row.operationId) await retry(row.operationId);
        return;
      }
      const target = { area: row.area, kind: row.kind, name: row.name };
      if (kind === "archive") {
        const form = await prompts.form({
          title: `${a().archive}: ${row.name}`,
          confirmText: a().archive,
          fields: {
            explanation: { type: "info", content: a().confirmArchive },
            path: {
              type: "text",
              label: a().archivePath,
              description: a().archivePathHint,
              default: props.snapshot().result.configuration[row.area].archive,
              required: true,
            },
          },
        });
        if (form)
          await action.mutate((signal) =>
            apiClient.admin.directories.archive.$post({ json: { ...target, archivePath: form.path } }, { init: { signal } }),
          );
        return;
      }
      if (kind === "delete") {
        if (await confirmDelete(row.path))
          await action.mutate((signal) =>
            apiClient.admin.directories.delete.$post({ json: { ...target, confirmPath: row.path } }, { init: { signal } }),
          );
        return;
      }
      if (kind === "retire") {
        if (await prompts.confirm(a().retireConfirm, { title: a().retire, confirmText: a().retire }))
          await action.mutate((signal) => apiClient.admin.directories.retire.$post({ json: target }, { init: { signal } }));
        return;
      }
      if (!row.identityId) return;
      const identity = { area: row.area, kind: row.kind, identityId: row.identityId };
      if (
        await prompts.confirm(`${kind === "create" ? a().confirmCreate : t().adoptDescription}\n${row.path}`, {
          title: `${kind === "create" ? a().create : t().adopt}: ${row.name}`,
          confirmText: kind === "create" ? a().create : t().adopt,
        })
      )
        await action.mutate((signal) =>
          kind === "create"
            ? apiClient.admin.directories.create.$post({ json: identity }, { init: { signal } })
            : apiClient.admin.adopt.$post({ json: identity }, { init: { signal } }),
        );
    });
  const archive = (kind: "restore" | "delete" | "retry", row: ArchiveEntry) =>
    withConfirmation(async () => {
      if (kind === "retry") {
        if (row.operationId && row.canRetry) await retry(row.operationId);
        return;
      }
      if (kind === "restore") {
        if (
          await prompts.confirm(`${a().confirmRestore}\n${row.originalPath}`, {
            title: `${a().restore}: ${row.name}`,
            confirmText: a().restore,
          })
        )
          await action.mutate((signal) =>
            apiClient.admin.archives[":id"].restore.$post(
              { param: { id: row.id }, json: { confirmPath: row.originalPath } },
              { init: { signal } },
            ),
          );
      } else if (await confirmDelete(row.path))
        await action.mutate((signal) =>
          apiClient.admin.archives[":id"].$delete({ param: { id: row.id }, json: { confirmPath: row.path } }, { init: { signal } }),
        );
    });
  const removeEntry = (browse: AdminBrowseResult, entry: FileEntry) =>
    withConfirmation(async () => {
      const path = [browse.basePath, entry.path].filter(Boolean).join("/");
      if (!(await confirmDelete(path))) return;
      await action.mutate((signal) =>
        apiClient.admin.entries.$delete(
          {
            json: {
              area: browse.area,
              kind: browse.kind,
              name: browse.name,
              archiveId: browse.archiveId ?? undefined,
              path: entry.path,
              confirmPath: path,
            },
          },
          { init: { signal } },
        ),
      );
    });
  const root = (kind: "refresh" | "rebuild") =>
    withConfirmation(async () => {
      const area = props.location().area;
      if (kind === "rebuild" && !(await prompts.confirm(a().rebuildConfirm, { title: a().rebuild, confirmText: a().rebuild }))) return;
      await action.mutate((signal) =>
        kind === "refresh"
          ? apiClient.admin.root.refresh.$post({ json: { area } }, { init: { signal } })
          : apiClient.admin.root.rebuild.$post({ json: { area } }, { init: { signal } }),
      );
    });
  return { busy, notice, error: action.error, directory, archive, removeEntry, root };
}
