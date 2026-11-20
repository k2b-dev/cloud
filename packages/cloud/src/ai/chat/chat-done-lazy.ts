import { createSignal } from "solid-js";
import { importOnDemand } from "../../browser/reload";
import type { aiChatDoneItem as renderItem } from "./chat-done-line";

const [renderer, setRenderer] = createSignal<typeof renderItem>();
let loading: Promise<void> | undefined;

/** Load before mounting a chat with stored activities; its server HTML stays visible until ready. */
export const preloadAiChatDone = (): Promise<void> => {
  loading ??= importOnDemand(() => import("./chat-done-line")).then((module) => {
    if (!module) {
      loading = undefined;
      throw new Error("Chat completion presentation could not load");
    }
    setRenderer(() => module.aiChatDoneItem);
  });
  return loading;
};

export const aiChatDoneItem = (...args: Parameters<typeof renderItem>) => renderer()?.(...args) ?? [];
