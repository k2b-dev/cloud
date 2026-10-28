import { AppWorkspace, useLocale } from "@k2b/ui";
import { activeAdminLink } from "./admin-active-link";
import { type AdminLink, buildAdminGroups } from "./admin-navigation";
import { platformMessages } from "./platform-messages";
import type { RuntimeContext } from "./runtime";
import WorkspaceNavigation from "./WorkspaceNavigation.island";

const AdminNavigation = (props: { currentPath: string; groups: ReturnType<typeof buildAdminGroups> }) => {
  const activeHref = activeAdminLink(
    props.currentPath,
    props.groups.flatMap((group) => group.links),
  )?.href;
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
    <>
      <WorkspaceNavigation
        label={t().admin}
        items={groups().map((group) => ({
          id: group.label,
          label: group.label,
          children: group.links.map((link) => ({
            id: link.href,
            label: link.label,
            href: link.href,
            icon: `ti ${link.icon}`,
            active:
              link.href ===
              activeAdminLink(
                currentPath,
                groups().flatMap((entry) => entry.links),
              )?.href,
          })),
        }))}
      />
      <AppWorkspace.Sidebar resizable={false}>
        <AppWorkspace.SidebarDesktop>
          <AppWorkspace.SidebarBody scrollPreserveKey="admin-sidebar">
            <AdminNavigation currentPath={currentPath} groups={groups()} />
          </AppWorkspace.SidebarBody>
        </AppWorkspace.SidebarDesktop>
      </AppWorkspace.Sidebar>
    </>
  );
}
