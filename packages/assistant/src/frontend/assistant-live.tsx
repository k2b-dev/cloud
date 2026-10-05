import { AI_INVALIDATION_DOMAINS, type AiInvalidation, type AiInvalidationDomain, AiInvalidationSchema } from "@k2b/cloud/ai/live-events";
import { type LiveSubscription, liveConnection } from "@k2b/cloud/browser/live";
import { createContext, type JSX, useContext } from "solid-js";

export type AssistantLiveInvalidation = {
  domains: ReadonlySet<AiInvalidationDomain>;
  /** `null`: every conversation. */
  conversationIds: ReadonlySet<string> | null;
  /** `null`: every Project. */
  projectIds: ReadonlySet<string> | null;
};

type Invalidator = {
  matches: (invalidation: AssistantLiveInvalidation) => boolean;
  invalidate: (invalidation: AssistantLiveInvalidation) => Promise<void>;
};

const ofEvent = (event: AiInvalidation): AssistantLiveInvalidation => ({
  domains: new Set(event.domains),
  conversationIds: event.conversationId ? new Set([event.conversationId]) : null,
  projectIds: event.projectId ? new Set([event.projectId]) : null,
});

const everything: AssistantLiveInvalidation = { domains: new Set(AI_INVALIDATION_DOMAINS), conversationIds: null, projectIds: null };

/**
 * The Assistant views that reload when AI data changes. The live subscription
 * hands it each batch of updates and moves its cursor once the returned promise
 * resolves; a rejection makes it try again.
 */
export const createAssistantLiveHub = () => {
  const invalidators = new Set<Invalidator>();
  /** Reloads every view that one of the invalidations matches, each view once. */
  const run = async (invalidations: readonly AssistantLiveInvalidation[]) => {
    const reloads: Promise<void>[] = [];
    for (const invalidator of invalidators) {
      const match = invalidations.find((invalidation) => invalidator.matches(invalidation));
      if (match) reloads.push(invalidator.invalidate(match));
    }
    await Promise.all(reloads);
  };
  return {
    register: (invalidator: Invalidator) => {
      invalidators.add(invalidator);
      return () => invalidators.delete(invalidator);
    },
    /** Reloads the views that a batch of updates changed. */
    apply: (events: readonly AiInvalidation[]) => run(events.map(ofEvent)),
    /** Reloads every view: updates were missed. */
    resync: () => run([everything]),
  };
};

export type AssistantLiveHub = ReturnType<typeof createAssistantLiveHub>;

/**
 * Follows the user's AI live updates on Core's socket from the page's cursor;
 * the hub reloads what changed. `failing` reports a reload that failed and is
 * tried again, and its success. `stopped`: the session ended, or reloading kept
 * failing, so live updates stopped.
 */
export const followAssistantLive = (
  hub: AssistantLiveHub,
  options: { cursor: string; failing: (failing: boolean) => void; stopped: () => void },
): LiveSubscription => {
  const reload = async (run: () => Promise<void>) => {
    try {
      await run();
      options.failing(false);
    } catch (error) {
      options.failing(true);
      throw error;
    }
  };
  return liveConnection("/api/ai/live").subscribe(
    "user",
    {},
    {
      cursor: options.cursor,
      parse: (data) => AiInvalidationSchema.parse(data),
      apply: (events) => reload(() => hub.apply(events.map((event) => event.data))),
      resync: () => reload(hub.resync),
      revoked: options.stopped,
      unavailable: options.stopped,
    },
  );
};

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
