import { AppWorkspace, IconButtonLink, useLocale, ViewTabs } from "@k2b/ui";
import type { JSX } from "solid-js";
import { appAccessMessages } from "./app-access-messages";

/** Fictional consuming application: the editor's placement belongs to its author. */
export default function AppAccessBrowserFrame(props: { children: JSX.Element }) {
  return (
    <AppWorkspace mobileSurface="flush" resizable={false}>
      <AppWorkspace.Sidebar label="Rechnungen" defaultSize={240} resizable={false}>
        <AppWorkspace.SidebarDesktop>
          <AppWorkspace.SidebarBody>
            <AppWorkspace.SidebarSection title="Rechnungen">
              <AppWorkspace.SidebarItem href="#open" icon="ti ti-inbox" title="Offen">
                Offen
              </AppWorkspace.SidebarItem>
              <AppWorkspace.SidebarItem href="#paid" icon="ti ti-circle-check" title="Bezahlt">
                Bezahlt
              </AppWorkspace.SidebarItem>
              <AppWorkspace.SidebarItem href="#drafts" icon="ti ti-file" title="Entwürfe">
                Entwürfe
              </AppWorkspace.SidebarItem>
            </AppWorkspace.SidebarSection>
          </AppWorkspace.SidebarBody>
          <AppWorkspace.SidebarSection>
            <AppWorkspace.SidebarItem href="#settings" icon="ti ti-settings" title="Einstellungen" active>
              Einstellungen
            </AppWorkspace.SidebarItem>
          </AppWorkspace.SidebarSection>
        </AppWorkspace.SidebarDesktop>
      </AppWorkspace.Sidebar>
      <AppWorkspace.Content>
        <AppWorkspace.Main class="px-4 pt-2 pb-24 sm:px-8 sm:pt-5 sm:pb-12">
          <div class="mb-5">
            <ViewTabs
              label="Einstellungen"
              current="access"
              items={[
                { id: "general", label: "Allgemein", href: "#general" },
                { id: "numbers", label: "Nummernkreise", href: "#numbers" },
                { id: "access", label: "Zugriff", href: "#access" },
              ]}
            />
          </div>
          {props.children}
        </AppWorkspace.Main>
      </AppWorkspace.Content>
    </AppWorkspace>
  );
}

/** Core's repair page header (packages/core/src/pages/admin/apps/page.tsx), so captures show the real placement. */
export function AppAccessRepairFrame(props: { name: string; children: JSX.Element }) {
  const locale = useLocale(),
    t = () => appAccessMessages.resolve([locale()]).t;
  return (
    <div class="flex flex-col gap-5">
      <div class="flex items-center gap-3">
        <IconButtonLink href="/admin/apps" variant="ghost" style={{ width: "36px", "min-height": "36px" }} label={t().backToApps}>
          <i class="ti ti-arrow-left" />
        </IconButtonLink>
        <h1 class="text-lg font-semibold sm:text-xl">
          {props.name} · {t().access}
        </h1>
      </div>
      {props.children}
    </div>
  );
}
