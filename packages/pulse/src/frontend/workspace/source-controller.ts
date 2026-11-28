import type { ResourceApiKey, ResourceApiKeysProps } from "@k2b/cloud/access/ui";
import { mutation } from "@k2b/stdlib/solid";
import { type Accessor, onCleanup, type Setter } from "solid-js";
import type { PulseSource } from "../../contracts";
import { jsonFetch } from "../http";
import { usePulseMessages } from "../use-messages";
import {
  createPulseSource,
  SourceCreateError,
  SourceEditError,
  scrapePulseSourceOnce,
  sourceCreateValidationError,
} from "./source-actions";
import type { CreateSourceInput, WorkspaceView } from "./types";

type SourceControllerDeps = {
  selectedBaseId: Accessor<string>;
  /** Reports a finished or failed deed in one sentence (the screen's toast). */
  notify: (text: string, status: "ok" | "bad") => void;
  /** Asks before something that cannot be taken back; resolves true when the person agrees. */
  confirm: (question: { title: string; description: string; confirm: string }) => Promise<boolean>;
  loading: Accessor<boolean>;
  setLoading: Setter<boolean>;
  selectedSourceId: Accessor<string>;
  navigate: (state: { view: WorkspaceView; sourceId?: string }) => void;
  refreshBaseData: () => Promise<void>;
  refreshSourceDetail: () => Promise<void>;
  writeBlocked: Accessor<boolean>;
};

export const createSourceController = (deps: SourceControllerDeps) => {
  const t = usePulseMessages();
  let disposed = false;
  const createMutation = mutation.create<PulseSource, { baseId: string; input: CreateSourceInput }>({
    mutation: ({ baseId, input }, { abortSignal }) => createPulseSource(baseId, input, abortSignal),
  });
  const scrapeMutation = mutation.create<Awaited<ReturnType<typeof scrapePulseSourceOnce>>, { baseId: string; sourceId: string }>({
    mutation: ({ baseId, sourceId }, { abortSignal }) => scrapePulseSourceOnce(baseId, sourceId, abortSignal),
  });
  const toggleMutation = mutation.create<PulseSource, { baseId: string; sourceId: string; enabled: boolean }>({
    mutation: ({ baseId, sourceId, enabled }, { abortSignal }) =>
      jsonFetch<PulseSource>(`/api/pulse/bases/${baseId}/sources/${sourceId}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled }),
        signal: abortSignal,
      }),
  });
  const editMutation = mutation.create<PulseSource, { baseId: string; sourceId: string; patch: Record<string, unknown> }>({
    mutation: ({ baseId, sourceId, patch }, { abortSignal }) =>
      jsonFetch<PulseSource>(
        `/api/pulse/bases/${baseId}/sources/${sourceId}`,
        {
          method: "PATCH",
          body: JSON.stringify(patch),
          signal: abortSignal,
        },
        "REQUEST_FAILED",
        (status, body) =>
          new SourceEditError(
            status === 409 ? "conflict" : status >= 500 ? "uncertain" : "rejected",
            body && typeof body === "object" && "message" in body && typeof body.message === "string" ? body.message : "REQUEST_FAILED",
          ),
      ),
  });
  const removeMutation = mutation.create<void, { baseId: string; sourceId: string }>({
    mutation: ({ baseId, sourceId }, { abortSignal }) =>
      jsonFetch<void>(`/api/pulse/bases/${baseId}/sources/${sourceId}`, { method: "DELETE", signal: abortSignal }),
  });
  type ApiKeyInput = Parameters<ResourceApiKeysProps["createKey"]>[0];
  const createApiKeyMutation = mutation.create<
    { credential: ResourceApiKey; token: string },
    { baseId: string; sourceId: string; input: ApiKeyInput }
  >({
    mutation: ({ baseId, sourceId, input }, { abortSignal }) =>
      jsonFetch<{ credential: ResourceApiKey; token: string }>(`/api/pulse/bases/${baseId}/sources/${sourceId}/api-keys`, {
        method: "POST",
        body: JSON.stringify(input),
        signal: abortSignal,
      }),
  });
  const revokeApiKeyMutation = mutation.create<void, { baseId: string; sourceId: string; credentialId: string }>({
    mutation: ({ baseId, sourceId, credentialId }, { abortSignal }) =>
      jsonFetch<void>(`/api/pulse/bases/${baseId}/sources/${sourceId}/api-keys/${credentialId}`, {
        method: "DELETE",
        signal: abortSignal,
      }),
  });
  onCleanup(() => {
    disposed = true;
    createMutation.abort();
    scrapeMutation.abort();
    toggleMutation.abort();
    editMutation.abort();
    removeMutation.abort();
    createApiKeyMutation.abort();
    revokeApiKeyMutation.abort();
  });
  const reconcile = async (tasks: Array<() => Promise<void>>, message: string): Promise<boolean> => {
    try {
      await Promise.all(tasks.map((task) => task()));
      return !disposed;
    } catch {
      if (!disposed) deps.notify(message, "bad");
      return false;
    }
  };
  const requireWritable = (): boolean => {
    if (!deps.writeBlocked()) return true;
    deps.notify(t().refreshBeforeChanges, "bad");
    return false;
  };

  const scrapeCreatedMetricsSource = async (baseId: string, sourceId: string): Promise<boolean> => {
    try {
      const outcome = await scrapeMutation.mutate({ baseId, sourceId });
      if (disposed) return false;
      if (outcome === "error") throw scrapeMutation.error();
      if (outcome !== "success") return false;
      const counts = scrapeMutation.data()!;
      if (!(await reconcile([deps.refreshBaseData], t().sourceCreatedScrapedRefreshFailed))) return false;
      deps.notify(t().sourceAddedScraped({ counts: t().ingestCounts(counts) }), "ok");
      return true;
    } catch (error) {
      if (disposed) return false;
      if (!(await reconcile([deps.refreshBaseData], t().sourceCreatedRefreshFailed))) return false;
      deps.notify(t().sourceAddedScrapeFailed({ detail: error instanceof Error ? error.message : undefined }), "bad");
      return true;
    }
  };

  const createSource = async (input: CreateSourceInput) => {
    if (disposed || !requireWritable()) return false;
    const baseId = deps.selectedBaseId();
    if (!baseId) return false;
    const validationError = sourceCreateValidationError(input) ? t().endpointRequired : null;
    if (validationError) {
      deps.notify(validationError, "bad");
      return false;
    }
    deps.setLoading(true);
    try {
      const outcome = await createMutation.mutate({ baseId, input: { ...input } });
      if (disposed) return false;
      if (outcome === "error") throw createMutation.error();
      if (outcome !== "success") return false;
      const source = createMutation.data()!;
      if (input.kind === "metrics") {
        if (!(await scrapeCreatedMetricsSource(baseId, source.id))) return true;
        deps.navigate({ view: "sources", sourceId: source.id });
        return true;
      }
      if (!(await reconcile([deps.refreshBaseData], t().sourceCreatedRefreshFailed))) return true;
      deps.navigate({ view: "sources", sourceId: source.id });
      deps.notify(input.kind === "http_ingest" ? t().httpIngestSourceCreated : t().metricsSourceCreated, "ok");
      return true;
    } catch (error) {
      if (disposed) return false;
      if (!(error instanceof SourceCreateError) || error.kind === "uncertain") {
        await reconcile([deps.refreshBaseData], t().sourceCreateUncertain);
        throw new SourceCreateError("uncertain", t().sourceCreateUncertain);
      }
      deps.notify(error instanceof Error ? error.message : t().sourceAddFailed, "bad");
      return false;
    } finally {
      deps.setLoading(false);
    }
  };

  const scrape = async (source: PulseSource) => {
    if (!requireWritable()) return;
    const baseId = deps.selectedBaseId();
    if (!baseId) return;
    deps.setLoading(true);
    try {
      const outcome = await scrapeMutation.mutate({ baseId, sourceId: source.id });
      if (disposed) return;
      if (outcome === "error") throw scrapeMutation.error();
      if (outcome !== "success") return;
      const counts = scrapeMutation.data()!;
      if (!(await reconcile([deps.refreshBaseData, deps.refreshSourceDetail], t().sourceChangedRefreshFailed))) return;
      deps.notify(t().metricsScraped({ counts: t().ingestCounts(counts) }), "ok");
    } catch (error) {
      deps.notify(error instanceof Error ? error.message : t().scrapeFailed, "bad");
    } finally {
      deps.setLoading(false);
    }
  };

  const toggleSource = async (source: PulseSource) => {
    if (!requireWritable()) return;
    const baseId = deps.selectedBaseId();
    if (!baseId) return;
    deps.setLoading(true);
    try {
      const outcome = await toggleMutation.mutate({ baseId, sourceId: source.id, enabled: !source.enabled });
      if (disposed) return;
      if (outcome === "error") throw toggleMutation.error();
      if (outcome !== "success") return;
      const updated = toggleMutation.data()!;
      if (!(await reconcile([deps.refreshBaseData], t().sourceChangedRefreshFailed))) return;
      deps.notify(updated.enabled ? t().sourceResumed : t().sourcePaused, "ok");
    } catch (error) {
      deps.notify(error instanceof Error ? error.message : t().sourceUpdateFailed, "bad");
    } finally {
      deps.setLoading(false);
    }
  };

  /** Saves the edit dialog's patch; a conflict, a lost answer or a refusal comes back as `SourceEditError`. */
  const saveSource = async (source: PulseSource, patch: Record<string, unknown>) => {
    const baseId = deps.selectedBaseId();
    if (disposed || !baseId || !requireWritable()) throw new SourceEditError("uncertain", t().refreshBeforeChanges);
    deps.setLoading(true);
    try {
      const outcome = await editMutation.mutate({ baseId, sourceId: source.id, patch });
      if (disposed) throw new SourceEditError("uncertain", t().sourceEditUncertain);
      if (outcome === "error") throw editMutation.error();
      if (outcome !== "success") throw new SourceEditError("uncertain", t().sourceEditUncertain);
      if (!(await reconcile([deps.refreshBaseData], t().sourceUpdatedRefreshFailed)))
        throw new SourceEditError("uncertain", t().sourceEditUncertain);
      deps.notify(t().sourceUpdated, "ok");
    } catch (error) {
      // Reconcile a rejected/lost response before another dialog can write.
      await reconcile([deps.refreshBaseData], t().sourceUpdatedRefreshFailed);
      throw error;
    } finally {
      deps.setLoading(false);
    }
  };

  const removeSource = async (source: PulseSource) => {
    if (!requireWritable()) return;
    const baseId = deps.selectedBaseId();
    if (!baseId) return;
    const confirmed = await deps.confirm({
      title: t().removeSource,
      description: t().removeSourceConfirm({ name: source.name }),
      confirm: t().removeSource,
    });
    if (disposed || !confirmed || !requireWritable()) return;
    deps.setLoading(true);
    try {
      const outcome = await removeMutation.mutate({ baseId, sourceId: source.id });
      if (disposed) return;
      if (outcome === "error") throw removeMutation.error();
      if (outcome !== "success") return;
      if (!(await reconcile([deps.refreshBaseData], t().sourceRemovedRefreshFailed))) return;
      if (deps.selectedSourceId() === source.id) deps.navigate({ view: "sources" });
      deps.notify(t().sourceRemoved, "ok");
    } catch (error) {
      deps.notify(error instanceof Error ? error.message : t().sourceRemoveFailed, "bad");
    } finally {
      deps.setLoading(false);
    }
  };

  const createApiKey = async (source: PulseSource, input: Parameters<ResourceApiKeysProps["createKey"]>[0]) => {
    if (deps.writeBlocked()) throw new Error(t().refreshBeforeChanges);
    const baseId = deps.selectedBaseId();
    if (!baseId) throw new Error(t().noBaseSelected);
    const outcome = await createApiKeyMutation.mutate({ baseId, sourceId: source.id, input: { ...input } });
    if (disposed) throw new DOMException("Source owner was disposed", "AbortError");
    if (outcome === "error") throw createApiKeyMutation.error();
    if (outcome !== "success") throw new DOMException("API key creation did not run", "AbortError");
    const created = createApiKeyMutation.data()!;
    await reconcile([deps.refreshSourceDetail], t().apiKeyCreatedRefreshFailed);
    if (disposed) throw new DOMException("Source owner was disposed", "AbortError");
    return created;
  };

  const revokeApiKey = async (source: PulseSource, credentialId: string) => {
    if (deps.writeBlocked()) throw new Error(t().refreshBeforeChanges);
    const baseId = deps.selectedBaseId();
    if (!baseId) throw new Error(t().noBaseSelected);
    const outcome = await revokeApiKeyMutation.mutate({ baseId, sourceId: source.id, credentialId });
    if (disposed) throw new DOMException("Source owner was disposed", "AbortError");
    if (outcome === "error") throw revokeApiKeyMutation.error();
    if (outcome !== "success") throw new DOMException("API key revoke did not run", "AbortError");
    await reconcile([deps.refreshSourceDetail], t().apiKeyRevokedRefreshFailed);
    if (disposed) throw new DOMException("Source owner was disposed", "AbortError");
  };

  return { createApiKey, createSource, removeSource, revokeApiKey, saveSource, scrape, toggleSource, requireWritable };
};
