import { downloadArchive } from "@k2b/filegate/utils";
import { fileIcons } from "@k2b/stdlib";
import { Button, Format, toast } from "@k2b/ui";
import { createSignal, For } from "solid-js";
import type { PublicShare } from "../contracts";
import { useBrowserMessages } from "./browser-messages";
import { apiFailure } from "./file-preview";
import { useFilesMessages } from "./messages";
import { publicClient } from "./public-client";

/** Visitors download single files through short leases or everything as one signed archive. */
export default function PublicShareList(props: { token: string; share: PublicShare }) {
  const b = useBrowserMessages();
  const t = useFilesMessages();
  const [busy, setBusy] = createSignal<string | null>(null);
  const param = { token: props.token };
  const download = async (path: string) => {
    setBusy(path);
    try {
      const response = await publicClient.s[":token"].api.download.$post({ param, json: { path } });
      if (!response.ok) await apiFailure(response, t().downloadFailed);
      const lease = await response.json();
      const link = document.createElement("a");
      link.href = lease.url;
      link.download = path.split("/").at(-1)!;
      link.rel = "noreferrer";
      document.body.append(link);
      link.click();
      link.remove();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t().downloadFailed);
    } finally {
      setBusy(null);
    }
  };
  const downloadAll = async () => {
    setBusy("*");
    try {
      const response = await publicClient.s[":token"].api.archive.$post({ param });
      if (!response.ok) await apiFailure(response, t().downloadFailed);
      downloadArchive(await response.json());
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t().downloadFailed);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div class="flex flex-col gap-3">
      <ul class="flex flex-col gap-1" role="list">
        <For each={props.share.items}>
          {(item) => (
            <li class="flex items-center gap-3 rounded-md px-2 py-1.5 even:bg-[var(--k2b-surface-muted)]" role="listitem">
              <i class={`ti ${fileIcons.getFileIcon({ name: item.name, type: item.directory ? "directory" : "file" })} text-lg`} aria-hidden="true" />
              <span class="min-w-0 flex-1 truncate text-sm">{item.name}</span>
              <span class="text-xs text-dimmed tabular-nums">{item.directory ? b().folder : <Format.Bytes value={item.size} />}</span>
              <Button size="xs" variant="secondary" loading={busy() === item.path} disabled={item.directory} onClick={() => void download(item.path)}>
                <i class="ti ti-download" aria-hidden="true" />
                {t().download}
              </Button>
            </li>
          )}
        </For>
      </ul>
      <div>
        <Button variant="primary" loading={busy() === "*"} onClick={() => void downloadAll()}>
          <i class="ti ti-file-zip" aria-hidden="true" />
          {b().publicDownloadAll}
        </Button>
      </div>
    </div>
  );
}
