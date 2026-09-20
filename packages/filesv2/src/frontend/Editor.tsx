import { AppWorkspace, Button, InlineGuidance, Placeholder, useLocale } from "@k2b/ui";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import type { OfficeEditorLaunch } from "../contracts";
import { useBrowserMessages } from "./browser-messages";

/**
 * Collabora runs in an iframe that fills the workspace and talks to this page through postMessage. Cloud
 * only supplies colours, language and the way back: Collabora's own close button ends the session.
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
const EDITOR_LOAD_TIMEOUT_MS = 60_000;

export default function Editor(props: { launch: OfficeEditorLaunch; onBack: () => void }) {
  const b = useBrowserMessages();
  const locale = useLocale();
  const [loaded, setLoaded] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  const [theme, setTheme] = createSignal("");
  const [dark, setDark] = createSignal(false);
  const frameName = `filesv2-editor-${Math.random().toString(36).slice(2)}`;
  let frame!: HTMLIFrameElement;
  let form!: HTMLFormElement;
  const post = (message: { MessageId: string; Values?: Record<string, unknown> }) =>
    frame.contentWindow?.postMessage(JSON.stringify({ ...message, SendTime: Date.now() }), new URL(props.launch.action).origin);
  const back = () => props.onBack();
  onMount(() => {
    setTheme(cloudTheme());
    setDark(isDark());
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow || event.origin !== new URL(props.launch.action).origin || typeof event.data !== "string") return;
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
      } else if (message.MessageId === "UI_Close") back();
    };
    window.addEventListener("message", onMessage);
    onCleanup(() => window.removeEventListener("message", onMessage));
    // Collabora never reports failures to the host; a document that has not loaded by then gets a way back.
    const timer = setTimeout(() => setFailed(!loaded()), EDITOR_LOAD_TIMEOUT_MS);
    onCleanup(() => clearTimeout(timer));
    queueMicrotask(() => form.submit());
  });
  // Collabora shows its own close button for this parameter and reports the click as UI_Close.
  const action = () => `${props.launch.action}&closebutton=1`;
  return (
    <AppWorkspace.Main scroll={false} class="filesv2-editor" aria-busy={!loaded()}>
      <Show when={props.launch.managed === false && props.launch.canWrite}>
        <div class="shrink-0 p-3">
          <InlineGuidance tone="warning" icon="ti ti-alert-triangle">{b().editorExternalWrites}</InlineGuidance>
        </div>
      </Show>
      <div class="filesv2-editor__frame">
        <iframe ref={frame} name={frameName} title={props.launch.entry.name} allow="clipboard-read; clipboard-write" />
        <Show when={!loaded()}>
          <div class="filesv2-editor__loading">
            <Show when={!failed()} fallback={<Placeholder state="error" variant="panel" title={b().editorFailed} action={<Button size="sm" variant="secondary" onClick={back}>{b().backToFolder}</Button>} />}>
              <Placeholder state="loading" variant="panel" description={b().editorLoading} />
            </Show>
          </div>
        </Show>
      </div>
      <form ref={form} method="post" action={action()} target={frameName} hidden>
        <input type="hidden" name="access_token" value={props.launch.token} />
        <input type="hidden" name="access_token_ttl" value={String(props.launch.tokenTtl)} />
        <input type="hidden" name="css_variables" value={theme()} />
        <input type="hidden" name="ui_defaults" value={`SavedUIState=false;UIMode=compact;TextRuler=false;TextSidebar=false;SpreadsheetSidebar=false;PresentationSidebar=false;UITheme=${dark() ? "dark" : "light"}`} />
        <input type="hidden" name="lang" value={locale()} />
      </form>
    </AppWorkspace.Main>
  );
}
