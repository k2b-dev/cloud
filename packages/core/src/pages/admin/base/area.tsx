import { adminNavigation } from "@k2b/cloud/ssr";
import { type BaseAreaMessages, baseAreaMessages } from "./messages";

export const BASE_SECTIONS = ["general", "legal", "pdf", "places", "cli"] as const;
export type BaseSection = (typeof BASE_SECTIONS)[number];

export const BASE_SECTION_HREF: Record<BaseSection, string> = {
  general: "/admin/base",
  legal: "/admin/base/legal",
  pdf: "/admin/base/pdf",
  places: "/admin/base/places",
  cli: "/admin/base/cli",
};

const ICON: Record<BaseSection, string> = {
  general: "adjustments",
  legal: "gavel",
  pdf: "file-type-pdf",
  places: "map-pin",
  cli: "terminal-2",
};

export const baseText = (locale: string): BaseAreaMessages => baseAreaMessages.resolve([locale]).t;

/** The admin bar with the Base settings sections one level in under its entry, the open one current. */
export const baseNav = (c: Parameters<typeof adminNavigation>[0], locale: string, current: BaseSection) => {
  const t = baseText(locale);
  return adminNavigation(
    c,
    BASE_SECTIONS.map((section) => ({
      label: t[section],
      icon: ICON[section],
      href: BASE_SECTION_HREF[section],
      current: section === current,
    })),
  );
};
