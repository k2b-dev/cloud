import { AppWorkspace, useLocale } from "@k2b/ui";
import { activeAdminHref } from "./admin-active-link";
import { type AdminLink, buildAdminGroups } from "./admin-navigation";
import type { RuntimeContext } from "./runtime";
import { platformMessages } from "./platform-messages";

const AdminNavigation = (props: { currentPath: string; groups: ReturnType<typeof buildAdminGroups> }) => {
  const activeHref = activeAdminHref(
    props.currentPath,
    props.groups.flatMap((group) => group.links.map((link: AdminLink) => link.href)),
  );
  return (
    <>
      {props.groups.map((group) => (
        <AppWorkspace.SidebarSection title={group.label}>
          {group.links.map((link: AdminLink) => (
            <AppWorkspace.SidebarItem href={link.href} navigation="document" active={link.href === activeHref} title={link.label}>
              <AppWorkspace.SidebarItemIcon icon={`ti ${link.icon}`} />
              <AppWorkspace.SidebarItemLabel>{link.label}</AppWorkspace.SidebarItemLabel>
            </AppWorkspace.SidebarItem>
          ))}
        </AppWorkspace.SidebarSection>
      ))}
    </>
  );
};

export default function AdminSidebar({ currentPath, apps }: { currentPath: string; apps: readonly RuntimeContext["apps"][number][] }) {
  const locale = useLocale();
  const t = () => platformMessages.resolve([locale()]).t;
  const groups = () => buildAdminGroups(apps, locale());

  return (
    <AppWorkspace.Sidebar resizable={false}>
      <AppWorkspace.SidebarMobileTrigger label={t().admin} />

      <AppWorkspace.SidebarMobile>
        <AppWorkspace.SidebarMobileBody scrollPreserveKey="admin-sidebar-mobile">
          <AdminNavigation currentPath={currentPath} groups={groups()} />
        </AppWorkspace.SidebarMobileBody>
      </AppWorkspace.SidebarMobile>

      <AppWorkspace.SidebarDesktop>
        <AppWorkspace.SidebarBody scrollPreserveKey="admin-sidebar">
          <AdminNavigation currentPath={currentPath} groups={groups()} />
        </AppWorkspace.SidebarBody>
      </AppWorkspace.SidebarDesktop>
    </AppWorkspace.Sidebar>
  );
}
