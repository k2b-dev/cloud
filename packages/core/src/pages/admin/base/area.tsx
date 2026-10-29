import { AdminArea } from "@k2b/cloud/ssr";
import type { JSX } from "solid-js";
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
  general: "ti ti-adjustments",
  legal: "ti ti-gavel",
  pdf: "ti ti-file-type-pdf",
  places: "ti ti-map-pin",
  cli: "ti ti-terminal-2",
};

export const baseText = (locale: string): BaseAreaMessages => baseAreaMessages.resolve([locale]).t;

/** The Base settings area: its sections as the first column and the open section beside it. */
export function BaseArea(props: { c: Parameters<typeof AdminArea>[0]["c"]; locale: string; section: BaseSection; children: JSX.Element }) {
  const t = baseText(props.locale);
  return (
    <AdminArea
      c={props.c}
      label={t.area}
      sectionsLabel={t.sections}
      href={BASE_SECTION_HREF.general}
      groups={[
        {
          items: BASE_SECTIONS.map((section) => ({
            id: section,
            label: t[section],
            href: BASE_SECTION_HREF[section],
            icon: ICON[section],
          })),
        },
      ]}
      current={props.section}
      title={t[props.section]}
    >
      {props.children}
    </AdminArea>
  );
}
