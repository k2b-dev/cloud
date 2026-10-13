import { Button, prompts, SegmentedControl, TextInput } from "@k2b/ui";
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js";
import { apiClient } from "../api/client";
import { BATCH_LIMIT, type FolderBatchResult, type FolderResult } from "../contracts";
import { useBrowserMessages } from "./browser-messages";
import { apiFailure } from "./file-preview";
import { type CommaMode, type PlannedFolder, planFolders } from "./folder-plan";
import { useFilesMessages } from "./messages";

type NewFolderOptions = {
  title: string;
  baseId: string;
  /** Base-relative folder the new folders go into; "" at the base root. */
  parent: string;
  /** Display name of the base, the first crumb of the location line. */
  location: string;
  /** A submit that created only part of the plan; the listing behind the dialog shows what exists now. */
  onPartial: () => void;
};

/**
 * Asks for one name or a small tree: `A/B` nests, a comma in the last part creates siblings. Resolves with the
 * outcome once everything exists; a partial outcome stays in the dialog until the name is fixed or the dialog closes.
 */
export const openNewFolderDialog = (options: NewFolderOptions) =>
  prompts.dialog<FolderBatchResult>((close) => <NewFolderDialog {...options} close={close} />, {
    title: options.title,
    icon: "ti ti-folder-plus",
  });

function NewFolderDialog(props: NewFolderOptions & { close: (result?: FolderBatchResult) => void }) {
  const b = useBrowserMessages();
  const t = useFilesMessages();
  const [input, setInput] = createSignal("");
  const [commas, setCommas] = createSignal<CommaMode>("split");
  const plan = createMemo(() => planFolders(input(), { parent: props.parent, commas: commas() }));
  // What storage said per path: the latest check while typing. A submit's outcome sits on top until the next edit.
  const [checked, setChecked] = createSignal<ReadonlyMap<string, FolderResult>>(new Map());
  const [outcome, setOutcome] = createSignal<ReadonlyMap<string, FolderResult> | null>(null);
  const [failure, setFailure] = createSignal("");
  const [saving, setSaving] = createSignal(false);
  const stateOf = (path: string) => outcome()?.get(path) ?? checked().get(path);
  const remember = (results: readonly FolderResult[], submitted = false) =>
    setChecked((previous) => {
      const next = new Map(previous);
      for (const result of results) {
        // A folder this dialog just created exists now; anything a submit did not settle is checked again.
        if (result.state === "created") next.set(result.path, { path: result.path, state: "existing" });
        else if (submitted && result.state !== "existing") next.delete(result.path);
        else next.set(result.path, result);
      }
      return next;
    });

  // The check only annotates the preview, so it waits for a pause in typing and a failed check shows nothing.
  let timer: ReturnType<typeof setTimeout> | undefined;
  let check: AbortController | undefined;
  onCleanup(() => {
    clearTimeout(timer);
    check?.abort();
  });
  createEffect(
    on(plan, (current) => {
      setOutcome(null);
      setFailure("");
      clearTimeout(timer);
      check?.abort();
      if (!current.valid) return;
      const paths = current.folders.map((folder) => folder.path);
      timer = setTimeout(() => {
        const request = new AbortController();
        check = request;
        apiClient.bases[":baseId"].directories.batch
          .$post({ param: { baseId: props.baseId }, json: { paths, dryRun: true } }, { init: { signal: request.signal } })
          .then(async (response) => {
            if (!response.ok) return;
            const result = await response.json();
            if (!request.signal.aborted) remember(result.results);
          })
          .catch(() => undefined);
      }, 200);
    }),
  );

  const rows = createMemo(() => plan().folders.slice(0, BATCH_LIMIT));
  const settled = (folder: PlannedFolder) => ["existing", "created"].includes(stateOf(folder.path)?.state ?? "");
  const toCreate = createMemo(() => plan().folders.filter((folder) => !settled(folder)).length);
  // A conflict or missing permission found by the check blocks the submit; a failed submit may be retried.
  const blocked = createMemo(() => plan().folders.some((folder) => checked().get(folder.path)?.state === "failed"));
  const canSubmit = () => plan().valid && toCreate() > 0 && !blocked() && !saving();
  const partial = createMemo(() => {
    const results = outcome();
    if (!results) return null;
    const count = (state: FolderResult["state"]) => [...results.values()].filter((result) => result.state === state).length;
    return { created: count("created"), failed: count("failed"), skipped: count("skipped") };
  });

  const submit = async () => {
    if (!canSubmit()) return;
    const paths = plan().folders.map((folder) => folder.path);
    setSaving(true);
    setFailure("");
    try {
      const response = await apiClient.bases[":baseId"].directories.batch.$post({ param: { baseId: props.baseId }, json: { paths } });
      if (!response.ok) await apiFailure(response, t().unavailable);
      const result = await response.json();
      if (result.results.every((item) => item.state === "created" || item.state === "existing")) {
        props.close(result);
        return;
      }
      remember(result.results, true);
      setOutcome(new Map(result.results.map((item) => [item.path, item])));
      props.onPartial();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : t().unavailable);
    } finally {
      setSaving(false);
    }
  };

  const summary = () => {
    const done = partial();
    if (failure()) return { tone: "danger", text: failure() };
    if (done) return { tone: "danger", text: b().folderPlanPartial(done) };
    if (plan().tooMany) return { tone: "danger", text: b().folderPlanTooMany(BATCH_LIMIT) };
    if (!input()) return { tone: "hint", text: b().folderPlanEmpty };
    if (!plan().valid) return { tone: "danger", text: b().folderPlanInvalid };
    return { tone: "count", text: b().folderPlanCount(toCreate()) };
  };
  const note = (folder: PlannedFolder) => {
    if (folder.issue) return { tone: "danger", text: b().folderIssue(folder.issue) };
    const state = stateOf(folder.path);
    if (state?.state === "failed") return { tone: "danger", text: state.message ?? b().folderFailed };
    if (state?.state === "existing") return { tone: "muted", text: b().folderExisting };
    if (state?.state === "created") return { tone: "success", text: b().folderCreatedState };
    if (state?.state === "skipped") return { tone: "muted", text: b().folderSkipped };
    return null;
  };
  const icon = (folder: PlannedFolder) => {
    const state = stateOf(folder.path)?.state;
    if (folder.issue || state === "failed") return "ti ti-folder-x";
    if (state === "existing") return "ti ti-folder";
    if (state === "created") return "ti ti-folder-check";
    if (state === "skipped") return "ti ti-folder-off";
    return "ti ti-folder-plus";
  };
  const typed = () => input().split("/");
  const location = () => [props.location, ...(props.parent ? props.parent.split("/") : []), ...(input() ? typed() : [])].join(" / ");

  return (
    <form
      class="filesv2-new-folder"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {/* One line that never wraps: the middle of a long path gives way first, then the two ends. */}
      <p class="filesv2-new-folder__crumb" title={location()}>
        <i class="ti ti-folder" aria-hidden="true" />
        <span class="filesv2-new-folder__base">{props.location}</span>
        <Show when={props.parent}>
          <span class="filesv2-new-folder__separator">/</span>
          <span class="filesv2-new-folder__parent">
            <bdi>{props.parent.split("/").join(" / ")}</bdi>
          </span>
        </Show>
        <Show when={input()}>
          <span class="filesv2-new-folder__separator">/</span>
          <span class="filesv2-new-folder__typed">
            <bdi>
              <For each={typed()}>
                {(segment, index) => (
                  <>
                    <Show when={index()}>
                      <span class="filesv2-new-folder__separator"> / </span>
                    </Show>
                    {segment}
                  </>
                )}
              </For>
            </bdi>
          </span>
        </Show>
      </p>
      <TextInput
        label={b().newFolderName}
        value={input}
        onValueChange={setInput}
        maxLength={4096}
        readOnly={saving()}
        autocomplete="off"
        spellcheck={false}
        autofocus
      />
      <section class="filesv2-new-folder__preview" aria-label={b().folderPreview}>
        <p class="filesv2-new-folder__summary" role="status" data-tone={summary().tone}>
          {summary().text}
        </p>
        <ul class="filesv2-new-folder__tree">
          <For each={rows()}>
            {(folder) => (
              <li class="filesv2-new-folder__row" style={{ "--filesv2-new-folder-depth": Math.min(folder.depth, 6) }}>
                <i class={icon(folder)} data-tone={note(folder)?.tone ?? "new"} aria-hidden="true" />
                <span class="filesv2-new-folder__name" data-empty={folder.name ? undefined : "true"} title={folder.name}>
                  {folder.name || b().folderEmptyName}
                </span>
                <Show when={note(folder)}>
                  {(current) => (
                    <span class="filesv2-new-folder__note" data-tone={current().tone} title={current().text}>
                      {current().text}
                    </span>
                  )}
                </Show>
              </li>
            )}
          </For>
        </ul>
        {/* One reserved line below the tree: how the syntax works, or what a typed comma means. */}
        <div class="filesv2-new-folder__mode">
          <Show when={plan().comma} fallback={<span>{b().newFolderHint}</span>}>
            <span aria-hidden="true">{b().folderComma}</span>
            <SegmentedControl
              size="sm"
              ariaLabel={b().folderComma}
              value={commas}
              onValueChange={setCommas}
              disabled={saving()}
              options={[
                { value: "split", label: b().folderCommaSplit },
                { value: "literal", label: b().folderCommaLiteral },
              ]}
            />
          </Show>
        </div>
      </section>
      <div class="filesv2-new-folder__actions">
        <Button type="button" variant="secondary" onClick={() => props.close()}>
          {b().cancel}
        </Button>
        <Button type="submit" loading={saving()} disabled={!canSubmit()}>
          {/* The longest label reserves the width, so the count never moves the buttons. */}
          <span class="filesv2-new-folder__label" data-reserve={b().createFolders(BATCH_LIMIT)}>
            <span>{b().createFolders(toCreate())}</span>
          </span>
        </Button>
      </div>
    </form>
  );
}
