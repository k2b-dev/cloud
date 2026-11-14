import { createDelayedLoading, FileTypeIcon } from "@k2b/ui";
import { createSignal, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import type { FileEntry } from "../contracts";
import { loadPreview, previewRevision, previewSource, previewUrl } from "./preview-client";

type ThumbnailProps = { baseId: string; locationKey?: string; entry: FileEntry; large?: boolean; hero?: boolean };

/**
 * The file's content in its icon's place: an image, the first page of a PDF or Office document, or the first lines of
 * a text. The box has its fixed size from the first render, so nothing moves while a preview arrives. A placeholder
 * shows only after 200 ms and then stays at least 300 ms; a file without a preview keeps its type icon, quietly.
 */
export default function FileThumbnail(props: ThumbnailProps) {
  return (
    <Show keyed when={JSON.stringify([props.baseId, props.locationKey, props.entry.path, previewRevision(props.entry), props.hero])}>
      {(_key) => <Thumbnail {...props} />}
    </Show>
  );
}

function Thumbnail(props: ThumbnailProps) {
  const kind = previewSource(props.entry);
  const variant = kind === "text" ? "text" : props.hero ? "large" : "small";
  const url = kind ? previewUrl(props.baseId, props.entry, variant) : null;
  // The versioned address goes straight into the first HTML, so a cached preview stands in the first frame.
  const [src, setSrc] = createSignal<string | null>(kind && kind !== "text" ? url : null);
  const [text, setText] = createSignal<string | null>(null);
  const [state, setState] = createSignal<"loading" | "ready" | "icon">(kind ? "loading" : "icon");
  const placeholder = createDelayedLoading(() => state() === "loading");
  const controller = new AbortController();
  let objectUrl: string | undefined;
  onCleanup(() => {
    controller.abort();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  });

  /** The image request failed or the preview is not drawn yet: ask the service and wait for it, within bounds. */
  const fetchPreview = async () => {
    if (!url || controller.signal.aborted) return;
    try {
      const result = await loadPreview(url, controller.signal);
      if (controller.signal.aborted) return;
      if (result.state !== "ready") return void setState("icon");
      if (kind === "text") {
        setText(await result.blob.text());
      } else {
        objectUrl = URL.createObjectURL(result.blob);
        setSrc(objectUrl);
      }
      setState("ready");
    } catch {
      if (!controller.signal.aborted) setState("icon");
    }
  };
  let image: HTMLImageElement | undefined;
  onMount(() => {
    if (kind === "text") return void fetchPreview();
    // An image that failed before the page became interactive reported its error to nobody.
    if (image?.complete) {
      if (image.naturalWidth > 0) setState("ready");
      else void fetchPreview();
    }
  });

  return (
    <span
      class="filesv2-thumbnail"
      classList={{
        "filesv2-thumbnail--large": props.large || props.hero,
        "filesv2-thumbnail--hero": props.hero,
        "filesv2-thumbnail--preview": state() !== "icon",
        "k2b-skeleton": placeholder(),
      }}
      data-kind={kind ?? undefined}
      aria-hidden="true"
    >
      <Switch>
        <Match when={state() === "icon"}>
          <FileTypeIcon name={props.entry.name} folder={props.entry.directory} size={props.large || props.hero ? "lg" : "md"} />
        </Match>
        <Match when={kind === "text"}>
          <span class="filesv2-thumbnail__page">
            <span class="filesv2-thumbnail__text">{text()}</span>
          </span>
        </Match>
        <Match when={src()}>
          {(href) => (
            <img
              ref={image}
              src={href()}
              alt=""
              loading="lazy"
              decoding="async"
              draggable={false}
              data-ready={state() === "ready" ? "" : undefined}
              onLoad={() => setState("ready")}
              onError={() => {
                if (src() === url) void fetchPreview();
                else setState("icon");
              }}
            />
          )}
        </Match>
      </Switch>
    </span>
  );
}
