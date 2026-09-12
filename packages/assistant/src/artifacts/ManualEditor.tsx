import { Button, Dropdown, NoticeCard, Placeholder, Tabs, prompts, useLocale } from "@k2b/ui";
import { files } from "@k2b/stdlib/browser";
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { artifactMessages } from "./messages";
import { advancedMessages } from "./advanced-messages";
import { artifactClient } from "./client";
import { ArtifactPath, ArtifactSource } from "./contracts";
import type { ArtifactBundle } from "./service";
import { SourceEditor } from "./SourceEditor";
import { ArtifactPanel } from "./ArtifactPanel";

export function ManualEditor(props: {
  bundle: ArtifactBundle;
  userId: string;
  selectedFile?: string;
  onSaved: (bundle: ArtifactBundle) => void;
  onDirtyChange?:(dirty:boolean)=>void;
}) {
  const locale = useLocale(),
    t = () => artifactMessages.resolve([locale()]).t,
    a = () => advancedMessages.resolve([locale()]).t;
  const [base, setBase] = createSignal(props.bundle),
    [source, setSource] = createSignal<ArtifactSource>(structuredClone(props.bundle.source));
  // File identities stay stable while content changes, retaining editor undo/cursor state.
  const [paths, setPaths] = createSignal(source().files.map((f) => f.path));
  const [selected, setSelected] = createSignal(
    props.selectedFile && paths().includes(props.selectedFile) ? props.selectedFile : source().entry,
  );
  const [visited, setVisited] = createSignal(new Set([selected()]));
  const [busy, setBusy] = createSignal(false),
    [error, setError] = createSignal(""),
    [conflict, setConflict] = createSignal(false);
  const [renaming, setRenaming] = createSignal(false);
  const [run, setRun] = createSignal<{ revision: number; key: number; fixtures: File[] }>(),
    [fixtures, setFixtures] = createSignal<File[]>([]);
  const [mobile, setMobile] = createSignal("code");
  let fixtureInput:HTMLInputElement|undefined;
  const dirty = createMemo(() => JSON.stringify(source()) !== JSON.stringify(base().source));
  createEffect(()=>props.onDirtyChange?.(dirty()));
  onMount(() => {
    const leave = (event: BeforeUnloadEvent) => {
      if (dirty() || busy()) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", leave);
    onCleanup(() => window.removeEventListener("beforeunload", leave));
  });
  function choose(path: string) {
    setVisited((current) => new Set([...current, path]));
    setSelected(path);
    const url = new URL(location.href);
    url.searchParams.set("file", path);
    history.replaceState(null, "", url);
  }
  async function save(): Promise<ArtifactBundle | undefined> {
    if (busy()) return;
    if (!dirty()) return base();
    const snapshot = structuredClone(source()),
      previous = base();
    setBusy(true);
    setError("");
    setConflict(false);
    try {
      ArtifactSource.parse(snapshot);
      const next = await artifactClient.update(previous.id, {
        title: previous.title,
        description: previous.description ?? "",
        icon: previous.icon,
        source: snapshot,
        expectedRevision: previous.revision,
      });
      setBase(next);
      props.onSaved(next);
      return next;
    } catch (e) {
      setError(e instanceof Error ? e.message : t().REQUEST_FAILED);
      setConflict(!!e && typeof e === "object" && "code" in e && e.code === "CONFLICT");
    } finally {
      setBusy(false);
    }
  }
  async function start() {
    const saved = await save();
    if (saved) {
      setRun({ revision: saved.sourceRevision, key: Date.now(), fixtures: fixtures().slice() });
      setMobile("execution");
    }
  }
  async function fileAction(rename = false) {
    if (busy()) return;
    const value = await prompts.form({
      title: rename ? a().rename : a().newFile,
      fields: { path: { type: "text", label: a().path, required: true, defaultValue: rename ? selected() : "" } },
    });
    if (!value) return;
    try {
      ArtifactPath.parse(value.path);
      setError("");
      if (rename) {
        setBusy(true);
        setRenaming(true);
        const next = await artifactClient.renameSource(source(), selected(), value.path);
        setSource(next);
        setPaths(next.files.map((f) => f.path));
        choose(value.path);
      } else {
        const next = ArtifactSource.parse({ ...source(), files: [...source().files, { path: value.path, content: "" }] });
        setSource(next);
        setPaths(next.files.map((f) => f.path));
        choose(value.path);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : a().renameFailure);
    } finally {
      setBusy(false);
      setRenaming(false);
    }
  }
  async function remove() {
    if (selected() === source().entry) {
      setError(a().pickEntry);
      return;
    }
    if (!(await prompts.confirm(a().removeFile, { title: t().remove, variant: "danger" }))) return;
    const next = { ...source(), files: source().files.filter((f) => f.path !== selected()) };
    setSource(next);
    setPaths(next.files.map((f) => f.path));
    choose(next.entry);
  }
  return (
    <div class="assistant-manual-editor">
      <NoticeCard tone="info" title={a().manualEdit} detail={a().testHelp} />
      <div class="assistant-advanced-toolbar">
        <Dropdown.Root items={paths().map((path) => ({ label: path, action: () => choose(path) }))}>
          <Dropdown.Trigger variant="secondary" label={a().path}>
            {selected()}
          </Dropdown.Trigger>
        </Dropdown.Root>
        <Dropdown.Root
          items={[
            { label: a().newFile, icon: "ti ti-plus", action: () => fileAction() },
            { label: a().rename, icon: "ti ti-pencil", action: () => fileAction(true) },
            {
              label: a().entry,
              icon: "ti ti-player-play",
              disabled: !/\.(js|ts)$/.test(selected()) || source().entry === selected(),
              action: () => setSource({ ...source(), entry: selected() }),
            },
            { label: t().remove, icon: "ti ti-trash", action: remove },
          ]}
        >
          <Dropdown.Trigger iconOnly variant="ghost" label={t().actions} disabled={busy()}>
            <i class="ti ti-dots" />
          </Dropdown.Trigger>
        </Dropdown.Root>
        <Show when={dirty()}>
          <small role="status">{a().unsaved}</small>
        </Show>
        <Button size="sm" loading={busy()} disabled={!dirty()} onClick={() => void save()}>
          {t().save}
        </Button>
        <Button size="sm" disabled={busy()} onClick={() => void start()}>
          <i class="ti ti-player-play" />
          {a().run}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            files.downloadFileFromContent(JSON.stringify(source(), null, 2), "source-draft.json", "application/json");
          }}
        >
          {a().exportDraft}
        </Button>
      <input ref={fixtureInput} type="file" multiple hidden onChange={(event) => setFixtures(Array.from(event.currentTarget.files ?? []))} />
      <Button size="sm" variant="ghost" onClick={()=>fixtureInput?.click()}><i class="ti ti-file-upload"/>{a().fixtures}{fixtures().length?` (${fixtures().length})`:""}</Button>
      </div>
      <Show when={error()}>
        <NoticeCard tone="danger" title={error()} />
      </Show>
      <Show when={conflict()}>
        <NoticeCard tone="warning" title={t().sourceConflict} />
        <Button
          onClick={async () => {
            if (!(await prompts.confirm(a().loadConfirm, { title: t().loadLatest }))) return;
            setBusy(true);
            try {
              const next = await artifactClient.get(base().id);
              setBase(next);
              setSource(structuredClone(next.source));
              setPaths(next.source.files.map((f) => f.path));
              setSelected(next.source.entry);
              setConflict(false);
              setError("");
              props.onSaved(next);
            } catch (e) {
              setError(String(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {t().loadLatest}
        </Button>
      </Show>
      <div class="assistant-editor-mobile-tabs">
        <Tabs
          value={mobile}
          onValueChange={setMobile}
          ariaLabel={a().view}
          options={[
            { value: "code", label: a().code },
            { value: "execution", label: a().execution },
          ]}
        />
      </div>
      <div class="assistant-editor-split" data-mobile={mobile()}>
        <div class="assistant-editor-code">
          <For each={paths()}>
            {(path) => (
              <Show when={visited().has(path)}>
                <div class="assistant-editor-file" hidden={selected() !== path} inert={renaming()}>
                  <SourceEditor
                    path={path}
                    content={source().files.find((f) => f.path === path)?.content ?? ""}
                    onSave={() => void save()}
                    onRun={() => void start()}
                    onChange={(content) =>
                      setSource((current) => ({ ...current, files: current.files.map((f) => (f.path === path ? { ...f, content } : f)) }))
                    }
                  />
                </div>
              </Show>
            )}
          </For>
        </div>
        <div class="assistant-editor-execution">
          <Show
            when={run()}
            keyed
            fallback={<Placeholder title={a().execution} action={<Button onClick={() => void start()}>{t().start}</Button>} />}
          >
            {(execution) => (
              <ArtifactPanel
                artifactId={base().id}
                userId={props.userId}
                sourceRevision={execution.revision}
                test
                pickerInputs={execution.fixtures}
                autoStart
              />
            )}
          </Show>
        </div>
      </div>
    </div>
  );
}
