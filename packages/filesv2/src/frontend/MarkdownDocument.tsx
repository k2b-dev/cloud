import { AppWorkspace, Button, InlineGuidance, MarkdownEditor, Placeholder, prompts, toast } from "@k2b/ui";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { apiClient } from "../api/client";
import type { MarkdownLaunch } from "../contracts";
import { MARKDOWN_LIMIT, markdownRevision } from "../document-assets";
import { useAssetMessages } from "./asset-messages";
import { apiFailure } from "./file-preview";
import { uploadFile } from "./uploads";

export default function MarkdownDocument(props: {
  launch: MarkdownLaunch;
  onBack: () => void;
  onGuard: (guard: (() => Promise<boolean>) | null) => void;
}) {
  const t = useAssetMessages();
  const [text, setText] = createSignal("");
  const [original, setOriginal] = createSignal("");
  const [revision, setRevision] = createSignal<string>();
  const [loading, setLoading] = createSignal(true);
  const [saving, setSaving] = createSignal(false);
  const [saved, setSaved] = createSignal(false);
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
      const blob = new Blob(chunks);
      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(await blob.arrayBuffer());
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
    if (copy && (!name || /[\/\\]/.test(name))) return;
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
    onCleanup(() => {
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", click, true);
    });
  });
  onCleanup(() => {
    request?.abort();
    clearTimeout(savedTimer);
    props.onGuard(null);
  });
  return (
    <AppWorkspace.Main scroll={false} class="flex min-h-0 flex-col">
      <span role="status" class="sr-only">
        {saving() ? t().saving : dirty() ? t().unsaved : saved() ? t().saved : ""}
      </span>
      <Show when={error()}>
        <InlineGuidance tone="warning">
          {error()}{" "}
          <Button size="sm" variant="secondary" disabled={saving()} onClick={() => void load()}>
            {t().reload}
          </Button>
          <Show when={ready()}>
            <Button size="sm" variant="secondary" disabled={saving()} onClick={() => void save(true)}>
              {t().copy}
            </Button>
          </Show>
        </InlineGuidance>
      </Show>
      <Show when={!props.launch.canWrite}>
        <InlineGuidance>{t().readonly}</InlineGuidance>
      </Show>
      <Show
        when={!loading()}
        fallback={<Placeholder state="loading" title={t().loading} action={<Button onClick={props.onBack}>{t().back}</Button>} />}
      >
        <Show
          when={ready()}
          fallback={
            <Placeholder
              state="error"
              title={t().failed}
              action={
                <>
                  <Button onClick={props.onBack}>{t().back}</Button>
                  <Button onClick={() => void load()}>{t().retry}</Button>
                </>
              }
            />
          }
        >
          <MarkdownEditor
            aria-label={props.launch.entry.name}
            value={text()}
            onValueChange={(value) => {
              clearSaved();
              setText(value);
            }}
            fill
            variant="embedded"
            onClose={props.onBack}
            disabled={!props.launch.canWrite}
            onSave={() => void save()}
            saving={saving()}
            saved={saved()}
            saveDisabled={!dirty() || !props.launch.canWrite}
          />
        </Show>
      </Show>
    </AppWorkspace.Main>
  );
}
