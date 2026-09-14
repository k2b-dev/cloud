import { Chat, type ChatActivityProps } from "@k2b/ui";
import { createContext, type JSX, splitProps, useContext } from "solid-js";

export type AiToolDisclosureState = {
  get: (blockId: string) => boolean | undefined;
  set: (blockId: string, open: boolean) => void;
};

export const createAiToolDisclosureState = (): AiToolDisclosureState => {
  const openByBlockId = new Map<string, boolean>();
  const storageKey = (blockId: string) => `cloud.ai.tool-disclosure:${blockId}`;
  return {
    get: (blockId) => {
      if (!openByBlockId.has(blockId)) {
        try {
          const saved = window.sessionStorage.getItem(storageKey(blockId));
          if (saved === "open") openByBlockId.set(blockId, true);
        } catch { /* SSR and disabled storage keep the in-memory state. */ }
      }
      return openByBlockId.get(blockId);
    },
    set: (blockId, open) => {
      openByBlockId.set(blockId, open);
      try {
        if (open) window.sessionStorage.setItem(storageKey(blockId), "open");
        else window.sessionStorage.removeItem(storageKey(blockId));
      } catch { /* Storage limits must not prevent expanding a tool. */ }
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
