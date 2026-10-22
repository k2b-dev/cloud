import { AppWorkspace, ScrollArea } from "@k2b/ui";

export function PrintWorkspace(props: { region: boolean }) {
  return (
    <AppWorkspace class="flex-1 min-h-0">
      <AppWorkspace.Sidebar label="Navigation">
        <AppWorkspace.SidebarDesktop>Sidebar</AppWorkspace.SidebarDesktop>
      </AppWorkspace.Sidebar>
      <AppWorkspace.Content>
        <AppWorkspace.Main>
          <h1 id="outside-heading">Outside the print region</h1>
          {/* A reader that fills Main and scrolls its history in a ScrollArea pinned into an overflow-hidden frame, as Mail's does. */}
          <article class="flex h-full min-h-0 flex-col overflow-hidden" data-print-region={props.region ? "" : undefined}>
            <h2>Invented field notes</h2>
            <div class="relative min-h-0 flex-1 overflow-hidden">
              <ScrollArea class="absolute inset-0">
                {Array.from({ length: 120 }, (_, i) => (
                  <p class="print-paragraph">Paragraph {i + 1}. A team records its observations for the next visit.</p>
                ))}
              </ScrollArea>
            </div>
          </article>
        </AppWorkspace.Main>
        <AppWorkspace.Detail id="details" open>
          Detail content
        </AppWorkspace.Detail>
      </AppWorkspace.Content>
      <AppWorkspace.BottomDrawer id="drawer" open>
        Drawer content
      </AppWorkspace.BottomDrawer>
    </AppWorkspace>
  );
}
