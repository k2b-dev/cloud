import { Button, ButtonLink, ProgressBar, Select, useLocale } from "@k2b/ui";
import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import { z } from "zod";
import { invokeCapabilityWithDataSchema } from "../../capabilities/client";
import { cloudResourceHref } from "../../contracts/resource-href";
import type { AiMap } from "../map-contracts";
import { type MapNotebookSaveCheckpoint, MapNotebookSaveCheckpointSchema, saveMapNotebook } from "../map-notebook-save";
import { mapMessages, mapSaveMessage } from "./map-messages";

const notebooks = z.array(z.object({ id: z.string(), name: z.string() }));
const legacySchema = z.object({
  status: z.enum(["pending", "unknown", "saved"]),
  notebookId: z.string().regex(/^[A-Za-z0-9]{6}$/),
  href: z.string().optional(),
});
const snapshotSchema = z.object({ content: z.string(), revision: z.number().int(), ownerUserId: z.string().min(1) });
const storedSchema = z
  .object({
    checkpoint: MapNotebookSaveCheckpointSchema,
    writeId: z.uuid().optional(),
    status: z.enum(["paused", "saved", "cancelled", "conflict", "unknown", "error"]),
    code: z.string().optional(),
    message: z.string().optional(),
  })
  .strict()
  .refine(
    (stored) =>
      stored.status !== "saved" ||
      Boolean(stored.checkpoint.noteId && !stored.checkpoint.pending && stored.checkpoint.completed === stored.checkpoint.total),
  );

export function MapNotebookSave(props: { map: AiMap; onCancel: () => void }) {
  const source = { id: props.map.id, conversationId: props.map.conversationId, revision: props.map.revision };
  const sourceChanged = () =>
    props.map.id !== source.id || props.map.conversationId !== source.conversationId || props.map.revision !== source.revision;
  const locale = useLocale();
  const t = () => mapMessages(locale());
  const [selected, setSelected] = createSignal<string | null>(null);
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [ready, setReady] = createSignal(false);
  const [checkpoint, setCheckpoint] = createSignal<MapNotebookSaveCheckpoint>();
  const [legacy, setLegacy] = createSignal(false);
  const [status, setStatus] = createSignal<z.infer<typeof storedSchema>["status"]>();
  let controller: AbortController | undefined;
  let storageKey = "";
  let sourceKey = "";
  let unpersisted: z.infer<typeof storedSchema> | undefined;
  let observedRaw: string | null = null;
  let unpersistedBases: (string | null)[] = [];
  const noteHref = () => (checkpoint()?.noteId ? cloudResourceHref({ type: "notebooks.note", id: checkpoint()!.noteId! }) : undefined);
  const notebookHref = () => (selected() ? cloudResourceHref({ type: "notebooks.notebook", id: selected()! }) : undefined);
  const unknownCreate = () => checkpoint()?.pending?.kind === "create";
  const saved = () => status() === "saved" && !sourceChanged();
  const failureMessage = (cause: unknown) =>
    cause instanceof Error && !(cause instanceof z.ZodError) && !(cause instanceof SyntaxError) && !(cause instanceof TypeError)
      ? cause.message
      : t().saveFailed;
  const snapshot = async (signal: AbortSignal) => {
    const response = await fetch(`/api/ai/conversations/${encodeURIComponent(source.conversationId)}/maps/${source.id}/export`, {
      signal,
    });
    if (!response.ok) throw new Error(t().saveFailed);
    const value = snapshotSchema.parse(await response.json());
    if (value.revision !== source.revision) throw new Error(t().conflict);
    return value;
  };
  const restore = () => {
    // A failed write may have reached storage. Only replace our own observed values;
    // a different receipt belongs to a later lock holder and always takes precedence.
    // Each write has its own identity, even when two tabs begin with identical helper checkpoints.
    const raw = localStorage.getItem(storageKey);
    observedRaw = raw;
    const pending = unpersisted && unpersistedBases.includes(raw) ? unpersisted : undefined;
    if (!pending) {
      unpersisted = undefined;
      unpersistedBases = [];
    }
    if (raw === null && !pending) {
      // The old flow used an unscoped session receipt and different create keys.
      // Do not silently abandon it or attribute it to a new owner: recover in Notebook.
      const previous = sessionStorage.getItem(`cloud.ai.map-save:${source.id}:${source.revision}`);
      if (previous !== null) {
        const value = legacySchema.parse(JSON.parse(previous));
        setSelected(value.notebookId);
        setLegacy(true);
        setError(t().previousSave);
      }
      return;
    }
    const stored = pending ?? storedSchema.parse(JSON.parse(raw!));
    if (stored.checkpoint.sourceKey !== sourceKey) throw new Error(t().saveStorage);
    setCheckpoint(stored.checkpoint);
    setSelected(stored.checkpoint.notebookId);
    setStatus(stored.status);
    if (stored.status !== "saved")
      setError(stored.checkpoint.pending?.kind === "create" ? t().unknownSave : mapSaveMessage(locale(), stored.code, stored.message));
  };
  const persist = (next: MapNotebookSaveCheckpoint, state: z.infer<typeof storedSchema>["status"], code?: string, message?: string) => {
    setCheckpoint(next);
    setSelected(next.notebookId);
    if (!unpersisted) unpersistedBases = [observedRaw];
    unpersisted = { checkpoint: next, writeId: crypto.randomUUID(), status: state, code, message };
    const serialized = JSON.stringify(unpersisted);
    const before = localStorage.getItem(storageKey);
    unpersistedBases = [before, serialized];
    localStorage.setItem(storageKey, serialized);
    observedRaw = serialized;
    unpersisted = undefined;
    unpersistedBases = [];
  };
  const initialize = async () => {
    if (busy()) return;
    setBusy(true);
    setError("");
    controller = new AbortController();
    try {
      const value = await snapshot(controller.signal);
      // Identity comes from the authorized export, never from a browser account hint.
      const nextSourceKey = JSON.stringify([value.ownerUserId, source.conversationId, source.id, source.revision]);
      if (sourceKey && nextSourceKey !== sourceKey) throw new Error(t().saveOwnerChanged);
      sourceKey = nextSourceKey;
      storageKey = `cloud.ai.map-save:v1:${sourceKey}`;
      try {
        restore();
      } catch {
        throw new Error(t().saveStorage);
      }
      if (!navigator.locks) throw new Error(t().saveLockUnavailable);
      setReady(true);
    } catch (cause) {
      setError(controller.signal.aborted ? t().saveCancelled : failureMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  createEffect(() => {
    if (sourceChanged()) controller?.abort();
  });
  onMount(() => void initialize());
  onCleanup(() => controller?.abort());
  const save = async () => {
    if (sourceChanged() || !ready() || !selected() || busy() || legacy() || saved() || unknownCreate() || status() === "conflict") return;
    setBusy(true);
    setError("");
    controller = new AbortController();
    const signal = controller.signal;
    try {
      await navigator.locks.request(storageKey, { ifAvailable: true }, async (lock) => {
        if (!lock) {
          setError(t().saveLocked);
          return;
        }
        // Another tab may have advanced or completed this save since the panel opened.
        try {
          restore();
          if (unpersisted) persist(unpersisted.checkpoint, unpersisted.status, unpersisted.code, unpersisted.message);
        } catch {
          setReady(false);
          throw new Error(t().saveStorage);
        }
        if (legacy() || saved() || unknownCreate() || status() === "conflict") return;
        setError("");
        const value = await snapshot(signal);
        if (JSON.stringify([value.ownerUserId, source.conversationId, source.id, value.revision]) !== sourceKey)
          throw new Error(t().saveOwnerChanged);
        let persistenceFailed = false;
        const result = await saveMapNotebook({
          content: value.content,
          notebookId: selected()!,
          sourceKey,
          checkpoint: checkpoint(),
          signal,
          onCheckpoint: (next) => {
            try {
              persist(next, "paused");
            } catch {
              persistenceFailed = true;
              throw new Error(t().saveStorage);
            }
          },
        });
        setCheckpoint(result.checkpoint);
        setStatus(result.status);
        setError(
          persistenceFailed
            ? t().saveStorage
            : result.status === "saved"
              ? ""
              : result.checkpoint?.pending?.kind === "create"
                ? t().unknownSave
                : result.status === "cancelled"
                  ? t().saveCancelled
                  : mapSaveMessage(locale(), result.code, result.message),
        );
        if (result.checkpoint) {
          try {
            persist(
              result.checkpoint,
              result.status,
              persistenceFailed ? "persistence_failed" : result.status === "cancelled" ? "cancelled" : result.code,
              persistenceFailed ? undefined : result.message,
            );
          } catch {
            setStatus("error");
            setError(t().saveStorage);
          }
        }
      });
    } catch (cause) {
      setError(signal.aborted ? t().saveCancelled : failureMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  const action = () =>
    unknownCreate() ? t().save : checkpoint() ? (checkpoint()?.pending ? t().reconcileSave : t().resumeSave) : t().save;
  return (
    <div class="ai-map__save">
      <Show
        when={!saved()}
        fallback={
          <div role="status">
            <ButtonLink href={noteHref()!} variant="ghost">
              {t().saved}
            </ButtonLink>
          </div>
        }
      >
        <Select
          label={t().notebook}
          value={selected()}
          onValueChange={setSelected}
          disabled={sourceChanged() || !ready() || busy() || legacy() || Boolean(checkpoint())}
          loadOptions={async (query, signal) => {
            const result = await invokeCapabilityWithDataSchema(
              {
                kind: "query",
                appId: "notebooks",
                capabilityId: "notebook.list",
                input: { query, minimumPermission: "write", limit: 100 },
                signal,
              },
              notebooks,
            );
            if (!result.ok) throw new Error(result.error.message);
            return result.data.data.map((n) => ({ value: n.id, label: n.name }));
          }}
        />
        <Show when={checkpoint()}>
          <div role="status" aria-live="polite">
            <ProgressBar
              label={t().saveProgress}
              value={checkpoint()!.total ? (checkpoint()!.completed / checkpoint()!.total) * 100 : 0}
              showValue
            />
          </div>
        </Show>
        <div class="ai-map__actions">
          <Show
            when={ready()}
            fallback={
              <Button size="sm" disabled={busy() || sourceChanged()} onClick={() => void initialize()}>
                {busy() ? t().saveLoading : t().retry}
              </Button>
            }
          >
            <Button
              size="sm"
              disabled={sourceChanged() || !selected() || busy() || legacy() || unknownCreate() || status() === "conflict"}
              onClick={() => void save()}
            >
              {busy() ? t().pending : action()}
            </Button>
          </Show>
          <Button size="sm" variant="ghost" onClick={() => (busy() ? controller?.abort() : props.onCancel())}>
            {t().cancel}
          </Button>
        </div>
      </Show>
      <Show when={sourceChanged() || error()}>
        <p role="alert">{sourceChanged() ? t().saveSourceChanged : error()}</p>
      </Show>
      <Show when={noteHref() && !saved()}>
        <ButtonLink size="sm" variant="ghost" href={noteHref()!}>
          {t().partialNote}
        </ButtonLink>
      </Show>
      <Show when={notebookHref() && (checkpoint() || legacy()) && !saved()}>
        <ButtonLink size="sm" variant="ghost" href={notebookHref()!}>
          {t().inspectNotebook}
        </ButtonLink>
      </Show>
    </div>
  );
}
