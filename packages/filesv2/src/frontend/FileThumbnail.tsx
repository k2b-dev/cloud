import { query } from "@k2b/stdlib/solid";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { apiClient } from "../api/client";
import type { FileEntry } from "../contracts";
import { fileIcon, previewKind } from "./file-preview";

export default function FileThumbnail(props: { baseId: string; entry: FileEntry; large?: boolean }) {
  const [visible, setVisible] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  let host: HTMLSpanElement | undefined;
  const source = () => JSON.stringify([props.baseId, props.entry.path, props.entry.modified]);
  const thumbnail = query.create({
    source,
    enabled: () => visible() && previewKind(props.entry) === "image",
    load: async (key, { abortSignal }) => {
      const response = await apiClient.bases[":baseId"].thumbnail.$post(
        { param: { baseId: props.baseId }, json: { path: props.entry.path, size: "small" } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error("thumbnail_unavailable");
      return { key, lease: await response.json() };
    },
  });
  onMount(() => {
    if (!host) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "80px" },
    );
    observer.observe(host);
    onCleanup(() => observer.disconnect());
  });
  const url = () => (!failed() && !thumbnail.error() && thumbnail.data()?.key === source() ? thumbnail.data()?.lease.url : null);
  return (
    <span ref={host} class={props.large ? "filesv2-thumbnail filesv2-thumbnail--large" : "filesv2-thumbnail"} aria-hidden="true">
      <Show when={url()} fallback={<i class={fileIcon(props.entry)} />}>
        {(href) => (
          <img
            src={href()}
            alt=""
            loading="lazy"
            draggable={false}
            referrerPolicy="no-referrer"
            crossOrigin="anonymous"
            onError={() => setFailed(true)}
          />
        )}
      </Show>
    </span>
  );
}
