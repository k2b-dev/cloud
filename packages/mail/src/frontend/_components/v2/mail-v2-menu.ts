import type { DropdownAction, DropdownChoice, DropdownItem, DropdownSection } from "@k2b/ui";
import type { MenuEntry, MenuItem } from "@k2b/ui/v2";

const iconName = (icon: string | undefined) => icon?.replace(/^ti\s+ti-/, "").replace(/\s.*$/, "") || undefined;

const toMenuItem = (item: DropdownAction | DropdownChoice): MenuItem => {
  const href = "href" in item ? item.href : undefined;
  return {
    label: item.label,
    ...(iconName(item.icon) ? { icon: iconName(item.icon) } : {}),
    ...(href ? { href } : {}),
    ...("action" in item && item.action ? { onClick: item.action } : {}),
    ...(item.variant === "danger" ? { danger: true } : {}),
    ...(item.disabled ? { disabled: true } : {}),
    ...("checked" in item ? { checked: typeof item.checked === "function" ? item.checked() : item.checked } : {}),
  };
};

const isSection = (item: DropdownItem): item is DropdownSection => "items" in item && !("label" in item);

/**
 * Mail's menus as the v2 `Menu` takes them: the same entries the v1 menus build (one builder per menu, so the two
 * cannot drift apart), with each section after a line. A section's label has no place in a v2 menu and is left out.
 */
export const mailV2MenuEntries = (items: readonly DropdownItem[]): MenuEntry[] =>
  items.flatMap((item): MenuEntry[] => (isSection(item) ? ["separator", ...item.items.map(toMenuItem), "separator"] : [toMenuItem(item)]));
