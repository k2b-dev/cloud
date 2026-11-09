/**
 * True while an app bar entry's name is not fully visible: hidden beside the icon in the narrow app bar, or cut off
 * in the wide one. The entry's hint shows exactly then.
 */
export const railNameClipped = (target: Element | undefined): boolean => {
  const label = target?.querySelector(".rail-item-label");
  return !label || label.scrollWidth > label.clientWidth + 0.5;
};

/**
 * The server renders `data-rail-names` from the saved setting, so the first frame has its width. A save in the editor
 * or a swapped page keeps the kept app bar in step with the setting.
 */
export const syncRailNames = (showNames: boolean) =>
  document.querySelector(".cloud-app-canvas > .layout-rail")?.toggleAttribute("data-rail-names", showNames);
