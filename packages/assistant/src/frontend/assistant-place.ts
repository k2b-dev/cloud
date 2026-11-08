import type { CloudResourceRef, PanelPageContext } from "@k2b/cloud/contracts";
import { createSignal, onCleanup } from "solid-js";
import { z } from "zod";

/** The application that declares the place, as the panel names it. */
export type AssistantPlaceApp = { id: string; name: string; icon: string | null };
/** An action's policy as the panel reads it: `silent` asks once and can be remembered, `ask` asks every time. */
export type AssistantPlacePolicy = { silent: "you" | "draft" | "shared"; routines?: false } | { ask: string };
/** One extra tool of a place: an action of the place's app; its policy decides when Gustav asks, as everywhere. */
export type AssistantPlaceTool = { id: string; title: string; icon: string | null; policy: AssistantPlacePolicy | null };

/**
 * What the panel knows about a place, from the server's `loadPlaceAssistant` (first paint) and
 * `GET /api/ai/places/:type/:id` (navigation). `none`: the type declares no `assistant` block, so Gustav stays the
 * normal panel. `unavailable`: not found and no access look the same. `conversationId` is the person's own chat at
 * this place, or null before the first message.
 */
export type AssistantPlaceView =
  | { state: "none"; ref: CloudResourceRef }
  | { state: "unavailable"; ref: CloudResourceRef; title: string | null; app?: AssistantPlaceApp | null; conversationId: string | null }
  | {
      state: "available";
      ref: CloudResourceRef;
      title: string;
      app: AssistantPlaceApp;
      typeTitle: string;
      tools: AssistantPlaceTool[];
      skills: { id: string; title: string }[];
      starters: { label: string; prompt: string }[];
      conversationId: string | null;
    };

const RefSchema = z.object({ type: z.string().min(1).max(180), id: z.string().min(1).max(512) }).strict();
const AppSchema = z.object({ id: z.string().min(1), name: z.string().min(1), icon: z.string().nullable() });
const PolicySchema = z.union([
  z.object({ silent: z.enum(["you", "draft", "shared"]), routines: z.literal(false).optional() }),
  z.object({ ask: z.string() }),
]);
// The panel reads only what it shows; the server validated the provider's answer already (AssistantPlaceSchema).
const PlaceAnswerSchema = z.discriminatedUnion("state", [
  // No Gustav place here, or no consent to share it: the panel stays the normal Gustav panel.
  z.object({ state: z.enum(["none", "consent_required"]) }),
  z.object({
    state: z.literal("unavailable"),
    ref: RefSchema,
    title: z.string().max(200).nullable(),
    app: AppSchema.nullable().optional(),
    conversationId: z.string().nullable(),
  }),
  z.object({
    state: z.literal("available"),
    ref: RefSchema,
    title: z.string().min(1).max(200),
    app: AppSchema,
    typeTitle: z.string().min(1),
    tools: z.array(z.object({ id: z.string(), title: z.string(), icon: z.string().nullable(), policy: PolicySchema.nullable() })).max(16),
    skills: z.array(z.object({ id: z.string(), title: z.string() })).max(8),
    starters: z.array(z.object({ label: z.string().max(80), prompt: z.string().max(500) })).max(3),
    conversationId: z.string().nullable(),
  }),
]);
/** The server's answer as the panel reads it; `ref` is the place the panel asked for when the answer names none. */
export const readAssistantPlace = (ref: CloudResourceRef, answer: unknown): AssistantPlaceView => {
  const parsed = PlaceAnswerSchema.parse(answer);
  if (parsed.state === "available" || parsed.state === "unavailable") return parsed;
  return { state: "none", ref: { ...ref } };
};

export const placeKey = (ref: CloudResourceRef | null | undefined): string | null => (ref ? `${ref.type}:${ref.id}` : null);
export const samePlace = (a: CloudResourceRef | null | undefined, b: CloudResourceRef | null | undefined): boolean =>
  Boolean(a && b && a.type === b.type && a.id === b.id);

/** A list item's place, `{ ref, title }` on `GET /api/ai/conversations` and in the sidebar snapshot; null without one. */
export type AssistantConversationPlace = { ref: CloudResourceRef; title: string; app?: AssistantPlaceApp | null };
const ConversationPlaceSchema = z.object({ ref: RefSchema, title: z.string(), app: AppSchema.nullable().optional() });
export const conversationPlace = (conversation: unknown): AssistantConversationPlace | null => {
  if (!conversation || typeof conversation !== "object" || !("place" in conversation)) return null;
  return ConversationPlaceSchema.safeParse(conversation.place).data ?? null;
};

/**
 * O1: the panel follows the page to a new place while it shows nothing to lose, which is an empty chat or a chat at a
 * place. Any other chat stays; the place bar then offers the switch.
 */
export const panelFollowsPlace = (open: { conversationId: string | null; empty: boolean; atPlace: boolean }): boolean =>
  !open.conversationId || open.empty || open.atPlace;

export type PlaceLoadState = "idle" | "loading" | "failed";
export type PlaceLoader = (ref: CloudResourceRef, signal: AbortSignal) => Promise<AssistantPlaceView>;

/**
 * The page's place in the panel. Each accepted page context starts one load; only the answer for the context that is
 * still current (same `pageId` and `seq`) is applied, so a late answer for an earlier page changes nothing.
 */
export function createPagePlace(options: {
  context: PanelPageContext | null;
  initial: AssistantPlaceView | null;
  load: PlaceLoader;
  /** Runs once for each applied answer, after the view is set. */
  onPlace?: (view: AssistantPlaceView) => void;
}) {
  const [context, setContext] = createSignal(options.context);
  const [view, setView] = createSignal<AssistantPlaceView | null>(
    options.initial && samePlace(options.initial.ref, options.context?.scope) ? options.initial : null,
  );
  const [state, setState] = createSignal<PlaceLoadState>("idle");
  let controller: AbortController | undefined;
  const current = (token: PanelPageContext) => {
    const now = context();
    return now?.pageId === token.pageId && now.seq === token.seq && samePlace(now.scope, token.scope);
  };
  const request = (next: PanelPageContext) => {
    const ref = next.scope;
    if (!ref) return;
    controller?.abort();
    const abort = new AbortController();
    controller = abort;
    setState("loading");
    options.load({ ...ref }, abort.signal).then(
      (answer) => {
        if (abort.signal.aborted || !current(next)) return;
        setView(answer);
        setState("idle");
        options.onPlace?.(answer);
      },
      () => {
        if (abort.signal.aborted || !current(next)) return;
        setState("failed");
      },
    );
  };
  const receive = (next: PanelPageContext | null) => {
    const before = context();
    setContext(next);
    if (!next?.scope) {
      controller?.abort();
      setView(null);
      setState("idle");
      return;
    }
    // A new seq on the same place (Help ids, a re-publish) keeps what the panel shows.
    if (samePlace(before?.scope, next.scope) && view() && state() !== "failed") return;
    if (!samePlace(view()?.ref, next.scope)) setView(null);
    request(next);
  };
  onCleanup(() => controller?.abort());
  return {
    context,
    view,
    state,
    receive,
    retry: () => {
      const now = context();
      if (now?.scope) request(now);
    },
    /** Applies a view the panel learned another way, such as after "Start over", when it is still this page's place. */
    update: (next: AssistantPlaceView) => {
      if (samePlace(next.ref, context()?.scope)) setView(next);
    },
  };
}
export type PagePlace = ReturnType<typeof createPagePlace>;

/** Reads a place the way the panel shows it. Throws on any failure, which the bar shows with "Try again". */
export const fetchAssistantPlace: PlaceLoader = async (ref, signal) => {
  const response = await fetch(`/api/ai/places/${encodeURIComponent(ref.type)}/${encodeURIComponent(ref.id)}`, {
    signal,
    credentials: "same-origin",
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Place request failed with ${response.status}`);
  return readAssistantPlace(ref, await response.json());
};

export type PlacePolicyText = { asks: "once" | "always" | null; reach: "you" | "draft" | "shared" | null };
export const placePolicyText = (policy: AssistantPlacePolicy | null): PlacePolicyText =>
  !policy ? { asks: null, reach: null } : "silent" in policy ? { asks: "once", reach: policy.silent } : { asks: "always", reach: null };
