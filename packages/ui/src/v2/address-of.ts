/**
 * The address of a display form (`Name <a@b.example>` or `a@b.example`): what stands in `<…>`, or the whole. A file of
 * its own, so a page that only reads addresses does not load the address parser of the address field (`addresses.ts`).
 */
export const addressOf = (display: string): string => {
  const open = display.lastIndexOf("<");
  return (open >= 0 && display.endsWith(">") ? display.slice(open + 1, -1) : display).trim();
};
