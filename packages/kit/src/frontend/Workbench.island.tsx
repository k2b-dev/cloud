import { batch, createMemo, createSignal, For, Show, onCleanup, onMount } from "solid-js";
import { AppWorkspace, Button, Dropdown, MarkdownView, Paper, prompts, useLocale } from "@k2b/ui";
import { KitSettings } from "./KitSettings";
import type { AccessEntry } from "@valentinkolb/cloud/contracts";
import { files } from "@k2b/stdlib/browser";
import { timing } from "@k2b/stdlib";
import { mutation } from "@k2b/stdlib/solid";
import { FilePath, LIMITS, type Entry, type Bundle, type ProjectInput } from "../contracts";
import { validateProject, discoverEntries, renameProjectFile, isPage, isNavigationFile } from "../project";
import { messages } from "./messages";
import { client, checked, displayError, KitRequestError } from "./client";
import { EditorWorkspace } from "./EditorWorkspace";
import { RuntimeView } from "./RuntimeView";
import { startRun } from "../runtime/host";
import { AppStorage } from "../runtime/storage";
import type { UiNode } from "../runtime/protocol";

export default function Workbench(props: { project: Bundle; userId: string; edit: boolean; entry: string; access: AccessEntry[] }) {
  const locale = useLocale(),
    t = () => messages.resolve([locale()]).t;
  const [saved, setSaved] = createSignal(props.project),
    [source, setSource] = createSignal(props.project.files),
    [name, setName] = createSignal(props.project.name),
    [description, setDescription] = createSignal(props.project.description),
    [persistent, setPersistent] = createSignal(props.project.persistenceEnabled);
  const [selectedFile, setSelectedFile] = createSignal(props.entry),
    [selectedEntry, setSelectedEntry] = createSignal(props.entry),
    [nodes, setNodes] = createSignal<UiNode[]>([]),
    [logs, setLogs] = createSignal<{ level: string; text: string; time: string }[]>([]),
    [error, setError] = createSignal(""),
    [active, setActive] = createSignal(false),
    [busy, setBusy] = createSignal(false),
    [settingsOpen, setSettingsOpen] = createSignal(false),
    [loading, setLoading] = createSignal(false);
  let container!: HTMLDivElement;
  let run: ReturnType<typeof startRun> | undefined;
  let generation = 0;
  let pickerCancel: (() => void) | undefined;
  const input = (): ProjectInput => ({
    name: name(),
    description: description(),
    persistenceEnabled: persistent(),
    files: source(),
  });
  const dirty = createMemo(
    () =>
      JSON.stringify(input()) !==
      JSON.stringify({
        name: saved().name,
        description: saved().description,
        persistenceEnabled: saved().persistenceEnabled,
        files: saved().files,
      }),
  );
  const entries = createMemo<Entry[]>(previous => discoverEntries(source(), previous), props.project.entries);
  const validation = createMemo(() => {
    if (!props.edit) return "";
    try { validateProject(input()); return ""; }
    catch (error) { return displayError(error, locale()); }
  });
  const [compiledSource, setCompiledSource] = createSignal("");
  const [conflict, setConflict] = createSignal(false);
  const stale = () => props.edit && (active() || loading()) && compiledSource() !== JSON.stringify(source());
  let stoppedRuns = Promise.resolve();
  const [clearing, setClearing] = createSignal(false);
  function stop() {
    generation++;
    pickerCancel?.();
    stoppedRuns = Promise.all([stoppedRuns, run?.stop()]).then(() => {});
    run = undefined;
    setActive(false);
    setBusy(false);
    setLoading(false);
    return stoppedRuns;
  }
  const save = mutation.create({
    mutation: async () => {
      setError("");
      const submitted = input();
      const validated = validateProject(submitted);
      const result = await checked(
        await client.projects[":id"].$put({
          param: { id: saved().id },
          json: { ...validated.project, expectedRevision: saved().revision },
        }),
      );
      batch(() => {
        setSaved(result);
        // The response acknowledges the submitted snapshot, never replaces a newer draft.
        if (JSON.stringify(input()) === JSON.stringify(submitted)) {
          setName(result.name); setDescription(result.description); setPersistent(result.persistenceEnabled);
        }
        setConflict(false);
      });
      return result;
    },
    onError: (e) => { setConflict(e instanceof KitRequestError && e.code === "REVISION_CONFLICT"); setError(displayError(e, locale())); },
  });
  function pick(multiple: boolean, folder: boolean, accept = "") {
    return new Promise<File[]>((resolve) => {
      const el = document.createElement("input");
      el.type = "file";
      el.multiple = multiple;
      el.accept = accept;
      el.webkitdirectory = folder;
      const done = (files: File[]) => {
        el.remove();
        pickerCancel = undefined;
        resolve(files);
      };
      el.onchange = () => done(Array.from(el.files ?? []));
      el.oncancel = () => done([]);
      pickerCancel = () => done([]);
      el.hidden = true;
      document.body.append(el);
      el.click();
    });
  }
  const logTime = () => new Date().toLocaleTimeString(locale(), { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const logLabel = (level: string) => ({ info: "inf", warn: "wrn", error: "err", system: "sys", debug: "dbg" })[level] ?? "log";
  async function start() {
    if (clearing() || loading() || isPage(selectedEntry())) return;
    if (props.edit && validation()) { setError(validation()); return; }
    stop();
    const token = generation;
    const snapshot = input();
    setCompiledSource(JSON.stringify(snapshot.files));
    setNodes([]);
    setLogs([{ level: "system", text: t().consoleStarted, time: logTime() }]);
    setError("");
    setLoading(true);
    const minimumVisible = timing.withMinLoadTime(async () => {}, 150);
    let initializing = true;
    const finishLaunch = async (failed = false) => {
      await minimumVisible;
      if (token !== generation) return;
      if (failed) {
        run?.stop();
        run = undefined;
        setActive(false);
      }
      setLoading(false);
    };
    try {
      const response = await client.projects[":id"].compile.$post({
        param: { id: saved().id },
        json: {
          entry: selectedEntry(),
          ...(props.edit ? { preview: snapshot } : {}),
        },
      });
      const code = await checked<Awaited<ReturnType<typeof response.json>>>(response);
      if (!("runtime" in code)) throw new KitRequestError("INVALID_PROJECT", code.message, 400);
      if (token !== generation) return;
      run = startRun(container, code, new AppStorage(props.userId, saved().id, persistent()), {
        ui: setNodes,
        log: (level, text) => setLogs((l) => [...l, { level, text, time: logTime() }].slice(-200)),
        error: (message) => {
          setLogs((l) => [...l, { level: "error", text: message, time: logTime() }].slice(-200));
          setError(props.edit ? t().runtimeError : `${t().runtimeError} ${message}`);
          if (initializing) {
            initializing = false;
            void finishLaunch(true);
          }
        },
        busy: (value) => {
          setBusy(value);
          if (value) setError("");
        },
        ready: () => {
          initializing = false;
          void finishLaunch();
        },
        pick,
        save: async (data, filename) => {
          files.downloadFileFromContent(data, filename, typeof data === "string" ? "text/csv;charset=utf-8" : data.type || "application/octet-stream");
        },
      });
      setActive(true);
    } catch (e) {
      if (token !== generation) return;
      setError(displayError(e, locale()));
      await finishLaunch(true);
    }
  }
  async function switchEntry(path: string) {
    if (busy() && !(await prompts.confirm(t().confirmLeave, { title: t().stop }))) return false;
    stop();
    setSelectedEntry(path);
    setLogs([]);
    setNodes([]);
    const url = new URL(location.href);
    url.searchParams.set("page", path);
    history.replaceState(null, "", url);
    return true;
  }
  async function pathPrompt(title: string, initial: string, from?: string, entryOnly = false) {
    const result = await prompts.form({ title, confirmText: t().save, fields: {
      path: { type: "text", label: t().path, default: initial, required: true, validate: value => {
        if (!value || !FilePath.safeParse(value).success) return t().invalidPath;
        if (entryOnly && !value.endsWith(".script.js")) return t().entryPath;
        if (value !== from && source().some(file => file.path === value)) return t().duplicatePath;
        if (from && isNavigationFile(from) && !isNavigationFile(value) && entries().length === 1) return t().lastEntry;
        return null;
      } },
    } });
    return result?.path;
  }
  async function addFile(entryOnly = false, markdown = false) {
    if (source().length >= LIMITS.files) { setError(t().tooManyFiles); return; }
    let index = 1;
    const base = markdown ? "documentation" : entryOnly ? "tool" : "new";
    const extension = markdown ? ".md" : ".script.js";
    let initial = `${base}${extension}`;
    while (source().some(file => file.path === initial)) initial = `${base}-${index++}${extension}`;
    const path = await pathPrompt(markdown ? t().addPage : entryOnly ? t().newTool : t().addFile, initial, undefined, entryOnly);
    if (!path) return;
    if (isNavigationFile(path) && busy() && !(await prompts.confirm(t().confirmLeave, { title: t().stop }))) return;
    if (isNavigationFile(path)) stop();
    batch(() => {
      setSource(files => [...files, { path, content: path.endsWith(".script.js") ? 'export default kit.script({ name: "New tool", run() { kit.ui.text("Hello"); } });\n' : isPage(path) ? "# Documentation\n\n" : "" }]);
      setSelectedFile(path); setError("");
    });
    if (isNavigationFile(path)) await switchEntry(path);
  }
  async function removeFile(path: string) {
    if (isNavigationFile(path) && entries().length === 1) { setError(t().lastEntry); return; }
    if (!(await prompts.confirm(`${t().deleteFile}: ${path}?`, { title: t().deleteFile, variant: "danger", confirmText: t().deleteFile }))) return;
    if (path === selectedEntry() && !(await switchEntry(entries().find(entry => entry.path !== path)!.path))) return;
    batch(() => {
      setSource(files => files.filter(file => file.path !== path));
      if (selectedFile() === path) setSelectedFile(source()[0]!.path);
      setError("");
    });
  }
  async function renameFile(from: string) {
    const path = await pathPrompt(t().renameFile, from, from);
    if (!path || path === from) return;
    try {
      const renamed = renameProjectFile(source(), from, path);
      if (from === selectedEntry() && busy() && !(await prompts.confirm(t().confirmLeave, { title: t().stop }))) return;
      const selected = from === selectedEntry();
      if (selected) stop();
      batch(() => {
        setSource(renamed);
        if (selectedFile() === from) setSelectedFile(path);
        if (selected) setSelectedEntry(isNavigationFile(path) ? path : entries()[0]!.path);
        setError("");
      });
      if (selected) await switchEntry(selectedEntry());
    } catch (error) { setError(`${t().renameBlocked} ${displayError(error, locale())}`); }
  }
  function downloadDraft() {
    files.downloadFileFromContent(JSON.stringify({ ...input(), expectedRevision: saved().revision }, null, 2), `${saved().id}-draft.json`, "application/json");
  }
  async function loadLatest() {
    if (dirty() && !(await prompts.confirm(t().confirmLoadLatest, { title: t().loadLatest, confirmText: t().loadLatest }))) return;
    // A reload is deliberate after the draft warning, never an automatic overwrite on conflict.
    window.removeEventListener("beforeunload", leave);
    location.reload();
  }
  async function settings() {
    if (settingsOpen()) return;
    if (dirty()) {
      setError(t().saveFirst);
      return;
    }
    setSettingsOpen(true);
    try {
      const project = await checked(await client.projects[":id"].$get({ param: { id: saved().id } }));
      const access =
        project.permission === "admin"
          ? await checked(
              await client.projects[":id"].access.$get({
                param: { id: saved().id },
              }),
            )
          : [];
      await prompts.dialog<void>(
        (close) => (
          <KitSettings
            userId={props.userId}
            project={project}
            access={access}
            close={() => close()}
            onSaved={(result) => {
              setSaved(result);
              setSource(result.files);
              setName(result.name);
              setDescription(result.description);
              setPersistent(result.persistenceEnabled);
              stop();
              setNodes([]);
            }}
          />
        ),
        {
          surface: "bare",
          header: false,
          size: "large",
          cancelBehavior: "ignore",
        },
      );
    } catch (e) {
      setError(displayError(e, locale()));
    } finally {
      setSettingsOpen(false);
    }
  }
  const leave = (e: BeforeUnloadEvent) => {
    if (dirty() || busy()) {
      e.preventDefault();
      e.returnValue = "";
    }
  };
  onMount(() => {
    window.addEventListener("beforeunload", leave);

    onCleanup(() => {
      stop();
      window.removeEventListener("beforeunload", leave);
    });
  });
  function navigation() {
    return (
      <>
        <AppWorkspace.SidebarItem href="/app/kit" icon="ti ti-arrow-left">
          {t().all}
        </AppWorkspace.SidebarItem>
        <For
          each={
            props.edit
              ? source().map((f) => ({
                  path: f.path,
                  name: f.path,
                  icon: isPage(f.path) ? "ti ti-file-text" : "ti ti-file-code",
                }))
              : entries()
          }
        >
          {(entry) => (
            <AppWorkspace.SidebarItem
              icon={entry.icon}
              actions={
                props.edit ? (
                  <Dropdown.Root
                    items={[
                      { label: t().renameFile, icon: "ti ti-pencil", action: () => void renameFile(entry.path) },
                      { label: t().deleteFile, icon: "ti ti-trash", variant: "danger", action: () => void removeFile(entry.path) },
                    ]}
                  >
                    <Dropdown.Trigger iconOnly label={`${t().fileActions}: ${entry.path}`}>
                      <i class="ti ti-dots" aria-hidden="true" />
                    </Dropdown.Trigger>
                  </Dropdown.Root>
                ) : undefined
              }
              active={(props.edit ? selectedFile() : selectedEntry()) === entry.path}
              onClick={() => (props.edit ? setSelectedFile(entry.path) : switchEntry(entry.path))}
            >
              {entry.name}
            </AppWorkspace.SidebarItem>
          )}
        </For>
        <Show when={props.edit}>
          <AppWorkspace.SidebarItem icon="ti ti-plus" tone="success" onClick={() => addFile()}>
            {t().addFile}
          </AppWorkspace.SidebarItem>
          <AppWorkspace.SidebarItem icon="ti ti-file-plus" tone="success" onClick={() => addFile(false, true)}>{t().addPage}</AppWorkspace.SidebarItem>
        </Show>
      </>
    );
  }
  async function clearLocalData() {
    if (
      clearing() ||
      !(await prompts.confirm(t().confirmClearLocal, { title: t().clearLocal, confirmText: t().clearLocal, variant: "danger" }))
    )
      return;
    setClearing(true);
    try {
      await stop();
      await new AppStorage(props.userId, saved().id, true).clear();
      setNodes([]);
    } catch (e) {
      setError(displayError(e, locale()));
    } finally {
      setClearing(false);
    }
  }
  function footer() {
    return (
      <>
        <Show when={saved().permission === "admin"}>
          <AppWorkspace.SidebarItem
            href={`/app/kit/${saved().id}${props.edit ? "" : "/edit"}`}
            icon={props.edit ? "ti ti-player-play" : "ti ti-code"}
          >
            {props.edit ? t().use : t().edit}
          </AppWorkspace.SidebarItem>
        </Show>
        <AppWorkspace.SidebarItem icon="ti ti-trash" onClick={clearLocalData} disabled={clearing() || settingsOpen()}>
          {t().clearLocal}
        </AppWorkspace.SidebarItem>
        <AppWorkspace.SidebarItem icon="ti ti-settings" onClick={settings} disabled={settingsOpen() || clearing()}>
          {t().settings}
        </AppWorkspace.SidebarItem>
      </>
    );
  }
  const runControls = () => (
    <Show when={active() || loading()}>
      <Button variant="ghost" size="xs" onClick={start} disabled={loading()}>
        <i class="ti ti-refresh" aria-hidden="true" /> {t().restart}
      </Button>
      <Button variant="ghost" size="xs" onClick={stop}>
        <i class="ti ti-player-stop" aria-hidden="true" /> {t().stop}
      </Button>
    </Show>
  );
  const preview = () => (
    <Show when={isPage(selectedEntry())} fallback={
    <section class="kit-preview" aria-label={props.edit ? t().preview : t().use}>
      <div ref={container} hidden />
      <Show when={stale()}><p class="kit-preview-stale" role="status">{t().previewStale}</p></Show>
      <Show
        when={active() && !loading()}
        fallback={
          <div class="kit-launch" aria-busy={loading()}>
            <Button class="kit-launch-button" variant="ghost" size="lg" aria-label={t().launch} loading={loading()} onClick={start}>
              <Show when={!loading()}>
                <i class="ti ti-player-play" aria-hidden="true" />
              </Show>
            </Button>
            <p role="status">{loading() ? t().launching : t().launch}</p>
          </div>
        }
      >
        <RuntimeView nodes={nodes()} busy={busy()} event={(id, value) => run?.event(id, value)} />
      </Show>
      <Show when={props.edit}>
        <Paper as="section" class="kit-console" aria-label={t().console}>
          <div class="kit-console-header">
            <h2 class="text-sm font-semibold">
              <i class="ti ti-terminal-2" aria-hidden="true" /> {t().console}
            </h2>
            <div class="kit-console-actions">{runControls()}</div>
          </div>
          <Show when={logs().length} fallback={<p class="text-sm text-muted">{t().noLogs}</p>}>
            <pre role="log" aria-live="polite">
              <For each={logs()}>
                {(entry) => (
                  <span class="kit-console-line" data-level={entry.level}>
                    <span class="kit-console-time">{entry.time}</span>{" "}
                    <span class="kit-console-level">{logLabel(entry.level)}:</span> {entry.text}{"\n"}
                  </span>
                )}
              </For>
            </pre>
          </Show>
        </Paper>
      </Show>
    </section>}>
      <section class="kit-markdown-page" aria-label={props.edit ? t().preview : t().use}>
        <MarkdownView markdown={source().find(file => file.path === selectedEntry())?.content ?? ""} />
      </section>
    </Show>
  );
  return (
    <AppWorkspace class={`kit-workspace ${props.edit ? "kit-edit" : "kit-use"}`}>
      <AppWorkspace.Sidebar>
        <AppWorkspace.SidebarMobileTrigger label={props.edit ? t().files : t().pages} />
        <AppWorkspace.SidebarMobile>
          <AppWorkspace.SidebarMobileItems>
            {navigation()}
            {footer()}
          </AppWorkspace.SidebarMobileItems>
        </AppWorkspace.SidebarMobile>
        <AppWorkspace.SidebarDesktop>
          <AppWorkspace.SidebarBody>
            <AppWorkspace.SidebarSection title={props.edit ? t().files : t().pages}>{navigation()}</AppWorkspace.SidebarSection>
          </AppWorkspace.SidebarBody>
          <AppWorkspace.SidebarFooter>{footer()}</AppWorkspace.SidebarFooter>
        </AppWorkspace.SidebarDesktop>
      </AppWorkspace.Sidebar>
      <AppWorkspace.Content>
        <AppWorkspace.Main class="kit-main" scroll={!props.edit}>
          <div class="kit-toolbar">
            <div>
              <p class="text-sm text-muted">{props.edit ? `${t().edit} · ${dirty() ? t().dirty : t().saved}` : saved().name}</p>
              <h1 class="text-xl font-semibold">{props.edit ? saved().name : entries().find((e) => e.path === selectedEntry())?.name}</h1>
            </div>
            <div class="kit-flow kit-flow-row kit-gap-sm">
              <Show when={!props.edit}>{runControls()}</Show>
              <Show when={props.edit}>
                <Button
                  variant="ghost"
                  onClick={async () => {
                    if (!dirty() || (await prompts.confirm(t().discard, { title: t().discardTitle }))) {
                      window.removeEventListener("beforeunload", leave);
                      location.assign(`/app/kit/${saved().id}`);
                    }
                  }}
                >
                  {t().cancel}
                </Button>
                <Button onClick={() => { if (!save.loading()) save.mutate(undefined); }} loading={save.loading()}>
                  {t().save}
                </Button>
              </Show>
            </div>
          </div>
          <Show when={error()}>
            <div class="kit-error" role="alert">
              {error()}
            </div>
          </Show>
          <Show when={conflict()}>
            <div class="kit-flow kit-flow-row kit-gap-sm">
              <Button variant="secondary" onClick={downloadDraft}>{t().downloadDraft}</Button>
              <Button variant="secondary" onClick={loadLatest}>{t().loadLatest}</Button>
            </div>
          </Show>
          <Show when={props.edit && validation()}><div class="kit-validation" role="status" aria-label={t().validationTitle}>{validation()}</div></Show>
          <Show when={props.edit} fallback={<div class="kit-use-content">{preview()}</div>}>
            <div class="kit-editor-area">
              <EditorWorkspace
                files={source()}
                selected={selectedFile()}
                onSelect={setSelectedFile}
                onChange={(path, content) => batch(() => {
                  setSource((fs) => fs.map((f) => (f.path === path ? { ...f, content } : f)));
                  if (!conflict()) setError("");
                })}
                onSave={() => { if (!save.loading()) save.mutate(undefined); }}
                onAdd={addFile}
                preview={preview}
                previews={entries()}
                selectedPreview={selectedEntry()}
                onPreviewSelect={switchEntry}
              />
            </div>
          </Show>
        </AppWorkspace.Main>
      </AppWorkspace.Content>
    </AppWorkspace>
  );
}
