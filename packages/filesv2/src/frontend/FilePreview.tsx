import { query } from "@k2b/stdlib/solid";
import { Button, FileView, PdfPreview, Placeholder } from "@k2b/ui";
import { createSignal, Match, onCleanup, Show, Switch } from "solid-js";
import type { FileEntry } from "../contracts";
import { hasPdfSignature, PDF_HEADER_WINDOW } from "../pdf-body";
import { useBrowserMessages } from "./browser-messages";
import { contentLease, inlinePdfHref, previewFile, previewKind, readPreview } from "./file-preview";
import { useFilesMessages } from "./messages";

/** Mounted for one selected revision; closing it aborts text/PDF reads. */
type PreviewProps = {
  variant?: "default" | "plain";
  previewLines?: number;
  onExpandPreview?: () => void;
  headingScale?: "compact" | "normal";
  baseId: string;
  locationKey?: string;
  entry: FileEntry;
  onDownload: () => void;
  /** Called once the bytes of a `.pdf` show it is no PDF, so the host can withdraw its own viewer actions too. */
  onNotPdf?: () => void;
};
export default function FilePreview(props: PreviewProps) {
  return (
    <Show keyed when={JSON.stringify([props.baseId, props.locationKey, props.entry.path, props.entry.modified])}>
      {(_key) => <RevisionPreview {...props} />}
    </Show>
  );
}
function RevisionPreview(props: PreviewProps) {
  const t = useBrowserMessages();
  const f = useFilesMessages();
  const [failed, setFailed] = createSignal(false);
  const [notPdf, setNotPdf] = createSignal(false);
  const retry = async () => {
    if (media()) await lease.refresh();
    setFailed(false);
  };
  const abort = new AbortController();
  onCleanup(() => abort.abort());
  const kind = () => previewKind(props.entry);
  const media = () => ["image", "video", "audio"].includes(kind() ?? "");
  const source = () => JSON.stringify([props.baseId, props.locationKey, props.entry.path, props.entry.modified]);
  const lease = query.create({
    source,
    enabled: media,
    load: async (key, { abortSignal }) => ({
      key,
      lease: await contentLease(props.baseId, props.entry.path, abortSignal, t().previewFailed),
    }),
  });
  const url = () => (lease.data()?.key === source() && !lease.error() ? lease.data()?.lease.url : null);
  // Only a `.pdf` whose bytes a viewer accepts gets the preview and the new tab; the tab would refuse anything else.
  const readPdf = async () => {
    const blob = await readPreview(props.baseId, props.entry, abort.signal, t().previewFailed);
    if (hasPdfSignature(new Uint8Array(await blob.slice(0, PDF_HEADER_WINDOW).arrayBuffer()))) return blob;
    setNotPdf(true);
    props.onNotPdf?.();
    throw new Error(t().notPdf);
  };
  const download = (
    <Button size="sm" variant="secondary" onClick={props.onDownload}>
      <i class="ti ti-download" aria-hidden="true" />
      {f().download}
    </Button>
  );
  return (
    <div class="filesv2-preview">
      <Switch>
        <Match when={!kind()}>
          <Placeholder icon="ti ti-file" title={t().noPreview} description={t().noPreviewDescription} action={download} />
        </Match>
        <Match when={notPdf()}>
          <Placeholder icon="ti ti-file-alert" title={t().notPdf} description={t().notPdfDescription} action={download} />
        </Match>
        <Match when={kind() === "pdf"}>
          {/* Safari on iOS shows only the first page of an embedded PDF; the new tab opens the whole document at a
              stable address, so it reloads and keeps its file name. */}
          <PdfPreview
            autoLoad
            title={props.entry.name}
            openButtonLabel={t().openInTab}
            openHref={inlinePdfHref(props.baseId, props.entry.path)}
            onDownload={props.onDownload}
            request={readPdf}
          >
            {(parts) => (
              <div class="flex flex-col gap-2" classList={{ "h-[min(56rem,70dvh)]": props.previewLines === undefined }}>
                {parts.actions}
                {parts.content}
              </div>
            )}
          </PdfPreview>
        </Match>
        <Match when={failed() || (media() && lease.error())}>
          <Placeholder
            state="error"
            description={t().previewFailed}
            action={
              <Button size="sm" onClick={retry}>
                {t().retry}
              </Button>
            }
          />
        </Match>
        <Match when={media() && !url()}>
          <Placeholder state="loading" description={t().loadingDetails} />
        </Match>
        <Match when={media() && url()}>
          <FileView
            file={previewFile(props.entry)}
            previewHref={url()}
            crossOrigin="anonymous"
            onPreviewError={() => setFailed(true)}
            load={async () => ({
              encoding: "base64",
              content: "",
              mediaType: previewFile(props.entry).mediaType ?? "application/octet-stream",
            })}
          />
        </Match>
        <Match when={kind()}>
          <FileView
            file={previewFile(props.entry)}
            variant={props.variant}
            previewLines={props.previewLines}
            onExpandPreview={props.onExpandPreview}
            headingScale={props.headingScale ?? (props.previewLines ? "compact" : "normal")}
            previewPreferencesKey="filesv2-preview"
            load={async () => ({
              encoding: "utf8",
              content: await (
                await readPreview(props.baseId, props.entry, abort.signal, t().previewFailed).catch((error) => {
                  if (!abort.signal.aborted) setFailed(true);
                  throw error;
                })
              ).text(),
              mediaType: previewFile(props.entry).mediaType ?? "text/plain",
            })}
          />
        </Match>
      </Switch>
    </div>
  );
}
