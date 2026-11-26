import { useLocale } from "@k2b/ui";
import { Canvas, Empty, Loading, Notice, Pane, StatusRow } from "@k2b/ui/v2";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import type { OfficeEditorLaunch } from "../contracts";
import { useBrowserMessages } from "./browser-messages";
import { createEditorFill } from "./editor-fill";

/**
 * Collabora runs in an iframe that fills the pane and talks to this page through postMessage. Cloud only supplies
 * colours, language and the way back: Collabora's own close button ends the session. Collabora receives resolved
 * values, so every token of the v2 page is read through a probe element in this document.
 */
const CSS_VARIABLES: [string, string][] = [
  ["--co-primary-element", "--k2-blue"],
  ["--co-primary-element-light", "--k2-blue-tint"],
  ["--co-primary-text", "--k2-surface"],
  ["--co-color-main-text", "--k2-text"],
  ["--co-text-accent", "--k2-text"],
  ["--co-color-text-lighter", "--k2-muted"],
  ["--co-color-main-background", "--k2-surface"],
  ["--co-color-background-dark", "--k2-n100"],
  ["--co-color-background-darker", "--k2-n100"],
  ["--co-color-border", "--k2-line"],
  ["--co-color-border-dark", "--k2-n300"],
];
function cloudTheme(within: HTMLElement): string {
  const probe = document.createElement("span");
  probe.hidden = true;
  within.append(probe);
  try {
    const resolved = (token: string) => {
      probe.style.color = `var(${token})`;
      return getComputedStyle(probe).color;
    };
    probe.style.borderRadius = "var(--k2-r-control)";
    const radius = getComputedStyle(probe).borderRadius;
    return [...CSS_VARIABLES.map(([target, token]) => `${target}=${resolved(token)}`), `--co-border-radius=${radius}`].join(";");
  } finally {
    probe.remove();
  }
}
const isDark = () => document.documentElement.classList.contains("dark");
/**
 * Collabora uses `lang` for its menus and as the language of text without one, which picks the spelling dictionary.
 * Dictionaries are regional, so a bare `de` would leave new text unchecked: complete the region.
 */
function collaboraLanguage(locale: string): string {
  try {
    const tag = new Intl.Locale(locale);
    return tag.region ? tag.baseName : new Intl.Locale(tag.baseName, { region: tag.maximize().region }).baseName;
  } catch {
    return locale;
  }
}
const EDITOR_LOAD_TIMEOUT_MS = 60_000;
/** Writable files outside managed bases get one notice per browser; unavailable storage only repeats it. */
const EXTERNAL_WRITES_NOTICE_KEY = "filesv2-editor-external-writes";
const externalWritesAcknowledged = () => {
  try {
    return localStorage.getItem(EXTERNAL_WRITES_NOTICE_KEY) === "1";
  } catch {
    return false;
  }
};
const acknowledgeExternalWrites = () => {
  try {
    localStorage.setItem(EXTERNAL_WRITES_NOTICE_KEY, "1");
  } catch {
    /* Storage may be disabled; the notice appears again next time. */
  }
};

/** A document, spreadsheet or presentation in Collabora, on a v2 frame. */
export default function OfficePane(props: { launch: OfficeEditorLaunch; onBack: () => void }) {
  const b = useBrowserMessages();
  const locale = useLocale();
  const fill = createEditorFill();
  const [loaded, setLoaded] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  const [theme, setTheme] = createSignal("");
  const [dark, setDark] = createSignal(false);
  // Once per browser, only after the page is live: the server cannot know what this browser acknowledged.
  const [external, setExternal] = createSignal(false);
  const frameName = `filesv2-editor-${Math.random().toString(36).slice(2)}`;
  let frame!: HTMLIFrameElement;
  let form!: HTMLFormElement;
  const post = (message: { MessageId: string; Values?: Record<string, unknown> }) =>
    frame.contentWindow?.postMessage(JSON.stringify({ ...message, SendTime: Date.now() }), new URL(props.launch.action).origin);
  onMount(() => {
    setTheme(cloudTheme(form.parentElement ?? document.body));
    setDark(isDark());
    setExternal(props.launch.managed === false && props.launch.canWrite && !externalWritesAcknowledged());
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow || event.origin !== new URL(props.launch.action).origin || typeof event.data !== "string")
        return;
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
      } else if (message.MessageId === "UI_Close") props.onBack();
    };
    window.addEventListener("message", onMessage);
    onCleanup(() => window.removeEventListener("message", onMessage));
    // Collabora never reports failures to the host; a document that has not loaded by then gets a way back.
    const timer = setTimeout(() => setFailed(!loaded()), EDITOR_LOAD_TIMEOUT_MS);
    onCleanup(() => clearTimeout(timer));
    queueMicrotask(() => form.submit());
  });
  // Collabora shows its own close button for this parameter and reports the click as UI_Close. It reads `lang` only
  // from this URL, never from the posted form.
  const action = () => `${props.launch.action}&closebutton=1&lang=${encodeURIComponent(collaboraLanguage(locale()))}`;
  return (
    <Pane
      label={props.launch.entry.name}
      status={
        <StatusRow
          lead={loaded() ? props.launch.entry.name : failed() ? b().editorFailed : b().editorLoading}
          loading={!loaded() && !failed()}
        />
      }
    >
      <Show when={external()}>
        <Notice
          tone="warn"
          title={b().editorExternalWritesTitle}
          actions={[
            {
              label: b().v2Understood,
              onClick: () => {
                acknowledgeExternalWrites();
                setExternal(false);
              },
            },
          ]}
        >
          {b().editorExternalWrites}
        </Notice>
      </Show>
      <Canvas label={props.launch.entry.name}>
        <div ref={fill.ref} style={{ height: fill.height(), position: "relative" }} aria-busy={!loaded()}>
          <iframe
            ref={frame}
            name={frameName}
            title={props.launch.entry.name}
            allow="clipboard-read; clipboard-write"
            style={{ border: "0", width: "100%", height: "100%", display: "block", visibility: loaded() ? "visible" : "hidden" }}
          />
          <Show when={!loaded()}>
            <div style={{ position: "absolute", inset: "0" }}>
              <Show
                when={!failed()}
                fallback={
                  <Empty icon="alert-triangle" text={b().editorFailed} action={{ label: b().backToFolder, onClick: props.onBack }} />
                }
              >
                <Loading rows={10} />
              </Show>
            </div>
          </Show>
          <form ref={form} method="post" action={action()} target={frameName} hidden>
            <input type="hidden" name="access_token" value={props.launch.token} />
            <input type="hidden" name="access_token_ttl" value={String(props.launch.tokenTtl)} />
            <input type="hidden" name="css_variables" value={theme()} />
            <input
              type="hidden"
              name="ui_defaults"
              value={`SavedUIState=false;UIMode=compact;TextRuler=false;TextSidebar=false;SpreadsheetSidebar=false;PresentationSidebar=false;UITheme=${dark() ? "dark" : "light"}`}
            />
          </form>
        </div>
      </Canvas>
    </Pane>
  );
}
