import { Chat, type ChatActivityProps } from "@k2b/ui";
import { createContext, createSignal, type JSX, type Signal, splitProps, useContext } from "solid-js";

export type AiToolDisclosureState = {
  get: (blockId: string) => boolean | undefined;
  set: (blockId: string, open: boolean) => void;
};

/**
 * Disclosure choices by block id. Reactive, so a disclosure that its reader opens renders its body at once, also when
 * nothing else in the turn changes; choices survive a remount and, in session storage, a reload.
 */
export const createAiToolDisclosureState = (): AiToolDisclosureState => {
  const signals = new Map<string, Signal<boolean | undefined>>();
  const storageKey = (blockId: string) => `cloud.ai.tool-disclosure:${blockId}`;
  const signal = (blockId: string): Signal<boolean | undefined> => {
    const existing = signals.get(blockId);
    if (existing) return existing;
    let saved: boolean | undefined;
    try {
      if (window.sessionStorage.getItem(storageKey(blockId)) === "open") saved = true;
    } catch {
      /* SSR and disabled storage keep the in-memory state. */
    }
    const created = createSignal(saved);
    signals.set(blockId, created);
    return created;
  };
  return {
    get: (blockId) => signal(blockId)[0](),
    set: (blockId, open) => {
      signal(blockId)[1](open);
      try {
        if (open) window.sessionStorage.setItem(storageKey(blockId), "open");
        else window.sessionStorage.removeItem(storageKey(blockId));
      } catch {
        /* Storage limits must not prevent expanding a tool. */
      }
    },
  };
};

const AiToolDisclosureContext = createContext<AiToolDisclosureState>();

export function AiToolDisclosureProvider(props: { state: AiToolDisclosureState; children: JSX.Element }): JSX.Element {
  return <AiToolDisclosureContext.Provider value={props.state}>{props.children}</AiToolDisclosureContext.Provider>;
}

export function AiToolActivity(props: Omit<ChatActivityProps, "open" | "onOpenChange"> & { blockId: string }): JSX.Element {
  const [local, activity] = splitProps(props, ["blockId"]);
  const disclosure = useAiToolDisclosure(() => local.blockId);
  return <Chat.Activity {...activity} open={disclosure.open()} onOpenChange={disclosure.onOpenChange} />;
}

export function useAiToolDisclosure(blockId: () => string | undefined) {
  const state = useContext(AiToolDisclosureContext);
  return {
    open: () => {
      const id = blockId();
      return id ? state?.get(id) : undefined;
    },
    onOpenChange: (open: boolean) => {
      const id = blockId();
      if (id) state?.set(id, open);
    },
  };
}
