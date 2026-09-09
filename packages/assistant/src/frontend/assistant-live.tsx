import type { AiInvalidation, AiInvalidationDomain } from "@k2b/cloud/ai/live-events";
import { createContext, type JSX, useContext } from "solid-js";

export type AssistantLiveInvalidation = {
  cursor: string | null;
  domains: ReadonlySet<AiInvalidationDomain>;
  conversationIds: ReadonlySet<string> | null;
  projectIds: ReadonlySet<string> | null;
};

type Invalidator = {
  matches: (invalidation: AssistantLiveInvalidation) => boolean;
  invalidate: (invalidation: AssistantLiveInvalidation) => Promise<void>;
};

type PendingInvalidation = AssistantLiveInvalidation & { sequence: number };

export const createAssistantLiveInvalidationHub = (options: {
  delayMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  onApplied: (cursor: string | null) => void;
  onFailed?: (attempt: number) => void;
}) => {
  const invalidators = new Set<Invalidator>();
  let pending: PendingInvalidation | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let disposed = false;
  let sequence = 0;
  let failedAttempts = 0;

  const mergeIds = (left: ReadonlySet<string> | null, right: ReadonlySet<string> | null): ReadonlySet<string> | null =>
    left === null || right === null ? null : new Set([...left, ...right]);

  const merge = (left: PendingInvalidation | null, right: PendingInvalidation): PendingInvalidation => ({
    sequence: Math.max(left?.sequence ?? 0, right.sequence),
    cursor: right.sequence >= (left?.sequence ?? 0) ? right.cursor : (left?.cursor ?? null),
    domains: new Set([...(left?.domains ?? []), ...right.domains]),
    conversationIds: mergeIds(left?.conversationIds ?? new Set(), right.conversationIds),
    projectIds: mergeIds(left?.projectIds ?? new Set(), right.projectIds),
  });

  const arm = (delay = options.delayMs ?? 30) => {
    if (disposed || running || timer || !pending) return;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, delay);
  };

  const flush = async () => {
    if (disposed || running || !pending) return;
    running = true;
    const current = pending;
    pending = null;
    try {
      await Promise.all([...invalidators].filter((item) => item.matches(current)).map((item) => item.invalidate(current)));
      if (disposed) return;
      failedAttempts = 0;
      options.onApplied(current.cursor);
    } catch {
      if (disposed) return;
      pending = merge(pending, current);
      failedAttempts += 1;
      options.onFailed?.(failedAttempts);
      running = false;
      const base = options.retryBaseMs ?? 1_000;
      const maximum = options.retryMaxMs ?? 15_000;
      const exponential = Math.min(maximum, base * 2 ** Math.min(failedAttempts - 1, 5));
      arm(Math.max(1, Math.round(exponential * (0.8 + Math.random() * 0.4))));
      return;
    }
    running = false;
    arm();
  };

  const schedule = (
    invalidation: Omit<AssistantLiveInvalidation, "conversationIds" | "projectIds"> & {
      conversationId?: string | null;
      projectId?: string | null;
    },
  ) => {
    pending = merge(pending, {
      ...invalidation,
      conversationIds: invalidation.conversationId ? new Set([invalidation.conversationId]) : null,
      projectIds: invalidation.projectId ? new Set([invalidation.projectId]) : null,
      sequence: ++sequence,
    });
    arm();
  };

  return {
    register: (invalidator: Invalidator) => {
      if (disposed) return () => undefined;
      invalidators.add(invalidator);
      return () => invalidators.delete(invalidator);
    },
    scheduleEvent: (cursor: string, event: AiInvalidation) =>
      schedule({
        cursor,
        domains: new Set(event.domains),
        conversationId: event.conversationId,
        projectId: event.projectId,
      }),
    scheduleScopeRefresh: (cursor: string | null = null) =>
      schedule({
        cursor,
        domains: new Set<AiInvalidationDomain>([
          "conversation-list",
          "conversation-detail",
          "conversation-sources",
          "conversation-files",
          "conversation-tasks",
          "project-list",
          "project-detail",
          "project-context",
        ]),
      }),
    dispose: () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      pending = null;
      invalidators.clear();
    },
  };
};

export type AssistantLiveHub = ReturnType<typeof createAssistantLiveInvalidationHub>;

const AssistantLiveContext = createContext<AssistantLiveHub>();

export const AssistantLiveProvider = (props: { value: AssistantLiveHub; children: JSX.Element }) => (
  <AssistantLiveContext.Provider value={props.value}>{props.children}</AssistantLiveContext.Provider>
);

export const useAssistantLive = (): AssistantLiveHub => {
  const live = useContext(AssistantLiveContext);
  if (!live) throw new Error("Assistant live context is unavailable");
  return live;
};

export const matchesAssistantInvalidation = (
  domains: readonly AiInvalidationDomain[],
  input: { conversationId?: string; projectId?: string } = {},
) => {
  const domainSet = new Set(domains);
  return (invalidation: AssistantLiveInvalidation): boolean => {
    if (![...invalidation.domains].some((domain) => domainSet.has(domain))) return false;
    if (input.conversationId && invalidation.conversationIds && !invalidation.conversationIds.has(input.conversationId)) return false;
    if (input.projectId && invalidation.projectIds && !invalidation.projectIds.has(input.projectId)) return false;
    return true;
  };
};
