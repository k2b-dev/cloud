### A global change to the dialog frame broke apps that read layout after a content change

- **What happened:** Holding every dialog's height and folding it a frame later broke about fifteen app tests and flows across six CI rounds (RichSelect, access, search, chat, admin and approval dialogs). Each read a size or overflow right after its content changed and saw the held height instead of the natural one.
- **Root cause:** The fold changed the timing of layout for every consumer of a shared primitive. Code that reads layout synchronously after a content change had always been correct, so each round fixed one consumer and the next round found another.
- **Error class:** A timing change to a shared primitive applied to every consumer instead of those that ask for it.
- **Guard:** Following content is opt-in through `followContent` (form prompts opt in). `packages/ui/src/feedback/dialog-height.browser.test.ts` ("without opt-in content keeps its immediate natural layout…") proves that the default and explicit opt-out grow immediately without a held height or a fold, and `packages/ui/test/feedback-runtime.behavior.test.ts` checks the form defaults and the opt-out.
