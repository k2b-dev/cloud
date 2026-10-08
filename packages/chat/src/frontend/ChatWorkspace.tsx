import { AppWorkspace, Placeholder, useLocale } from "@k2b/ui";
import { chatMessages } from "../messages";

/** The full view's frame. Until chats exist it shows the empty sidebar section and the empty work area. */
export default function ChatWorkspace() {
  const locale = useLocale();
  const t = () => chatMessages.resolve([locale()]).t;
  return (
    <AppWorkspace mobileSurface="flush" class="h-full">
      <AppWorkspace.Sidebar label={t().chats}>
        <AppWorkspace.SidebarDesktop>
          <AppWorkspace.SidebarBody scrollPreserveKey="chat-sidebar">
            <AppWorkspace.SidebarSection title={t().chats}>
              <Placeholder variant="inline" align="left" description={t().noneYet} />
            </AppWorkspace.SidebarSection>
          </AppWorkspace.SidebarBody>
        </AppWorkspace.SidebarDesktop>
      </AppWorkspace.Sidebar>
      <AppWorkspace.Content>
        <AppWorkspace.Main scroll={false}>
          <Placeholder variant="panel" class="flex-1" icon="ti ti-messages" title={t().noChatsTitle} description={t().noChatsDescription} />
        </AppWorkspace.Main>
      </AppWorkspace.Content>
    </AppWorkspace>
  );
}
