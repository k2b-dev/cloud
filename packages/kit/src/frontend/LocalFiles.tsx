import { createSignal, For, onMount, Show } from "solid-js";
import { Button, InlineGuidance, Placeholder, SettingsCollection, prompts, useLocale } from "@k2b/ui";
import { files } from "@k2b/stdlib/browser";
import { AppStorage } from "../runtime/storage";
import { messages } from "./messages";

type Entry = { area: "files" | "kv"; path: string };
export function LocalFiles(props: { appId: string; userId: string; beforeDelete: () => Promise<void> }) {
  const locale = useLocale(),
    t = () => messages.resolve([locale()]).t;
  const storage = new AppStorage(props.userId, props.appId, true);
  const [entries, setEntries] = createSignal<Entry[]>([]);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  async function refresh() {
    setBusy(true);
    setError("");
    try {
      const result: Entry[] = [];
      for (const area of ["files", "kv"] as const) {
        const paths = await storage.call(area === "files" ? "opfs.list" : "store.keys", []);
        if (!Array.isArray(paths) || !paths.every((path): path is string => typeof path === "string")) throw new Error(t().localFilesError);
        result.push(...paths.map((path) => ({ area, path })));
      }
      setEntries(result);
    } catch (e) {
      setError(t().localFilesError);
    } finally {
      setBusy(false);
    }
  }
  async function download(entry: Entry) {
    setBusy(true);
    setError("");
    try {
      const value = await storage.call(entry.area === "files" ? "opfs.read" : "store.get", [entry.path]);
      if (entry.area === "files") {
        if (!(value instanceof Blob)) throw new Error(t().localFilesError);
        files.downloadFileFromContent(value, entry.path.split("/").pop()!, value.type || "application/octet-stream");
      } else {
        files.downloadFileFromContent(JSON.stringify(value, null, 2), `${entry.path.split("/").pop()}.json`, "application/json");
      }
    } catch (e) {
      setError(t().localFilesError);
    } finally {
      setBusy(false);
    }
  }
  async function remove(entry?: Entry) {
    if (busy()) return;
    setBusy(true);
    try {
      const confirmed = await prompts.confirm(entry ? `${entry.path}\n\n${t().confirmDeleteLocal}` : t().confirmClearLocal, {
        title: entry ? t().deleteLocalItem : t().clearLocal,
        confirmText: entry ? t().deleteLocalItem : t().clearLocal,
        variant: "danger",
      });
      if (!confirmed) return;
      setError("");
      await props.beforeDelete();
      if (entry) await storage.call(entry.area === "files" ? "opfs.delete" : "store.delete", [entry.path]);
      else await storage.clear();
      await refresh();
    } catch {
      setError(t().localFilesError);
    } finally {
      setBusy(false);
    }
  }
  onMount(() => void refresh());
  return (
    <div class="kit-flow kit-flow-column kit-gap-md" style={{ "min-height": "min(50vh, 28rem)", "max-height": "65vh", overflow: "auto" }}>
      <p class="text-sm text-muted">{t().storageHint}</p>
      <div class="flex items-center justify-between gap-2">
        <Button variant="ghost" size="sm" loading={busy()} onClick={refresh}>
          <i class="ti ti-refresh" aria-hidden="true" /> {t().refreshFiles}
        </Button>
        <Button variant="danger" size="sm" disabled={busy()} onClick={() => void remove()}>
          <i class="ti ti-trash" aria-hidden="true" /> {t().clearLocal}
        </Button>
      </div>
      <Show when={error()}>
        <InlineGuidance tone="danger" icon="ti ti-alert-circle" role="alert">
          {error()}
        </InlineGuidance>
      </Show>
      <SettingsCollection
        title={t().localFiles}
        empty={
          <Show when={!busy() && !error()}>
            <Placeholder state="empty" align="left" title={t().noLocalFiles} />
          </Show>
        }
      >
        <For each={entries()}>
          {(entry) => (
            <SettingsCollection.Item
              title={entry.path}
              description={entry.area === "files" ? t().localFile : t().localKey}
              icon={<i class={entry.area === "files" ? "ti ti-file" : "ti ti-database"} aria-hidden="true" />}
            >
              <SettingsCollection.Item.Actions>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy()}
                  onClick={() => void download(entry)}
                  aria-label={`${t().downloadFile}: ${entry.path}`}
                >
                  <i class="ti ti-download" aria-hidden="true" /> {t().downloadFile}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy()}
                  onClick={() => void remove(entry)}
                  aria-label={`${t().deleteLocalItem}: ${entry.path}`}
                >
                  <i class="ti ti-trash" aria-hidden="true" /> {t().deleteLocalItem}
                </Button>
              </SettingsCollection.Item.Actions>
            </SettingsCollection.Item>
          )}
        </For>
      </SettingsCollection>
    </div>
  );
}
