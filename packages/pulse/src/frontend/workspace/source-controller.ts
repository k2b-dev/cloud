import { mutation } from "@k2b/stdlib/solid";
import { prompts, toast } from "@k2b/ui";
import type { ResourceApiKey, ResourceApiKeysProps } from "@valentinkolb/cloud/access/ui";
import { type Accessor, onCleanup, type Setter } from "solid-js";
import type { PulseSource } from "../../contracts";
import { jsonFetch } from "../http";
import {
  createPulseSource,
  scrapePulseSourceOnce,
  sourceCreateValidationError,
} from "./source-actions";
import { openSourceCreateDialog } from "./source-create-dialog";
import { openSourceEditDialog } from "./source-edit-dialog";
import type { CreateSourceInput, WorkspaceView } from "./types";
import { usePulseMessages } from "../use-messages";

type SourceControllerDeps = {
  selectedBaseId: Accessor<string>;
  loading: Accessor<boolean>;
  setLoading: Setter<boolean>;
  setSelectedSourceId: Setter<string>;
  navigate: (state: { view: WorkspaceView; sourceId?: string }) => void;
  refreshBaseData: () => Promise<void>;
  refreshSourceDetail: () => Promise<void>;
  refreshDashboard: () => Promise<void>;
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
      jsonFetch<PulseSource>(`/api/pulse/bases/${baseId}/sources/${sourceId}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
        signal: abortSignal,
      }),
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
      if (!disposed) toast.error(message);
      return false;
    }
  };
  const requireWritable = (): boolean => {
    if (!deps.writeBlocked()) return true;
    toast.error(t().refreshBeforeChanges);
    return false;
  };

  const scrapeCreatedMetricsSource = async (baseId: string, sourceId: string): Promise<boolean> => {
    try {
      await scrapeMutation.mutate({ baseId, sourceId });
      if (disposed) return false;
      if (scrapeMutation.error()) throw scrapeMutation.error();
      const counts = scrapeMutation.data()!;
      if (!(await reconcile([deps.refreshBaseData], t().sourceCreatedScrapedRefreshFailed)))
        return false;
      toast.success(t().sourceAddedScraped({ counts: t().ingestCounts(counts) }));
      return true;
    } catch (error) {
      if (disposed) return false;
      if (!(await reconcile([deps.refreshBaseData], t().sourceCreatedRefreshFailed))) return false;
      toast.error(t().sourceAddedScrapeFailed({ detail: error instanceof Error ? error.message : undefined }));
      return true;
    }
  };

  const createSource = async (input: CreateSourceInput) => {
    if (disposed || !requireWritable()) return false;
    const baseId = deps.selectedBaseId();
    if (!baseId) return false;
    const validationError = sourceCreateValidationError(input) ? t().endpointRequired : null;
    if (validationError) {
      toast.error(validationError);
      return false;
    }
    deps.setLoading(true);
    try {
      await createMutation.mutate({ baseId, input: { ...input } });
      if (disposed) return false;
      if (createMutation.error()) throw createMutation.error();
      const source = createMutation.data()!;
      if (input.kind === "metrics") {
        if (!(await scrapeCreatedMetricsSource(baseId, source.id))) return true;
        deps.navigate({ view: "sources", sourceId: source.id });
        return true;
      }
      if (!(await reconcile([deps.refreshBaseData], t().sourceCreatedRefreshFailed))) return true;
      deps.navigate({ view: "sources", sourceId: source.id });
      toast.success(input.kind === "http_ingest" ? t().httpIngestSourceCreated : t().metricsSourceCreated);
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t().sourceAddFailed);
      return false;
    } finally {
      deps.setLoading(false);
    }
  };

  const addSource = () => {
    if (!requireWritable()) return;
    return openSourceCreateDialog({ loading: deps.loading, createSource });
  };

  const scrape = async (source: PulseSource) => {
    if (!requireWritable()) return;
    const baseId = deps.selectedBaseId();
    if (!baseId) return;
    deps.setLoading(true);
    try {
      await scrapeMutation.mutate({ baseId, sourceId: source.id });
      if (disposed) return;
      if (scrapeMutation.error()) throw scrapeMutation.error();
      const counts = scrapeMutation.data()!;
      if (
        !(await reconcile(
          [deps.refreshBaseData, deps.refreshSourceDetail, deps.refreshDashboard],
          t().sourceChangedRefreshFailed,
        ))
      )
        return;
      toast.success(t().metricsScraped({ counts: t().ingestCounts(counts) }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t().scrapeFailed);
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
      await toggleMutation.mutate({ baseId, sourceId: source.id, enabled: !source.enabled });
      if (disposed) return;
      if (toggleMutation.error()) throw toggleMutation.error();
      const updated = toggleMutation.data()!;
      if (!(await reconcile([deps.refreshBaseData, deps.refreshDashboard], t().sourceChangedRefreshFailed)))
        return;
      toast.success(updated.enabled ? t().sourceResumed : t().sourcePaused);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t().sourceUpdateFailed);
    } finally {
      deps.setLoading(false);
    }
  };

  const editSource = async (source: PulseSource) => {
    if (!requireWritable()) return;
    const baseId = deps.selectedBaseId();
    if (!baseId) return;
    const patch = await openSourceEditDialog(source);
    if (disposed || !patch || !requireWritable()) return;
    deps.setLoading(true);
    try {
      await editMutation.mutate({ baseId, sourceId: source.id, patch: { ...patch } });
      if (disposed) return;
      if (editMutation.error()) throw editMutation.error();
      if (!(await reconcile([deps.refreshBaseData], t().sourceUpdatedRefreshFailed))) return;
      toast.success(t().sourceUpdated);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t().sourceUpdateFailed);
    } finally {
      deps.setLoading(false);
    }
  };

  const removeSource = async (source: PulseSource) => {
    if (!requireWritable()) return;
    const baseId = deps.selectedBaseId();
    if (!baseId) return;
    const confirmed = await prompts.confirm(t().removeSourceConfirm({ name: source.name }), {
      title: t().removeSource,
      variant: "danger",
    });
    if (disposed || !confirmed || !requireWritable()) return;
    deps.setLoading(true);
    try {
      await removeMutation.mutate({ baseId, sourceId: source.id });
      if (disposed) return;
      if (removeMutation.error()) throw removeMutation.error();
      if (
        !(await reconcile([deps.refreshBaseData, deps.refreshDashboard], t().sourceRemovedRefreshFailed))
      )
        return;
      deps.setSelectedSourceId((current) => (current === source.id ? "" : current));
      toast.success(t().sourceRemoved);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t().sourceRemoveFailed);
    } finally {
      deps.setLoading(false);
    }
  };

  const createApiKey = async (source: PulseSource, input: Parameters<ResourceApiKeysProps["createKey"]>[0]) => {
    if (deps.writeBlocked()) throw new Error(t().refreshBeforeChanges);
    const baseId = deps.selectedBaseId();
    if (!baseId) throw new Error(t().noBaseSelected);
    await createApiKeyMutation.mutate({ baseId, sourceId: source.id, input: { ...input } });
    if (disposed) throw new DOMException("Source owner was disposed", "AbortError");
    if (createApiKeyMutation.error()) throw createApiKeyMutation.error();
    const created = createApiKeyMutation.data()!;
    await reconcile([deps.refreshSourceDetail], t().apiKeyCreatedRefreshFailed);
    if (disposed) throw new DOMException("Source owner was disposed", "AbortError");
    return created;
  };

  const revokeApiKey = async (source: PulseSource, credentialId: string) => {
    if (deps.writeBlocked()) throw new Error(t().refreshBeforeChanges);
    const baseId = deps.selectedBaseId();
    if (!baseId) throw new Error(t().noBaseSelected);
    await revokeApiKeyMutation.mutate({ baseId, sourceId: source.id, credentialId });
    if (disposed) throw new DOMException("Source owner was disposed", "AbortError");
    if (revokeApiKeyMutation.error()) throw revokeApiKeyMutation.error();
    await reconcile([deps.refreshSourceDetail], t().apiKeyRevokedRefreshFailed);
    if (disposed) throw new DOMException("Source owner was disposed", "AbortError");
  };

  return { addSource, createApiKey, editSource, removeSource, revokeApiKey, scrape, toggleSource };
};
