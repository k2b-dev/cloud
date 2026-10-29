import { AppWorkspace, StatusBadge } from "@k2b/ui";
import type { JSX } from "solid-js";
import AdminLayout from "./AdminLayout";
import SettingsSaveStatus from "./SettingsSaveStatus.island";

/** One row of an area's first column. `mark` shows a dot when the section needs attention. */
export type AdminAreaItem = {
  id: string;
  label: string;
  href: string;
  icon: string;
  description?: string;
  mark?: "warning" | "error";
};
export type AdminAreaGroup = { title?: string; items: AdminAreaItem[] };

type AdminAreaProps = {
  c: Parameters<typeof AdminLayout>[0]["c"];
  /** The area's name, the head of the first column. */
  label: string;
  /** Accessible name of the first column's navigation, for example "Observability sections". */
  sectionsLabel: string;
  /** The area's start; the first column's head links there. */
  href: string;
  groups: AdminAreaGroup[];
  /** Id of the open section's item. */
  current: string;
  /** Page title, usually the open section's label. */
  title: string;
  /** Spoken with a mark in the first column, for example "Needs attention". */
  markLabel?: string;
  /** Id of the deepest open level: "section", or a deeper pane id the page adds. */
  level?: string;
  /** The section's panes, starting with one whose id is "section". */
  children: JSX.Element;
};

/**
 * An administration area: the admin layout, the area's sections as the first column, and the open section beside
 * it as `AppWorkspace` levels. The owner builds each section's content by hand; a wide list adds `minSize`, so it
 * pushes the first column aside instead of being squeezed.
 */
export function AdminArea(props: AdminAreaProps) {
  return (
    <AdminLayout c={props.c} title={props.title} ownMain>
      <AppWorkspace.Main level={props.level ?? "section"}>
        <AppWorkspace.MainPane id="area" label={props.label} href={props.href} defaultSize={248} minSize={232} maxSize={320}>
          <nav aria-label={props.sectionsLabel}>
            {props.groups.map((group) => (
              <AppWorkspace.SidebarSection title={group.title}>
                {group.items.map((item) => (
                  <AppWorkspace.SidebarItem
                    href={item.href}
                    navigation="document"
                    active={props.current === item.id}
                    icon={item.icon}
                    description={item.description}
                    meta={
                      item.mark ? (
                        <span title={props.markLabel}>
                          <StatusBadge tone={item.mark} variant="dot" label="" />
                          <span class="sr-only">{props.markLabel}</span>
                        </span>
                      ) : undefined
                    }
                  >
                    {item.label}
                  </AppWorkspace.SidebarItem>
                ))}
              </AppWorkspace.SidebarSection>
            ))}
          </nav>
        </AppWorkspace.MainPane>
        {props.children}
      </AppWorkspace.Main>
    </AdminLayout>
  );
}

/** The save status in a level head. A phone has no room there; `AdminAreaSaveStatusFoot` shows it at the bottom. */
export const AdminAreaSaveStatusHead = () => (
  <div class="hidden md:block">
    <SettingsSaveStatus />
  </div>
);
export const AdminAreaSaveStatusFoot = () => (
  <div class="sticky bottom-0 flex justify-end bg-(--k2b-surface) px-2 py-3 md:hidden">
    <SettingsSaveStatus />
  </div>
);

/** A section that fills the width beside the first column, such as a dashboard or one form. */
export function AdminAreaPane(props: {
  label: string;
  description?: JSX.Element;
  /** Before the title, such as a step back inside the section. */
  lead?: JSX.Element;
  actions?: JSX.Element;
  /** A form that saves with a button: its status, Discard and Save sit in the head, on a phone at the bottom. */
  saveStatus?: boolean;
  /** With a detail level beside it: the address of this level without the selection. */
  href?: string;
  /** A wide list declares the room it needs; the first column then gives way before the list is squeezed. */
  minSize?: number;
  children: JSX.Element;
}) {
  return (
    <AppWorkspace.MainPane
      id="section"
      label={props.label}
      description={props.description}
      lead={props.lead}
      actions={
        props.saveStatus ? (
          <div class="flex items-center gap-2">
            {props.actions}
            <AdminAreaSaveStatusHead />
          </div>
        ) : (
          props.actions
        )
      }
      href={props.href}
      minSize={props.minSize}
      defaultSize={props.minSize}
    >
      <div class="app-rows pb-[var(--ui-space-shell)]">{props.children}</div>
      {props.saveStatus ? <AdminAreaSaveStatusFoot /> : null}
    </AppWorkspace.MainPane>
  );
}
