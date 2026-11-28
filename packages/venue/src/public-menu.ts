import { MAX_PUBLIC_MENU_ITEMS, MAX_PUBLIC_SECTIONS, PublicMenuItemSchema, type PublicSection } from "./contracts";

export const isPublicMenuItemAvailable = (item: unknown, date: string): boolean => {
  const parsed = PublicMenuItemSchema.safeParse(item);
  if (!parsed.success) return false;
  if (parsed.data.availableFrom && date < parsed.data.availableFrom) return false;
  if (parsed.data.availableUntil && date > parsed.data.availableUntil) return false;
  return true;
};

export const filterPublicMenuSections = (sections: PublicSection[], date: string): PublicSection[] =>
  sections.flatMap((section) => {
    if (section.kind !== "menu") return [section];
    const items = Array.isArray(section.content.items) ? section.content.items : [];
    const availableItems = items.filter((item) => isPublicMenuItemAvailable(item, date));
    return availableItems.length > 0
      ? [
          {
            ...section,
            content: {
              ...section.content,
              items: availableItems,
            },
          },
        ]
      : [];
  });

/**
 * The public page within its limits: the first {@link MAX_PUBLIC_SECTIONS} sections and, in their order, the first
 * {@link MAX_PUBLIC_MENU_ITEMS} menu items; a menu left without items is left out like a menu without current ones.
 * Saving never goes past these limits, so this only cuts a page saved before they existed, and the workspace says so.
 */
export const capPublicSections = (sections: PublicSection[]): PublicSection[] => {
  let itemsLeft = MAX_PUBLIC_MENU_ITEMS;
  return sections.slice(0, MAX_PUBLIC_SECTIONS).flatMap((section) => {
    if (section.kind !== "menu") return [section];
    const items = Array.isArray(section.content.items) ? section.content.items.slice(0, itemsLeft) : [];
    itemsLeft -= items.length;
    return items.length > 0 ? [{ ...section, content: { ...section.content, items } }] : [];
  });
};
