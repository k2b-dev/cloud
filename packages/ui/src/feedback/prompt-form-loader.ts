type PromptForm = typeof import("./prompt-form");
let promptForm: PromptForm | undefined;
let promptFormLoading: Promise<PromptForm> | undefined;

/** The form module once it has loaded, so a prompt opens in the same task as its call. */
export const loadedPromptForm = (): PromptForm | undefined => promptForm;

/**
 * The form prompts and the typed confirmation phrase load their field components on demand, so an island that only
 * confirms or alerts does not carry the date picker, the Markdown editor and the other fields in its first script. A
 * failed chunk request may succeed on the next open.
 */
export const loadPromptForm = (): Promise<PromptForm> =>
  (promptFormLoading ??= import("./prompt-form").then(
    (module) => (promptForm = module),
    (error: unknown) => {
      promptFormLoading = undefined;
      throw error;
    },
  ));
