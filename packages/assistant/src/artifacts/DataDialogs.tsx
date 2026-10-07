import { files } from "@k2b/stdlib/browser";
import { Button, ButtonLink, NoticeCard, Placeholder, prompts, Tabs, useLocale } from "@k2b/ui";
import { createResource, createSignal, For, Show } from "solid-js";
import { advancedMessages } from "./advanced-messages";
import { artifactClient } from "./client";
import { artifactMessages } from "./messages";

export function openDataDialog(id: string, scope: "user" | "shared", title: string) {
  return prompts.dialog<void>(() => <DataDialog id={id} scope={scope} />, { title, size: "medium" });
}
function DataDialog(props: { id: string; scope: "user" | "shared" }) {
  const locale = useLocale(),
    t = () => artifactMessages.resolve([locale()]).t,
    a = () => advancedMessages.resolve([locale()]).t;
  const [area, setArea] = createSignal<"files" | "kv">(props.scope === "user" ? "kv" : "files"),
    [after, setAfter] = createSignal("");
  const [busy, setBusy] = createSignal(false),
    [error, setError] = createSignal("");
  const [entries, { refetch }] = createResource(
    () => ({ area: area(), after: after() }),
    async ({ area, after }) => {
      const response = await artifactClient.storageManage(props.id, {
        scope: props.scope,
        area,
        after,
        limit: 50,
        operation: "list",
        mediaType: "",
      });
      return "items" in response ? (response.items ?? []) : [];
    },
  );
  async function action(run: () => Promise<void>) {
    if (busy()) return;
    setBusy(true);
    setError("");
    try {
      await run();
      await refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : t().REQUEST_FAILED);
    } finally {
      setBusy(false);
    }
  }
  async function read(key: string) {
    if (area() === "files") {
      const file = await artifactClient.storageFile(props.id, key, { management: true });
      if (!file) throw new Error(t().NOT_FOUND);
      return file;
    }
    const result = await artifactClient.storageManage(props.id, {
      scope: props.scope,
      area: area(),
      operation: "read",
      key,
      mediaType: "",
      after: "",
      limit: 50,
    });
    if (!("item" in result) || !result.item) throw new Error(t().NOT_FOUND);
    return new Blob([result.item.content], { type: "application/json" });
  }
  async function remove(key?: string) {
    if (
      !(await prompts.confirm(!key && props.scope === "user" ? a().clearPersonalConfirm : a().clearConfirm, {
        title: t().remove,
        variant: "danger",
      }))
    )
      return;
    await action(async () => {
      if (key)
        await artifactClient.storageManage(props.id, {
          scope: props.scope,
          area: area(),
          operation: "delete",
          key,
          mediaType: "",
          after: "",
          limit: 50,
        });
      else await artifactClient.storageClear(props.id, area(), props.scope);
      if (!key) setAfter("");
    });
  }
  return (
    <div class="assistant-data-dialog">
      <NoticeCard
        tone="info"
        title={props.scope === "user" ? a().personal : a().shared}
        detail={props.scope === "user" ? a().personalHelp : a().sharedHelp}
      />
      <Tabs
        value={area}
        onValueChange={(value) => {
          if (busy()) return;
          setAfter("");
          setArea(value);
        }}
        ariaLabel={a().view}
        options={[...(props.scope === "shared" ? [{ value: "files" as const, label: t().files }] : []), { value: "kv", label: a().kv }]}
      />
      <Show when={error()}>
        <NoticeCard tone="danger" title={error()} />
      </Show>
      <Show when={!entries.loading} fallback={<Placeholder state="loading" title={t().loading} />}>
        <Show
          when={!entries.error}
          fallback={
            <Placeholder
              state="error"
              title={t().loadFailed}
              description={String(entries.error)}
              action={<Button onClick={() => void refetch()}>{t().retry}</Button>}
            />
          }
        >
          <Show when={entries()?.length} fallback={<Placeholder title={a().empty} />}>
            <div class="assistant-data-entries">
              <For each={entries()}>
                {(item) => (
                  <div class="assistant-data-entry">
                    <span class="min-w-0 break-all">{item.key}</span>
                    <div class="flex gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy()}
                        onClick={() =>
                          void action(async () => {
                            const value = await read(item.key),
                              content = await value.slice(0, 16000).text();
                            await prompts.dialog<void>(
                              () => (
                                <pre class="whitespace-pre-wrap break-all">
                                  {content}
                                  {value.size > 16000 ? "\n…" : ""}
                                </pre>
                              ),
                              { title: item.key, size: "medium" },
                            );
                          })
                        }
                      >
                        {a().inspect}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy()}
                        onClick={() =>
                          void action(async () => {
                            const value = await read(item.key);
                            files.downloadFileFromContent(
                              value,
                              item.key.split("/").at(-1)! + (area() === "kv" ? ".json" : ""),
                              value.type,
                            );
                          })
                        }
                      >
                        <i class="ti ti-download" />
                        {a().download}
                      </Button>
                      <Button size="sm" variant="ghost" disabled={busy()} onClick={() => void remove(item.key)}>
                        <i class="ti ti-trash" />
                        {t().remove}
                      </Button>
                    </div>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </Show>
      </Show>
      <div class="flex flex-wrap justify-between gap-2">
        <Button variant="danger" disabled={busy() || entries.loading} onClick={() => void remove()}>
          {props.scope === "user" ? a().clearPersonal : a().clear}
        </Button>
        <div class="flex gap-2">
          <Button disabled={!after() || busy()} onClick={() => setAfter("")}>
            {t().back}
          </Button>
          <Button disabled={entries()?.length !== 50 || busy()} onClick={() => setAfter(entries()!.at(-1)!.key)}>
            {t().next}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function openDatabaseDialog(id: string, title: string) {
  return prompts.dialog<void>(
    () => {
      const locale = useLocale(),
        t = () => artifactMessages.resolve([locale()]).t,
        a = () => advancedMessages.resolve([locale()]).t;
      const [status, { refetch }] = createResource(() => artifactClient.databaseStatus(id));
      const [busy, setBusy] = createSignal(false),
        [error, setError] = createSignal("");
      async function action(run: () => Promise<unknown>) {
        setBusy(true);
        setError("");
        try {
          await run();
          await refetch();
        } catch (e) {
          setError(e instanceof Error ? e.message : t().REQUEST_FAILED);
        } finally {
          setBusy(false);
        }
      }
      return (
        <div class="assistant-data-dialog">
          <NoticeCard tone="info" title={a().database} detail={a().databaseHelp} />
          <Show when={error()}>
            <NoticeCard tone="danger" title={error()} />
          </Show>
          <Show when={!status.loading} fallback={<Placeholder state="loading" title={t().loading} />}>
            <Show
              when={!status.error && status()}
              keyed
              fallback={
                <Placeholder
                  state="error"
                  title={t().loadFailed}
                  description={String(status.error)}
                  action={<Button onClick={() => void refetch()}>{t().retry}</Button>}
                />
              }
            >
              {(value) => (
                <>
                  <Show when={value.configured} fallback={<NoticeCard tone="warning" title={t().DB_NOT_CONFIGURED} />}>
                    <Show when={value.unavailable}>
                      <NoticeCard tone="warning" title={t().DB_UNREACHABLE} />
                    </Show>
                    <p>{value.connected ? a().connected : a().disconnected}</p>
                    <Show when={value.overview}>
                      {(overview) => (
                        <p>
                          {a().bytes}: {overview().storage.used_bytes.toLocaleString(locale())} · {a().table}: {overview().schema.tables}
                        </p>
                      )}
                    </Show>
                    <Show when={!value.connected}>
                      <Button loading={busy()} onClick={() => void action(() => artifactClient.database(id, { operation: "connect" }))}>
                        {a().connect}
                      </Button>
                    </Show>
                  </Show>
                  <Show when={value.generation}>
                    <div class="flex flex-wrap gap-2">
                      <Show when={value.connected}>
                        <ButtonLink href={`/api/assistant/artifacts/${id}/database/export`}>
                          <i class="ti ti-download" />
                          {a().backup}
                        </ButtonLink>
                      </Show>
                      <Button
                        variant="danger"
                        loading={busy()}
                        onClick={async () => {
                          if (await prompts.confirm(a().resetConfirm, { title: a().reset, variant: "danger" }))
                            await action(() => artifactClient.databaseReset(id, value.generation));
                        }}
                      >
                        {a().reset}
                      </Button>
                    </div>
                  </Show>
                </>
              )}
            </Show>
          </Show>
        </div>
      );
    },
    { title, size: "medium" },
  );
}
