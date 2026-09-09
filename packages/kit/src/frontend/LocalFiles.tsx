import { createSignal, For, onMount, Show } from "solid-js";
import { Button, Placeholder, SettingsCollection, useLocale } from "@k2b/ui";
import { files } from "@k2b/stdlib/browser";
import { AppStorage } from "../runtime/storage";
import { messages } from "./messages";

type Entry = { area: "files" | "kv"; path: string };
export function LocalFiles(props: { appId: string; userId: string }) {
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
  onMount(() => void refresh());
  return (
    <div class="kit-flow kit-flow-column kit-gap-md">
      <p class="text-sm text-muted">{t().storageHint}</p>
      <div>
        <Button variant="ghost" size="sm" loading={busy()} onClick={refresh}>
          <i class="ti ti-refresh" aria-hidden="true" /> {t().refreshFiles}
        </Button>
      </div>
      <Show when={error()}>
        <p role="alert" class="kit-error">
          {error()}
        </p>
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
              </SettingsCollection.Item.Actions>
            </SettingsCollection.Item>
          )}
        </For>
      </SettingsCollection>
    </div>
  );
}
