import { Lightbox, LocaleProvider } from "@k2b/ui";
import { createMemo, createSignal, Show } from "solid-js";
import { render } from "solid-js/web";
import type { FileEntry } from "../contracts";
import { fileLightboxItem } from "./file-lightbox";

/** Opens the real Files items in the Lightbox from a browser test; the test serves every request with invented files. */
declare global {
  interface Window {
    preview: {
      open: (names: { name: string; size: number }[], start: string, options?: { editable?: boolean; readOnly?: boolean }) => void;
      downloads: string[];
      edits: string[];
      shares: string[];
    };
  }
}

const file = (name: string, size: number, readOnly?: boolean): FileEntry => ({
  name,
  path: `Summer party/${name}`,
  directory: false,
  size,
  modified: "2026-09-28T10:15:00.000Z",
  revision: `r-${name}`,
  actions: { write: !readOnly, move: true, share: true },
});
const [files, setFiles] = createSignal<readonly FileEntry[] | null>(null);
const [index, setIndex] = createSignal(0);
const [options, setOptions] = createSignal<{ editable?: boolean; readOnly?: boolean }>({});
const messages = {
  open: "Open",
  openReadOnly: "Open read-only",
  openInTab: "Open in new tab",
  copyText: "Copy text",
  copied: "Text copied.",
  share: "Share publicly",
  failed: "The preview could not be loaded. Try again.",
};

const host = document.getElementById("root");
if (!host) throw new Error("Missing harness root");
window.preview = {
  downloads: [],
  edits: [],
  shares: [],
  open: (names, start, next = {}) => {
    const entries = names.map(({ name, size }) => file(name, size, next.readOnly));
    setOptions(next);
    setIndex(
      Math.max(
        0,
        entries.findIndex((entry) => entry.name === start),
      ),
    );
    setFiles(entries);
  },
};
render(() => {
  const items = createMemo(() =>
    (files() ?? []).map((entry) =>
      fileLightboxItem(
        "personal",
        entry,
        {
          onDownload: (shown) => window.preview.downloads.push(shown.name),
          onOpen: options().editable && entry.name.endsWith(".md") ? (shown) => window.preview.edits.push(shown.name) : undefined,
          readOnly: (shown) => shown.actions?.write === false,
          onShare: (shown) => window.preview.shares.push(shown.name),
        },
        messages,
        document.documentElement.lang || "en",
      ),
    ),
  );
  return (
    <LocaleProvider locale={document.documentElement.lang || "en"}>
      <button type="button">Open</button>
      <Show when={files()}>
        <Lightbox items={items()} index={index()} onIndexChange={setIndex} onClose={() => setFiles(null)} />
      </Show>
    </LocaleProvider>
  );
}, host);
