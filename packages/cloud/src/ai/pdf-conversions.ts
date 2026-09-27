/**
 * Chat PDF tools share Gotenberg with every other Cloud renderer. Like the
 * Tools app's Markdown route, one process renders at most two chat PDFs at a
 * time and rejects further conversions instead of queueing them until the
 * render timeout.
 */
export const AI_PDF_MAX_ACTIVE_CONVERSIONS = 2;

let activeConversions = 0;

export const withAiPdfConversionSlot = async <T>(render: () => Promise<T>): Promise<T> => {
  if (activeConversions >= AI_PDF_MAX_ACTIVE_CONVERSIONS) {
    throw new Error("The PDF renderer is busy with other conversions. Try again after they finish.");
  }
  activeConversions += 1;
  try {
    return await render();
  } finally {
    activeConversions -= 1;
  }
};
