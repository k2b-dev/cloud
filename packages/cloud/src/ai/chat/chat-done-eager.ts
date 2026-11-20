export { aiChatDoneItem } from "./chat-done-line";

/** Server rendering already holds the activity presentation. */
export const preloadAiChatDone = (): Promise<void> => Promise.resolve();
