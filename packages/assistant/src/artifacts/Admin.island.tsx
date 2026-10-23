import { navigateTo, refreshCurrentPath } from "@k2b/ssr/nav";
import { Button, DataTable, NoticeCard, Placeholder, prompts, TextInput, toast, useLocale } from "@k2b/ui";
import { createSignal, For, Show } from "solid-js";
import { DatabaseSettingsForm, StorageSettingsForm } from "./AdminSettings";
import type { artifactAdmin } from "./admin";
import { artifactClient } from "./client";
import { artifactMessages } from "./messages";
import { StudioPermissions } from "./StudioPermissions";

export default function Admin(props: { initial: Awaited<ReturnType<typeof artifactAdmin.list>>; search: string }) {
  const locale = useLocale(),
    t = () => artifactMessages.resolve([locale()]).t;
  const [busy, setBusy] = createSignal(false),
    [error, setError] = createSignal(""),
    [search, setSearch] = createSignal(props.search);
  const act = async (run: () => Promise<unknown>) => {
    if (busy()) return;
    setBusy(true);
    setError("");
    try {
      await run();
    } catch (error) {
      setError(error instanceof Error ? error.message : t().REQUEST_FAILED);
    } finally {
      setBusy(false);
    }
  };
  const settings = () =>
    act(async () => {
      const current = await artifactClient.admin.settings();
      await prompts.dialog<void>((close) => <DatabaseSettingsForm current={current} close={close} />, {
        title: t().settings,
        size: "medium",
      });
    });
  const permissions = (id: string) =>
    act(async () => {
      const entries = await artifactClient.admin.access(id);
      await prompts.dialog<void>(
        () => (
          <StudioPermissions
            entries={entries}
            loadProjects={() => artifactClient.admin.projects(id)}
            grant={(principal, level) => artifactClient.admin.grant(id, principal, level)}
            change={(accessId, level) => artifactClient.admin.change(id, accessId, level)}
          />
        ),
        { title: t().share, size: "medium" },
      );
    });
  const page = (number: number) => navigateTo(`/admin/assistant?page=${number}&search=${encodeURIComponent(search())}`);
  return (
    <div class="p-6 flex flex-col gap-4">
      <div class="flex items-center justify-between gap-4">
        <h1 class="text-xl font-semibold">{t().administration}</h1>
        <Button disabled={busy()} onClick={settings}>
          {t().settings}
        </Button>
      </div>
      <NoticeCard tone="info" title={t().files + " / KV"} detail={t().storageHelp} />
      <Button
        variant="secondary"
        disabled={busy()}
        onClick={() =>
          act(async () => {
            const current = await artifactClient.admin.storageSettings();
            await prompts.dialog<void>((close) => <StorageSettingsForm current={current} close={close} />, {
              title: t().storageLimits,
              size: "medium",
            });
          })
        }
      >
        {t().storageLimits}
      </Button>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          page(1);
        }}
        class="flex gap-2"
      >
        <TextInput aria-label={t().search} placeholder={t().search} value={search()} onValueChange={setSearch} />
        <Button type="submit">{t().search}</Button>
      </form>
      <Show when={error()}>
        <Placeholder state="error" title={t().REQUEST_FAILED} description={error()} />
      </Show>
      <DataTable
        rows={props.initial.items}
        getRowId={(row) => row.id}
        empty={t().noAccessibleApps}
        columns={[
          { id: "title", header: t().apps, value: (row) => row.title },
          { id: "published", header: t().published, value: (row) => (row.published ? t().published : t().unpublished) },
          { id: "files", header: t().files, value: (row) => row.files },
          { id: "kv", header: "KV", value: (row) => row.kv },
          { id: "bytes", header: "Bytes", value: (row) => row.bytes },
          { id: "database", header: t().database },
          { id: "projects", header: t().projects },
          { id: "actions", header: t().actions },
        ]}
        renderCell={({ row, col, value, render }) => {
          if (col.id === "database") return row.database ? t().present : t().absent;
          if (col.id === "projects")
            return row.projects.length ? (
              <Button
                size="sm"
                variant="text"
                onClick={() =>
                  prompts.dialog<void>(
                    () => (
                      <div class="flex flex-col gap-3">
                        <NoticeCard tone="info" title={t().projects} detail={t().projectScriptsHelp} />
                        <For each={row.projects}>{(id) => <code class="text-sm break-all">{id}</code>}</For>
                      </div>
                    ),
                    { title: row.title, size: "medium" },
                  )
                }
              >
                {row.projects.length}
              </Button>
            ) : (
              t().absent
            );
          if (col.id === "actions")
            return (
              <div class="flex gap-2">
                <Button size="sm" disabled={busy()} onClick={() => permissions(row.id)}>
                  {t().share}
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  disabled={busy()}
                  onClick={() =>
                    act(async () => {
                      if (await prompts.confirm(t().removeConfirm, { title: row.title, confirmText: t().remove, variant: "danger" })) {
                        const removed = await artifactClient.admin.remove(row.id);
                        if (removed.databaseCleanupQueued) toast(t().databaseCleanupQueued);
                        refreshCurrentPath();
                      }
                    })
                  }
                >
                  {t().remove}
                </Button>
              </div>
            );
          return render(value);
        }}
      />
      <Show when={props.initial.page > 1 || props.initial.hasNext}>
        <div class="flex gap-2">
          <Button disabled={props.initial.page === 1} onClick={() => page(props.initial.page - 1)}>
            {t().back}
          </Button>
          <Button disabled={!props.initial.hasNext} onClick={() => page(props.initial.page + 1)}>
            {t().next}
          </Button>
        </div>
      </Show>
    </div>
  );
}
