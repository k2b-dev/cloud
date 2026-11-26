import { type ConfirmOptions, confirm } from "@k2b/ui/v2";

/**
 * `confirm` of `@k2b/ui/v2` where a phone's Back answers no, as in the phone's own apps: the open question stands as one
 * entry in the history, and Back closes it with Escape (which answers no) instead of leaving the page. Any other answer
 * takes the entry back out.
 * k2b-ui gap: v2 `confirm` has no option for the history; this belongs there.
 */
export const confirmWithBack = async (options: ConfirmOptions): Promise<boolean> => {
  history.pushState({ pwaQuestion: true }, "");
  let back = false;
  const answerNo = () => {
    back = true;
    const question = document.querySelector('[role="alertdialog"]') ?? document.activeElement ?? document.body;
    question.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  };
  window.addEventListener("popstate", answerNo, { once: true });
  try {
    return await confirm(options);
  } finally {
    window.removeEventListener("popstate", answerNo);
    if (!back) history.back();
  }
};
