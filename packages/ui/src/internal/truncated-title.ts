/**
 * Titles in headers stay on one line and end with an ellipsis, so a long name never moves what follows. Pointing at a
 * cut title shows all of it as the native hint; assistive technology reads the full text content either way.
 */
export const showTruncatedTitle = (event: PointerEvent & { currentTarget: HTMLElement }) => {
  const title = event.currentTarget;
  if (title.scrollWidth > title.clientWidth + 1) title.title = title.textContent ?? "";
  else title.removeAttribute("title");
};
