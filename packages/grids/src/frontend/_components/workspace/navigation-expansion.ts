import { type NavigationGroup, navigationReferenceKey } from "../../../navigation-contracts";

export const initialNavigationExpansion = (
  groups: readonly NavigationGroup[],
  stored: readonly string[] | undefined,
  active: string | null,
  types: readonly string[],
): string[] => {
  const valid = new Set([...groups.map((group) => `group:${group.id}`), ...types.map((type) => `type:${type}`)]);
  const expanded = new Set(stored === undefined ? groups.map((group) => `group:${group.id}`) : stored.filter((id) => valid.has(id)));
  if (active) {
    const group = groups.find((group) => group.entries.some((entry) => navigationReferenceKey(entry) === active));
    expanded.add(group ? `group:${group.id}` : `type:${active.split(":")[0]}`);
  }
  return [...expanded].filter((id) => valid.has(id));
};
