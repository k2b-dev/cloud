import { type ConfirmOptions, confirm } from "@k2b/ui/v2";

/** The question open now; a second one while it is open answers no at once. */
let open = false;

/**
 * `confirm` of `@k2b/ui/v2` where a phone's Back answers no, as in the phone's own apps: the open question stands as one
 * entry in the history, and Back closes it with Escape (which answers no) instead of leaving the page. Any other answer
 * takes the entry back out. One question at a time.
 * k2b-ui gap: v2 `confirm` has no option for the history (Y is adding it); this copy goes when it lands.
 */
export const confirmWithBack = async (options: ConfirmOptions): Promise<boolean> => {
  if (open) return false;
  open = true;
  history.pushState({ pwaQuestion: true }, "");
  let back = false;
  const escape = () => {
    const question = document.querySelector('[role="alertdialog"]');
    question?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    return question !== null;
  };
  const answerNo = () => {
    back = true;
    // a Back pressed before the dialog is drawn closes it as soon as it is
    if (!escape()) requestAnimationFrame(() => void escape());
  };
  window.addEventListener("popstate", answerNo, { once: true });
  try {
    return await confirm(options);
  } finally {
    window.removeEventListener("popstate", answerNo);
    if (!back) history.back();
    open = false;
  }
};
