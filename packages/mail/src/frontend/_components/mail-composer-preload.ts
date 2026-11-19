/**
 * Loads the composer and its editor before the first New message or reply needs them: when the mailbox is idle after
 * hydration, and when a compose starts, beside its draft requests. A failed load stays silent here; opening the
 * composer loads again and shows its own error with Retry.
 */
export const preloadMailComposer = (): void => {
  void Promise.all([import("./MailComposer"), import("./MailComposerEditor").then((editor) => editor.preloadMailComposerEditor())]).catch(
    () => undefined,
  );
};
