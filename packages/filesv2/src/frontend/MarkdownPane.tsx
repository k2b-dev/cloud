import { MarkdownEditor, prompts, toast } from "@k2b/ui";
import { Bar, Button, Canvas, Chip, Failed, Loading, Notice, Pane, Text } from "@k2b/ui/v2";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { apiClient } from "../api/client";
import type { MarkdownLaunch } from "../contracts";
import { MARKDOWN_LIMIT, markdownRevision } from "../document-assets";
import { useAssetMessages } from "./asset-messages";
import { createEditorFill } from "./editor-fill";
import { apiFailure } from "./file-preview";
import { uploadFile } from "./uploads";

/**
 * A Markdown file in the Markdown editor, on a v2 frame: the state of the draft in the status row, a problem as a
 * notice with its way out, the editor itself in the rest of the pane. Leaving with unsaved changes asks first, also
 * for links of the shell; the browser asks before the tab closes.
 */
export default function MarkdownPane(props: {
  launch: MarkdownLaunch;
  onBack: () => void;
  /** The workspace asks this before it leaves the editor; `false` stays. */
  onGuard: (guard: (() => Promise<boolean>) | null) => void;
}) {
  const t = useAssetMessages();
  const fill = createEditorFill();
  const [text, setText] = createSignal("");
  const [original, setOriginal] = createSignal("");
  const [revision, setRevision] = createSignal<string>();
  const [loading, setLoading] = createSignal(true);
  const [saving, setSaving] = createSignal(false);
  const [saved, setSaved] = createSignal(false);
  let area: HTMLDivElement | undefined;
  let savedTimer: ReturnType<typeof setTimeout> | undefined;
  const clearSaved = () => {
    clearTimeout(savedTimer);
    setSaved(false);
  };
  const [error, setError] = createSignal("");
  const [ready, setReady] = createSignal(false);
  const dirty = () => text() !== original();
  let request: AbortController | undefined;
  const load = async (initial = false) => {
    // k2b-ui gap: v2 has no form or confirm dialog in Files yet beside `Dialog.confirm`; the v1 prompts ask (Files PR 3).
    if (saving() || (!initial && dirty() && !(await prompts.confirm(t().discard)))) return;
    request?.abort();
    const pending = new AbortController();
    request = pending;
    const signal = AbortSignal.any([pending.signal, AbortSignal.timeout(30_000)]);
    setLoading(true);
    setError("");
    try {
      const reply = await apiClient.bases[":baseId"].editor.$post(
        { param: { baseId: props.launch.base.id }, json: { path: props.launch.entry.path } },
        { init: { signal } },
      );
      if (!reply.ok) await apiFailure(reply, t().failed);
      const launch = await reply.json();
      if (launch.kind !== "markdown") throw new Error(t().failed);
      const response = await fetch(launch.url, { credentials: "omit", redirect: "error", signal });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error(t().failed);
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array<ArrayBuffer>[] = [];
      let size = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.length;
          if (size > MARKDOWN_LIMIT) throw new Error(t().tooLarge);
          chunks.push(new Uint8Array(part.value));
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(await new Blob(chunks).arrayBuffer());
      } catch {
        throw new Error(t().tooLarge);
      }
      const etag = response.headers.get("etag");
      let loadedRevision = markdownRevision(launch.entry);
      if (launch.managed) {
        if (!etag || !/^"[^"\\]+"$/.test(etag)) throw new Error(t().failed);
        loadedRevision = etag.slice(1, -1);
      } else {
        const metadata = await apiClient.bases[":baseId"].entry.$get(
          { param: { baseId: launch.base.id }, query: { path: launch.entry.path } },
          { init: { signal } },
        );
        if (!metadata.ok) await apiFailure(metadata, t().failed);
        if (markdownRevision((await metadata.json()).entry) !== loadedRevision) throw new Error(t().changed);
      }
      if (pending.signal.aborted) return;
      setText(content);
      setOriginal(content);
      setRevision(loadedRevision);
      setReady(true);
    } catch (failure) {
      if (!pending.signal.aborted) setError(failure instanceof Error ? failure.message : t().failed);
    } finally {
      if (!pending.signal.aborted) setLoading(false);
    }
  };
  const save = async (copy = false) => {
    if (saving() || !ready() || (!copy && !props.launch.canWrite)) return;
    const name = copy ? await prompts.prompt(t().filename, props.launch.entry.name) : null;
    if (copy && (!name || /[/\\]/.test(name))) return;
    const path = copy ? [...props.launch.entry.path.split("/").slice(0, -1), name!].join("/") : props.launch.entry.path;
    const body = new Blob([text()], { type: "text/markdown;charset=utf-8" });
    if (body.size > MARKDOWN_LIMIT) {
      setError(t().tooLarge);
      return;
    }
    const savedText = text();
    clearSaved();
    setSaving(true);
    setError("");
    request = new AbortController();
    try {
      const result = await uploadFile(props.launch.base.id, path, body, {
        onConflict: copy ? "error" : "overwrite",
        expectedRevision: copy ? undefined : revision(),
        signal: request.signal,
        fallback: t().failed,
      });
      if (request.signal.aborted) return;
      if (!copy) {
        setOriginal(savedText);
        setRevision(markdownRevision(result.entry));
        if (text() === savedText) {
          setSaved(true);
          savedTimer = setTimeout(() => setSaved(false), 1500);
        }
      } else toast.success(`${t().copied}: ${result.entry.name}`);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t().failed);
    } finally {
      setSaving(false);
    }
  };
  onMount(() => {
    void load(true);
    let replaying = false;
    let confirmation: Promise<boolean> | undefined;
    const guard = async () => {
      if (replaying) return true;
      if (saving()) return false;
      if (!dirty()) return true;
      confirmation ??= prompts
        .confirm(t().discard)
        .then(Boolean)
        .finally(() => {
          confirmation = undefined;
        });
      return confirmation;
    };
    props.onGuard(guard);
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (dirty() || saving()) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    // Shell navigation outside the workspace still has to preserve the draft.
    const click = (event: MouseEvent) => {
      if (replaying || (!dirty() && !saving()) || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
        return;
      const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!link || link.target === "_blank" || link.hasAttribute("download")) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void guard().then((leave) => {
        if (leave && link.isConnected) {
          replaying = true;
          link.click();
          replaying = false;
        }
      });
    };
    document.addEventListener("click", click, true);
    // Ctrl/Cmd+S in the text saves, as the editor's own toolbar did before its deeds moved to the row above
    const keys = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s") return;
      if (!(event.target instanceof Node) || !area?.contains(event.target)) return;
      event.preventDefault();
      if (props.launch.canWrite && dirty() && !saving()) void save();
    };
    document.addEventListener("keydown", keys);
    onCleanup(() => {
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", click, true);
      document.removeEventListener("keydown", keys);
    });
  });
  onCleanup(() => {
    request?.abort();
    clearTimeout(savedTimer);
    props.onGuard(null);
  });
  const state = () =>
    saving() ? t().saving : dirty() ? t().unsaved : saved() ? t().saved : props.launch.canWrite ? t().v2AllSaved : t().v2ReadOnly;
  return (
    <Pane
      label={props.launch.entry.name}
      // the file is the title; whether its draft is saved is a state beside it, on the phone too (a status row's
      // filters leave there, the state of an open entry stays). Saving and closing are the deeds of this row.
      status={
        <Bar
          // title and state stand in the bar itself, not in an Inline (which wraps in a status place): the row stays one
          // line on the phone, and the title gives way with "…" before the state and the deeds
          start={
            <>
              <Text type="lead">{props.launch.entry.name}</Text>
              <Chip status={dirty() ? "warn" : "ok"}>{state()}</Chip>
            </>
          }
          end={
            <>
              <Show when={props.launch.canWrite}>
                <Button variant="primary" icon="device-floppy" busy={saving()} disabled={!dirty() || !ready()} onClick={() => void save()}>
                  {t().save}
                </Button>
              </Show>
              <Button variant="ghost" icon="x" label={t().close} onClick={props.onBack} />
            </>
          }
        />
      }
    >
      <Show when={error() && ready()}>
        <Notice
          tone="warn"
          actions={[
            { label: t().reload, icon: "refresh", disabled: saving(), onClick: () => void load() },
            { label: t().copy, icon: "copy", disabled: saving(), onClick: () => void save(true) },
          ]}
        >
          {error()}
        </Notice>
      </Show>
      <Show when={!props.launch.canWrite}>
        <Notice tone="note">{t().readonly}</Notice>
      </Show>
      <Canvas label={props.launch.entry.name}>
        {/* the editor's own edge is 12 px; 8 more put its text on the page's text edge of 20 px */}
        <div
          ref={(element) => {
            area = element;
            fill.ref(element);
          }}
          style={{ height: fill.height(), "padding-inline": "8px" }}
        >
          <Show when={!loading()} fallback={<Loading rows={12} />}>
            <Show when={ready()} fallback={<Failed text={error() || t().failed} onRetry={() => void load()} />}>
              <MarkdownEditor
                aria-label={props.launch.entry.name}
                value={text()}
                onValueChange={(value) => {
                  clearSaved();
                  setText(value);
                }}
                fill
                variant="embedded"
                disabled={!props.launch.canWrite}
              />
            </Show>
          </Show>
        </div>
      </Canvas>
    </Pane>
  );
}
