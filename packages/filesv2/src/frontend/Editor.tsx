import type { LinkNavigateEvent } from "@k2b/ssr/nav";
import { AppWorkspace, ButtonLink, Placeholder, StatusBadge, useLocale } from "@k2b/ui";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import type { EditorLaunch } from "../contracts";
import { useBrowserMessages } from "./browser-messages";
import { fileIcon } from "./file-preview";

/**
 * Collabora runs in an iframe and talks to this page through postMessage. Cloud only frames it: a header
 * with the way back, its own surface radius, its colours and language, and the document's saved state.
 */
const CSS_VARIABLES: [string, string][] = [
  ["--co-primary-element", "--k2b-action-solid"],
  ["--co-primary-element-light", "--k2b-action"],
  ["--co-primary-text", "--k2b-surface"],
  ["--co-color-main-text", "--k2b-text"],
  ["--co-text-accent", "--k2b-text"],
  ["--co-color-text-lighter", "--k2b-text-muted"],
  ["--co-color-main-background", "--k2b-surface"],
  ["--co-color-background-dark", "--k2b-surface-muted"],
  ["--co-color-background-darker", "--k2b-surface-muted"],
  ["--co-color-border", "--k2b-border"],
  ["--co-color-border-dark", "--k2b-border-strong"],
];
/** Collabora receives resolved values, so every token is read through a probe element in this document. */
function cloudTheme(): string {
  const probe = document.createElement("span");
  probe.hidden = true;
  document.body.append(probe);
  try {
    const resolved = (token: string) => {
      probe.style.color = `var(${token})`;
      return getComputedStyle(probe).color;
    };
    probe.style.borderRadius = "var(--k2b-radius-control)";
    const radius = getComputedStyle(probe).borderRadius;
    return [...CSS_VARIABLES.map(([target, token]) => `${target}=${resolved(token)}`), `--co-border-radius=${radius}`].join(";");
  } finally {
    probe.remove();
  }
}
const isDark = () => document.documentElement.classList.contains("dark");

export default function Editor(props: { launch: EditorLaunch; backHref: string; onNavigate: (event: LinkNavigateEvent) => Promise<void> }) {
  const b = useBrowserMessages();
  const locale = useLocale();
  const [loaded, setLoaded] = createSignal(false);
  const [modified, setModified] = createSignal(false);
  const [theme, setTheme] = createSignal("");
  const [dark, setDark] = createSignal(false);
  const frameName = `filesv2-editor-${Math.random().toString(36).slice(2)}`;
  let frame!: HTMLIFrameElement;
  let form!: HTMLFormElement;
  const post = (message: { MessageId: string; Values?: Record<string, unknown> }) =>
    frame.contentWindow?.postMessage(JSON.stringify({ ...message, SendTime: Date.now() }), new URL(props.launch.action).origin);
  const back = () => {
    const link = document.createElement("a");
    link.href = props.backHref;
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
  };
  onMount(() => {
    setTheme(cloudTheme());
    setDark(isDark());
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow || typeof event.data !== "string") return;
      let message: { MessageId?: string; Values?: Record<string, unknown> };
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.MessageId === "App_LoadingStatus") {
        if (message.Values?.Status === "Frame_Ready") post({ MessageId: "Host_PostmessageReady" });
        if (message.Values?.Status === "Document_Loaded") {
          setLoaded(true);
          // Comments are not part of this version: hide the command wherever Collabora offers it.
          post({ MessageId: "Hide_Command", Values: { id: ".uno:InsertAnnotation" } });
          post({ MessageId: "Hide_Command", Values: { id: ".uno:ShowAnnotations" } });
        }
      } else if (message.MessageId === "Doc_ModifiedStatus") setModified(message.Values?.Modified === true);
      else if (message.MessageId === "UI_Close") back();
    };
    window.addEventListener("message", onMessage);
    onCleanup(() => window.removeEventListener("message", onMessage));
    queueMicrotask(() => form.submit());
  });
  const status = () =>
    !props.launch.canWrite ? (
      <StatusBadge tone="neutral" variant="text" label={b().editorReadOnly} />
    ) : modified() ? (
      <StatusBadge tone="warning" variant="text" label={b().editorUnsaved} />
    ) : (
      <StatusBadge tone="ok" variant="text" label={b().editorSaved} />
    );
  return (
    <AppWorkspace.Main scroll={false} class="filesv2-editor" aria-busy={!loaded()}>
      <header class="filesv2-editor__header">
        <ButtonLink size="sm" variant="ghost" href={props.backHref} navigation="enhanced" onNavigate={props.onNavigate} aria-label={b().backToFolder}>
          <i class="ti ti-arrow-left" aria-hidden="true" />
        </ButtonLink>
        <i class={`${fileIcon(props.launch.entry)} text-lg text-secondary`} aria-hidden="true" />
        <h1 class="min-w-0 flex-1 truncate text-sm font-semibold text-primary">
          {props.launch.entry.name}
          <span class="ml-2 truncate text-xs font-normal text-dimmed">{`${props.launch.base.name} / ${props.launch.entry.path}`}</span>
        </h1>
        <Show when={loaded()}>{status()}</Show>
      </header>
      <div class="filesv2-editor__frame">
        <iframe ref={frame} name={frameName} title={props.launch.entry.name} allow="clipboard-read; clipboard-write" />
        <Show when={!loaded()}>
          <div class="filesv2-editor__loading">
            <Placeholder state="loading" variant="panel" description={b().editorLoading} />
          </div>
        </Show>
      </div>
      <form ref={form} method="post" action={props.launch.action} target={frameName} hidden>
        <input type="hidden" name="access_token" value={props.launch.token} />
        <input type="hidden" name="access_token_ttl" value={String(props.launch.tokenTtl)} />
        <input type="hidden" name="css_variables" value={theme()} />
        <input type="hidden" name="ui_defaults" value={`UIMode=compact;TextRuler=false;TextSidebar=false;SpreadsheetSidebar=false;PresentationSidebar=false;UITheme=${dark() ? "dark" : "light"}`} />
        <input type="hidden" name="lang" value={locale()} />
      </form>
    </AppWorkspace.Main>
  );
}
