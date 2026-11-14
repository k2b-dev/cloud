import { Button, Placeholder, prompts } from "@k2b/ui";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { artifactMessages } from "../messages";
import type { RuntimeContext } from "../runtime/cloud";
import type { RuntimeServices } from "../runtime/services";
import type { AppFrameAssets } from "./assets";
import type { AppFiles } from "./compose";
import { type Confirm, type Mount, type MountEvent, mountApp } from "./host";

export { loadAppAssets } from "./prepare-assets";

/**
 * The confirm button arms late and is never the default, so a click meant for the app cannot open the link.
 * The question closes, unanswered, when `signal` aborts because the app stopped.
 */
export function confirmLink(url: string, app: string, locale: string, signal: AbortSignal): Promise<boolean> {
  const t = artifactMessages.resolve([locale]).t;
  return prompts
    .dialog<boolean>(
      (close) => {
        const [armed, setArmed] = createSignal(false);
        onMount(() => {
          const timer = setTimeout(() => setArmed(true), 500);
          onCleanup(() => clearTimeout(timer));
        });
        return (
          <div class="flex flex-col gap-3">
            <p>{t.linkHelp({ app })}</p>
            <p class="break-all">
              <strong>{url}</strong>
            </p>
            <div class="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => close(false)}>
                {t.cancel}
              </Button>
              <Button disabled={!armed()} onClick={() => close(true)}>
                {t.linkOpen}
              </Button>
            </div>
          </div>
        );
      },
      { title: t.linkTitle, size: "small", signal },
    )
    .then((answer) => answer === true);
}

/** Mounts one HTML app into its surface and stops it when the component unmounts. Invisible until the app is ready. */
export function AppFrame(props: {
  files: AppFiles;
  /** App name from Cloud metadata, never from the app document. */
  title: string;
  context: RuntimeContext;
  assets: AppFrameAssets;
  services: (confirm: Confirm) => RuntimeServices;
  hash?: string;
  onHash?: (hash: string) => void;
  onEvent: (event: MountEvent) => void;
  onMount?: (mount: Mount) => void;
}) {
  const [ready, setReady] = createSignal(false);
  let container!: HTMLDivElement;
  onMount(() => {
    const mount = mountApp(container, props.files, {
      prelude: props.assets.prelude,
      preludeHash: props.assets.preludeHash,
      baseCss: props.assets.baseCss,
      chartParts: props.assets.chartParts,
      context: props.context,
      title: props.title,
      hash: props.hash,
      services: props.services,
      confirmOpen: (url, signal) => confirmLink(url, props.title, props.context.locale, signal),
      onHash: props.onHash,
      onEvent: (event) => {
        // A start that timed out shows the frame anyway; the loading layer must not keep covering it.
        if (event.type === "ready" || event.type === "not-ready") setReady(true);
        props.onEvent(event);
      },
    });
    props.onMount?.(mount);
    onCleanup(() => mount.stop());
  });
  return (
    <div class="studio-app" aria-busy={ready() ? undefined : "true"}>
      <div class="studio-app__frame" ref={container} />
      <Show when={!ready()}>
        <Placeholder class="studio-app__loading" state="loading" variant="panel" />
      </Show>
    </div>
  );
}
