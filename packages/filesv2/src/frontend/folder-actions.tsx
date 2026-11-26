import { downloadArchive } from "@k2b/filegate/utils";
import { showFileDialog, showFolderDialog } from "@k2b/stdlib/browser";
import { mutation } from "@k2b/stdlib/solid";
import { Button, FileDropTarget, InlineGuidance, Lightbox, prompts, toast, useLocale } from "@k2b/ui";
import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import { apiClient } from "../api/client";
import type { BaseSummary, EditorInfo, FileEntry } from "../contracts";
import { isMarkdown } from "../document-assets";
import { type DocumentKind, documentExtension, editableExtension } from "../documents";
import { useAssetMessages } from "./asset-messages";
import { baseLabel } from "./base-label";
import { useBrowserMessages } from "./browser-messages";
import { readDroppedEntries, uploadRelativePath } from "./dropped-files";
import { fileLightboxItem } from "./file-lightbox";
import { apiFailure, contentLease } from "./file-preview";
import { askReplace, type FilesUploads, type ReplacePolicy } from "./files-uploads";
import { openDestinationDialog } from "./MoveDialog";
import { useFilesMessages } from "./messages";
import { openNewFolderDialog } from "./NewFolderDialog";
import { openPdfExtractDialog, openPdfMergeDialog, PdfOperationError, type PdfOperationRequest, runPdfOperation } from "./pdf-actions";
import { previewSource } from "./preview-client";
import { systemEntry, systemEntryLabel } from "./system-files";
import { openTemplatePicker } from "./Templates";
import { UploadSurface } from "./UploadPanel";
import { UploadConflict, uploadFile } from "./uploads";

/*
 * What can be done in a folder, apart from how the folder looks: uploads, new entries, moving, copying, the trash,
 * downloads, PDF actions and the large preview. The v2 folder screen shows these; their questions and dialogs are still
 * the v1 prompts until v2 has a dialog for each (PR 3 of the Files migration).
 */

const nameValid = (value: string | undefined) =>
  !!value && !value.includes("/") && value.trim() === value && value !== "." && value !== "..";
const parentPath = (path: string) => path.split("/").slice(0, -1).join("/");
const relativeName = uploadRelativePath;
/** Paths without the ones inside another of them: moving a folder takes what is in it along. */
const normalizedPaths = (paths: readonly string[]) =>
  [...new Set(paths)].filter((path) => !paths.some((parent) => parent !== path && path.startsWith(`${parent}/`)));
type BatchItem = { path: string; ok: boolean; error?: string };

/** A new file still being made, such as a merged PDF: its progress or failure at its place, with its own deeds. */
export type FolderOperation = {
  id: string;
  name: string;
  /** The entry it stands after in the list. */
  afterPath: string;
  state: "running" | "failed";
  text: string;
  actions: readonly { label: string; onClick: () => void }[];
};

type Operation = {
  id: string;
  request: PdfOperationRequest;
  verb: string;
  summary: string;
  location: string;
  base: string;
  afterPath: string;
  state: "running" | "failed";
  percent: number;
  error?: { code?: string; message: string; path?: string };
  controller: AbortController;
};

export type FolderContext = {
  base: () => BaseSummary;
  bases: () => readonly BaseSummary[];
  folder: () => string;
  /** The listed entries in their order; new files and failed entries are placed and chosen among them. */
  entries: () => readonly FileEntry[];
  /** Identity of what the screen shows; a question answered after the person moved on does nothing. */
  location: () => string;
  searching: () => boolean;
  canCreate: () => boolean;
  editor: () => EditorInfo | null;
  uploads: FilesUploads;
  /** Loads the folder again, then opens `selectPath` when given. */
  refresh: (selectPath?: string | null) => Promise<void>;
  onEdit: (entry: FileEntry) => void;
  onShare: (paths: readonly string[]) => void;
  /** Selects these entries, such as the ones a batch could not move. */
  select: (paths: readonly string[]) => void;
};

export function createFolderActions(ctx: FolderContext) {
  const t = useFilesMessages();
  const b = useBrowserMessages();
  const assets = useAssetMessages();
  const locale = useLocale();
  const baseId = () => ctx.base().id;
  let mounted = false;
  onMount(() => {
    mounted = true;
  });
  onCleanup(() => {
    mounted = false;
  });
  const folderLabel = (path: string) => path.split("/").at(-1) || baseLabel(ctx.base(), b(), locale());

  const download = mutation.create({
    mutation: async (items: readonly FileEntry[], { abortSignal }) => {
      if (items.length === 1 && !items[0]!.directory) {
        const lease = await contentLease(baseId(), items[0]!.path, abortSignal, t().downloadFailed);
        const link = document.createElement("a");
        link.href = lease.url;
        link.download = items[0]!.name;
        link.rel = "noreferrer";
        document.body.append(link);
        link.click();
        link.remove();
        return;
      }
      const response = await apiClient.bases[":baseId"].archive.$post(
        { param: { baseId: baseId() }, json: { paths: normalizedPaths(items.map((item) => item.path)) } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) return apiFailure(response, t().downloadFailed);
      downloadArchive(await response.json());
    },
    onError: (error) => toast.error(error.message),
  });
  onCleanup(() => download.abort());

  let actionLocation: string | null = null;
  const action = mutation.create({
    mutation: async (run: () => Promise<void>) => {
      actionLocation = ctx.location();
      try {
        await run();
      } finally {
        actionLocation = null;
      }
    },
    onError: (error) => toast.error(error.message),
  });
  const busy = () => download.loading() || action.loading();
  const runAction = (run: () => Promise<void>) => {
    if (!busy()) void action.mutate(run);
  };
  const here = () => mounted && actionLocation === ctx.location();
  const startDownload = (items: readonly FileEntry[]) => {
    if (items.length && !busy()) void download.mutate(items);
  };

  // Questions still open when the screen leaves are closed; files already queued keep uploading.
  const questions = new AbortController();
  onCleanup(() => questions.abort());

  /** Every name question says where the entry will live. */
  const askName = (title: string, label: string, initial = "") => {
    const source = ctx.location();
    return prompts
      .form({
        title,
        fields: {
          location: {
            type: "info",
            content: () => (
              <InlineGuidance icon="ti ti-folder">
                <span class="break-all">{`${baseLabel(ctx.base(), b(), locale())} / ${ctx.folder()}`.replace(/ \/ $/, "")}</span>
              </InlineGuidance>
            ),
          },
          name: {
            type: "text",
            label,
            required: true,
            maxLength: 255,
            default: initial,
            validate: (value) => (nameValid(value) ? null : b().newFolderInvalid),
          },
        },
      })
      .then((values) => (values && source === ctx.location() ? String(values.name) : null));
  };

  // One question per folder upload that carries system files; skipping is the main answer.
  const askSystemFiles = (entries: readonly string[], signal: AbortSignal) =>
    prompts.dialog<"skip" | "all">(
      (close) => (
        <>
          <div class="flex flex-col gap-3 text-sm">
            <p>
              {b().systemFilesQuestion({
                count: entries.length,
                examples: [...new Set(entries.map(systemEntryLabel))].slice(0, 2).join(", "),
              })}
            </p>
            <InlineGuidance icon="ti ti-info-circle">{b().systemFilesHint}</InlineGuidance>
          </div>
          <div class="filesv2-system-files__actions flex flex-wrap justify-end gap-2">
            <Button variant="ghost" onClick={() => close()}>
              {b().cancel}
            </Button>
            <Button variant="secondary" onClick={() => close("all")}>
              {b().uploadAll}
            </Button>
            <Button onClick={() => close("skip")}>{b().uploadWithoutSystemFiles}</Button>
          </div>
        </>
      ),
      { title: b().systemFilesTitle, icon: "ti ti-eye-off", signal },
    );

  /*
   * Uploads: the queue opens a Filegate session per file, after recreating dropped folders. This only decides what to
   * send: hidden system files inside folders and names the listing already holds are each asked about once.
   */
  const prepareUpload = async (input: { files: readonly File[]; directories: readonly string[]; hidden: number; root: string }) => {
    const signal = questions.signal;
    const base = baseId();
    const root = input.root;
    const label = folderLabel(root);
    const known = new Set(
      root === ctx.folder()
        ? ctx
            .entries()
            .filter((item) => !item.directory)
            .map((item) => item.name)
        : [],
    );
    let { files, directories } = input;
    const system = new Set<string>();
    for (const path of [...files.map(relativeName), ...directories]) {
      const entry = systemEntry(path);
      if (entry) system.add(entry);
    }
    if (system.size) {
      const choice = await askSystemFiles([...system], signal);
      if (!choice || signal.aborted) return;
      if (choice === "skip") {
        files = files.filter((file) => !systemEntry(relativeName(file)));
        directories = [...directories.filter((path) => !systemEntry(path)), ...[...system].map(parentPath)];
      }
    }
    let policy: ReplacePolicy = "ask";
    const conflicts = files.filter((file) => !relativeName(file).includes("/") && known.has(file.name)).length;
    if (conflicts) {
      const decided = await askReplace(b(), files.find((file) => known.has(file.name))?.name ?? "", conflicts, files.length, signal);
      if (!decided || signal.aborted) return;
      policy = decided;
    }
    const folders = new Set<string>(directories.filter(Boolean));
    for (const file of files) {
      const parts = relativeName(file).split("/").slice(0, -1);
      for (let i = 1; i <= parts.length; i++) folders.add(parts.slice(0, i).join("/"));
    }
    if (input.hidden) toast(b().hiddenLeftOut(input.hidden), { duration: 8000 });
    // Only empty folders: nothing to transfer, so they are made like a new folder.
    if (!files.length) {
      if (folders.size)
        runAction(async () => {
          for (const path of [...folders].sort()) {
            const response = await apiClient.bases[":baseId"].directories.$post({
              param: { baseId: base },
              json: { path: root ? `${root}/${path}` : path },
            });
            if (!response.ok && (response.status as number) !== 409) await apiFailure(response, t().unavailable);
          }
          await ctx.refresh();
        });
      return;
    }
    ctx.uploads.add(
      { baseId: base, root, folders: [...folders].sort(), policy, total: files.length },
      {
        key: JSON.stringify([base, root]),
        label,
        href: `/app/filesv2?base=${encodeURIComponent(base)}${root ? `&path=${encodeURIComponent(root)}` : ""}`,
      },
      files.map((file) => ({ file, path: relativeName(file) })),
    );
  };
  const startUpload = (files: readonly File[], directories: readonly string[] = [], hidden = 0, root = ctx.folder()) => {
    if (!files.length && !directories.length) return;
    if (busy() || ctx.searching() || !ctx.canCreate()) {
      toast(b().uploadUnavailable);
      return;
    }
    void prepareUpload({ files, directories, hidden, root });
  };
  const pickFiles = () =>
    void showFileDialog({ multiple: true }).then(
      (files) => startUpload(files),
      () => {},
    );
  const pickFolder = () =>
    void showFolderDialog().then(
      (files) => startUpload(files),
      () => {},
    );

  let dropPreparation: AbortController | undefined;
  onCleanup(() => dropPreparation?.abort());
  /** Files dropped from outside the page; folder entries are read while the drop is still running. */
  const dropFiles = (files: readonly File[], dataTransfer: DataTransfer, root: string) => {
    const dropped = Array.from(dataTransfer.items ?? [])
      .map((item) => item.webkitGetAsEntry?.())
      .filter((entry): entry is FileSystemEntry => !!entry);
    if (!dropped.some((entry) => entry.isDirectory)) {
      startUpload(files, [], 0, root);
      return;
    }
    dropPreparation?.abort();
    const request = new AbortController();
    dropPreparation = request;
    const source = ctx.location();
    const timer = setTimeout(() => request.abort(), 30_000);
    const notice = toast(b().readingDrop, {
      duration: 0,
      progress: "indeterminate",
      action: { label: b().cancel, onClick: () => request.abort() },
    });
    const fail = (message: string) => {
      if (notice.update(message, { variant: "error", progress: null, duration: undefined, action: null }) === false) toast.error(message);
    };
    void readDroppedEntries(dropped, request.signal)
      .then((result) => {
        if (request.signal.aborted || source !== ctx.location()) return notice.dismiss();
        if (result.errors.length) fail(result.errors.join("\n"));
        else notice.dismiss();
        startUpload(result.files, result.directories, result.hidden.length, root);
      })
      .catch((error) => {
        if (request.signal.aborted) notice.dismiss();
        else fail(error instanceof Error && error.message === "drop_too_large" ? b().dropTooLarge : b().loadFailed);
      })
      .finally(() => clearTimeout(timer));
  };

  const editable = (entry: FileEntry) =>
    !entry.directory && (isMarkdown(entry.name) || (!!ctx.editor() && !!editableExtension(entry.name)));

  const createFolder = async () => {
    const source = ctx.location();
    const result = await openNewFolderDialog({
      title: b().newFolder,
      baseId: baseId(),
      parent: ctx.folder(),
      location: baseLabel(ctx.base(), b(), locale()),
      onPartial: () => void ctx.refresh(),
    });
    if (!result || source !== ctx.location()) return;
    const created = result.results.flatMap((item) => (item.state === "created" && item.entry ? [item.entry] : []));
    const [first] = created;
    if (first)
      toast.success(created.length === 1 ? b().folderCreated(first.path) : b().foldersCreated({ count: created.length, name: first.path }));
    await ctx.refresh(result.results[0]?.path);
  };
  // An empty file has nothing to transfer, so it is made at once instead of waiting behind an upload.
  const createFile = async () => {
    const name = await askName(b().newFile, b().newFileName);
    if (!name) return;
    const base = baseId();
    const path = ctx.folder() ? `${ctx.folder()}/${name}` : name;
    runAction(async () => {
      let onConflict: "error" | "overwrite" = "error";
      for (;;) {
        try {
          const result = await uploadFile(base, path, new File([], name), {
            onConflict,
            signal: questions.signal,
            fallback: t().unavailable,
          });
          toast.success(b().documentCreated(name));
          void ctx.refresh(result.entry.path);
          return;
        } catch (error) {
          if (!(error instanceof UploadConflict) || onConflict === "overwrite") throw error;
          if ((await askReplace(b(), name, 1, 1, questions.signal)) !== "overwrite") return;
          onConflict = "overwrite";
        }
      }
    });
  };
  const createMarkdown = async () => {
    const name = await askName(assets().markdown, assets().filename, assets().defaultMarkdown);
    if (!name) return;
    runAction(async () => {
      const path = [ctx.folder(), isMarkdown(name) ? name : `${name}.md`].filter(Boolean).join("/");
      const response = await apiClient.bases[":baseId"].markdown.$post({ param: { baseId: baseId() }, json: { path } });
      if (!response.ok) await apiFailure(response, assets().failed);
      const created = await response.json();
      if (here()) ctx.onEdit(created.entry);
    });
  };
  const createFromTemplate = async () => {
    const source = ctx.location();
    const template = await openTemplatePicker();
    if (!template || source !== ctx.location()) return;
    const name = await askName(assets().template, assets().filename, template.filename);
    if (!name || source !== ctx.location()) return;
    runAction(async () => {
      const response = await apiClient.templates[":id"].use.$post({
        param: { id: template.id },
        json: { baseId: baseId(), path: [ctx.folder(), name].filter(Boolean).join("/") },
      });
      if (!response.ok) await apiFailure(response, assets().failed);
      const created = await response.json();
      if (!here()) return;
      if (editable(created.entry)) ctx.onEdit(created.entry);
      else await ctx.refresh(created.entry.path);
    });
  };
  const createDocument = async (kind: DocumentKind, title: string) => {
    const extension = documentExtension(kind, ctx.editor()?.documentFormat ?? "odf");
    const name = await askName(title, b().documentName(extension));
    if (!name) return;
    const path = ctx.folder() ? `${ctx.folder()}/${name}` : name;
    runAction(async () => {
      const response = await apiClient.bases[":baseId"].documents.$post({ param: { baseId: baseId() }, json: { path, kind } });
      if (!response.ok) await apiFailure(response, t().unavailable);
      const created = await response.json();
      toast.success(b().documentCreated(created.entry.name));
      if (here()) ctx.onEdit(created.entry);
    });
  };

  const runBatches = async (paths: readonly string[], send: (batch: string[]) => Promise<BatchItem[]>) => {
    const results: BatchItem[] = [];
    for (let index = 0; index < paths.length; index += 100) {
      const batch = paths.slice(index, index + 100);
      try {
        results.push(...(await send(batch)));
      } catch (error) {
        results.push(...batch.map((path) => ({ path, ok: false, error: error instanceof Error ? error.message : t().unavailable })));
      }
    }
    return results;
  };
  /** Reports what worked and what not; the entries that failed stay chosen so the person can try them again. */
  const finishBatch = async (results: readonly BatchItem[], message: (count: number) => string, selectPath: string | null = null) => {
    const failures = results.filter((result) => !result.ok);
    const succeeded = results.length - failures.length;
    if (succeeded) toast.success(message(succeeded));
    if (failures.length) toast.error(failures.map((result) => `${result.path}: ${result.error ?? t().unavailable}`).join("\n"));
    await ctx.refresh(failures.length ? null : selectPath);
    if (failures.length && here()) ctx.select(failures.map((result) => result.path));
  };
  const moveIntoNewFolder = async (items: readonly FileEntry[]) => {
    const name = await askName(b().moveToNewFolder, b().newFolderName);
    if (!name) return;
    const path = ctx.folder() ? `${ctx.folder()}/${name}` : name;
    runAction(async () => {
      const made = await apiClient.bases[":baseId"].directories.$post({ param: { baseId: baseId() }, json: { path } });
      if (!made.ok) await apiFailure(made, t().unavailable);
      const base = baseId();
      const results = await runBatches(normalizedPaths(items.map((item) => item.path)), async (paths) => {
        const moved = await apiClient.bases[":baseId"].move.$post({ param: { baseId: base }, json: { paths, folder: path } });
        if (!moved.ok) await apiFailure(moved, t().unavailable);
        return (await moved.json()).results;
      });
      await finishBatch(results, b().moved, path);
    });
  };
  const moveOrCopy = async (items: readonly FileEntry[], copyOnly = false) => {
    const source = ctx.location();
    const destination = await openDestinationDialog({
      bases: ctx.bases(),
      sourceBaseId: baseId(),
      sourcePaths: items.map((item) => item.path),
      initialFolder: ctx.folder(),
      copyOnly,
    });
    if (!destination || source !== ctx.location()) return;
    runAction(async () => {
      const base = baseId();
      const results = await runBatches(normalizedPaths(items.map((item) => item.path)), async (paths) => {
        const response = destination.copy
          ? await apiClient.bases[":baseId"].copy.$post({
              param: { baseId: base },
              json: { paths, targetBaseId: destination.baseId, folder: destination.folder },
            })
          : await apiClient.bases[":baseId"].move.$post({ param: { baseId: base }, json: { paths, folder: destination.folder } });
        if (!response.ok) await apiFailure(response, t().unavailable);
        return (await response.json()).results;
      });
      await finishBatch(results, destination.copy ? b().copied : b().moved);
    });
  };
  const trashItems = async (items: readonly FileEntry[]) => {
    const source = ctx.location();
    const confirmed = await prompts.confirm(b().moveTrashQuestion({ n: items.length, name: items[0]?.name ?? "" }), {
      title: b().moveTrashTitle,
      icon: "ti ti-trash",
      variant: "danger",
      confirmText: b().trashSelection,
    });
    if (!confirmed || source !== ctx.location()) return;
    runAction(async () => {
      const base = baseId();
      const results = await runBatches(normalizedPaths(items.map((item) => item.path)), async (paths) => {
        const response = await apiClient.bases[":baseId"].delete.$post({ param: { baseId: base }, json: { paths } });
        if (!response.ok) await apiFailure(response, t().unavailable);
        return (await response.json()).results;
      });
      await finishBatch(results, b().trashed);
    });
  };
  const rename = async (item: FileEntry) => {
    const name = await askName(b().rename, b().newName, item.name);
    if (!name || name === item.name) return;
    runAction(async () => {
      const response = await apiClient.bases[":baseId"].rename.$post({ param: { baseId: baseId() }, json: { path: item.path, name } });
      if (!response.ok) await apiFailure(response, t().unavailable);
      toast.success(b().renamed);
      await ctx.refresh((await response.json()).entry.path);
    });
  };
  const duplicate = (item: FileEntry) =>
    runAction(async () => {
      const response = await apiClient.bases[":baseId"].copy.$post({
        param: { baseId: baseId() },
        json: { paths: [item.path], targetBaseId: baseId(), folder: parentPath(item.path) },
      });
      if (!response.ok) await apiFailure(response, t().unavailable);
      const result = await response.json();
      await finishBatch(result.results, () => b().duplicated, result.entries[0]?.path ?? null);
    });

  /*
   * PDF actions make a new file next to their sources. Until it exists, a row at that place shows the progress with
   * Cancel; a failure stays there with its reason and a way out. The originals never change.
   */
  const [operations, setOperations] = createSignal<readonly Operation[]>([]);
  let operationCount = 0;
  const [fresh, setFresh] = createSignal<ReadonlySet<string>>(new Set());
  onCleanup(() => {
    for (const operation of operations()) operation.controller.abort();
  });
  const patchOperation = (id: string, patch: Partial<Operation>) =>
    setOperations((all) => all.map((operation) => (operation.id === id ? { ...operation, ...patch } : operation)));
  const dropOperation = (id: string) => setOperations((all) => all.filter((operation) => operation.id !== id));
  const markFresh = (path: string) => {
    setFresh((all) => new Set(all).add(path));
    setTimeout(
      () =>
        setFresh((all) => {
          const next = new Set(all);
          next.delete(path);
          return next;
        }),
      10_000,
    );
  };
  /** Undo targets the storage the file was made in, also after the person moved on to another one. */
  const undoCreated = async (base: string, entry: FileEntry) => {
    try {
      const response = await apiClient.bases[":baseId"].delete.$post({ param: { baseId: base }, json: { paths: [entry.path] } });
      if (!response.ok) await apiFailure(response, t().unavailable);
      const failed = (await response.json()).results.find((result) => !result.ok);
      if (failed) throw new Error(failed.error ?? t().unavailable);
      toast.success(b().opUndone);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t().unavailable);
    }
    if (base === baseId()) await ctx.refresh();
  };
  const runOperation = (operation: Operation) => {
    const controller = new AbortController();
    patchOperation(operation.id, { controller, state: "running", percent: 0, error: undefined });
    void runPdfOperation(
      operation.base,
      operation.request,
      controller.signal,
      (done, total) => patchOperation(operation.id, { percent: total ? Math.round((done / total) * 100) : 0 }),
      t().unavailable,
    ).then(
      async (result) => {
        dropOperation(operation.id);
        if (operation.location === ctx.location()) {
          markFresh(result.entry.path);
          await ctx.refresh();
        }
        toast.success([b().opCreated(result.entry.name), operation.summary].filter(Boolean).join(" · "), {
          celebrate: true,
          action: { label: b().opUndo, variant: "ghost", onClick: () => void undoCreated(operation.base, result.entry) },
        });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return dropOperation(operation.id);
        const code = error instanceof PdfOperationError ? error.code : undefined;
        patchOperation(operation.id, {
          state: "failed",
          error: {
            code,
            message: error instanceof Error ? error.message : t().unavailable,
            path: error instanceof PdfOperationError ? error.path : undefined,
          },
        });
        // A file that changed meanwhile shows its current version, so choosing again starts from what is there now.
        if (code === "pdf_changed" && operation.location === ctx.location()) void ctx.refresh();
      },
    );
  };
  const startOperation = (request: PdfOperationRequest, verb: string, summary: string) => {
    const order = ctx.entries().map((entry) => entry.path);
    const afterPath = [...request.paths].sort((a, z) => order.indexOf(z) - order.indexOf(a))[0] ?? request.paths[0]!;
    const operation: Operation = {
      id: String(++operationCount),
      request,
      verb,
      summary,
      location: ctx.location(),
      base: baseId(),
      afterPath,
      state: "running",
      percent: 0,
      controller: new AbortController(),
    };
    ctx.select([]);
    setOperations((all) => [...all, operation]);
    runOperation(operation);
  };
  const isPdf = (entry: FileEntry) => !entry.directory && previewSource(entry) === "pdf";
  const mergePdfs = async (items: readonly FileEntry[]) => {
    const chosen = await openPdfMergeDialog({ baseId: baseId(), files: items, title: b().pdfMergeTitle(items.length) });
    if (!chosen) return;
    startOperation(chosen.request, b().opMerging, b().opMergeSummary({ pages: chosen.pages, files: chosen.request.paths.length }));
  };
  const extractPages = async (items: readonly FileEntry[]) => {
    const chosen = await openPdfExtractDialog({ baseId: baseId(), files: items, title: b().pdfExtract });
    if (!chosen) return;
    startOperation(chosen.request, b().opExtracting, b().opExtractSummary(chosen.pages));
  };
  /** The files in the making of this folder, worded for their row. */
  const folderOperations = createMemo((): FolderOperation[] =>
    operations()
      .filter((operation) => operation.location === ctx.location())
      .map((operation) => {
        if (operation.state === "running")
          return {
            id: operation.id,
            name: operation.request.name,
            afterPath: operation.afterPath,
            state: "running",
            text: b().opProgress({ verb: operation.verb, percent: operation.percent }),
            actions: [{ label: b().opCancel, onClick: () => operation.controller.abort() }],
          };
        const failedPath = operation.error?.path;
        const remaining = operation.request.paths.filter((path) => path !== failedPath);
        const without =
          operation.request.operation === "merge" && failedPath && remaining.length >= 2
            ? [
                {
                  label: b().opWithout,
                  onClick: () => {
                    // The page count of the first plan no longer holds, so the result names only the file.
                    const next = { ...operation, summary: "", request: { ...operation.request, paths: remaining } };
                    setOperations((all) => all.map((item) => (item.id === operation.id ? next : item)));
                    runOperation(next);
                  },
                },
              ]
            : operation.error?.code === "pdf_changed"
              ? []
              : [{ label: b().retry, onClick: () => runOperation(operation) }];
        return {
          id: operation.id,
          name: operation.request.name,
          afterPath: operation.afterPath,
          state: "failed",
          text: operation.error?.message ?? t().unavailable,
          actions: [...without, { label: b().opDiscard, onClick: () => dropOperation(operation.id) }],
        };
      }),
  );

  /*
   * A file opens large in the Lightbox, with the folder's other files to step through. A file an editor opens offers
   * it as Open.
   */
  const [viewing, setViewing] = createSignal<{ files: readonly FileEntry[]; base: string; index: number } | null>(null);
  const preview = (entry: FileEntry) => {
    const files = ctx.entries().filter((row) => !row.directory);
    const index = files.findIndex((row) => row.path === entry.path);
    setViewing({ files: index >= 0 ? files : [entry], base: baseId(), index: Math.max(0, index) });
  };
  const lightboxItems = createMemo(() => {
    const shown = viewing();
    if (!shown) return [];
    const messages = {
      open: b().open,
      openReadOnly: b().openReadOnly,
      openInTab: b().openInTab,
      copyText: b().copyText,
      copied: b().copiedText,
      share: b().shareSelection,
      failed: b().previewFailed,
    };
    return shown.files.map((entry) =>
      fileLightboxItem(
        shown.base,
        entry,
        {
          onDownload: (file) => startDownload([file]),
          onOpen: editable(entry) ? (file) => ctx.onEdit(file) : undefined,
          readOnly: (file) => file.actions?.write === false,
          onShare: entry.actions?.share !== false ? (file) => ctx.onShare([file.path]) : undefined,
        },
        messages,
        locale(),
      ),
    );
  });

  return {
    busy,
    editable,
    isPdf,
    startDownload,
    pickFiles,
    pickFolder,
    dropFiles,
    createFolder,
    createFile,
    createMarkdown,
    createFromTemplate,
    createDocument,
    rename,
    duplicate,
    moveOrCopy,
    moveIntoNewFolder,
    trashItems,
    mergePdfs,
    extractPages,
    operations: folderOperations,
    fresh,
    preview,
    /** The overlays of a folder: the upload progress, the window as a drop target and the large preview. */
    Layer: () => (
      <>
        <UploadSurface queue={ctx.uploads} />
        {/* k2b-ui gap: v2 has no drop target for files from outside the page (lane Y2: drag and drop incl. external
            drop). The v1 target covers the window meanwhile; dropping onto one folder row waits for Y2. */}
        <FileDropTarget
          label={b().dropInto({ name: folderLabel(ctx.folder()) })}
          disabled={ctx.searching() || !ctx.canCreate()}
          onDrop={(files, { dataTransfer }) => dropFiles(files, dataTransfer, ctx.folder())}
        />
        <Show when={viewing()}>
          {(shown) => (
            <Lightbox
              items={lightboxItems()}
              index={shown().index}
              onIndexChange={(index) => setViewing({ ...shown(), index })}
              onClose={() => setViewing(null)}
            />
          )}
        </Show>
      </>
    ),
  };
}
export type FolderActions = ReturnType<typeof createFolderActions>;
