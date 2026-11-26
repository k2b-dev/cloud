/** How many bases the sidebar of a base lists; "Alle Basen" leads to the rest, so a person with many bases keeps a short page. */
export const NAV_BASES = 50;

/** The bases the sidebar lists: the first `NAV_BASES`, and the open one always among them. */
export const navBases = <T extends { id: string }>(bases: readonly T[], currentId: string): T[] => {
  const shown = bases.slice(0, NAV_BASES);
  const current = bases.find((base) => base.id === currentId);
  if (current && !shown.includes(current)) shown.push(current);
  return shown;
};
