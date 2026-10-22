import { AppWorkspace, Button, DescriptionList, DetailPanel, IconButton, PanelHeader } from "@k2b/ui";
import { createSignal, For, Show } from "solid-js";

/** The app area holds a 64 px rail strip and the app card, like a Cloud shell. */
export default function WorkspaceHostDemo(props: { host: number }) {
  const [open, setOpen] = createSignal(true);
  const messages = [
    { sender: "Mira Chen", subject: "Thursday's workshop", preview: "The agenda is ready. Can you review the final session?" },
    { sender: "Alex Morgan", subject: "Notes from the studio", preview: "Here are the sketches we discussed yesterday." },
    { sender: "Sam Rivera", subject: "A quick update", preview: "The new samples arrive next week." },
  ];
  return (
    <div class="k2b-ui ui-workspace-host-page">
      <div class="ui-workspace-host-area" style={{ width: `min(${props.host}px, 100%)`, container: "k2b-app-area / inline-size" }}>
        <div class="ui-workspace-host-card">
          <AppWorkspace>
            <AppWorkspace.Sidebar label="Mail folders">
              <AppWorkspace.SidebarDesktop>
                <AppWorkspace.SidebarBody>
                  <AppWorkspace.SidebarSection title="Mailbox">
                    <AppWorkspace.SidebarItem icon="ti ti-inbox" active onClick={() => setOpen(true)}>
                      Inbox
                    </AppWorkspace.SidebarItem>
                    <AppWorkspace.SidebarItem icon="ti ti-send">Sent</AppWorkspace.SidebarItem>
                    <AppWorkspace.SidebarItem icon="ti ti-archive">Archive</AppWorkspace.SidebarItem>
                  </AppWorkspace.SidebarSection>
                </AppWorkspace.SidebarBody>
              </AppWorkspace.SidebarDesktop>
            </AppWorkspace.Sidebar>
            <AppWorkspace.Content>
              <AppWorkspace.Main>
                <PanelHeader title="Inbox" subtitle="Team mailbox" size="md" />
                <For each={messages}>
                  {(message) => (
                    <AppWorkspace.SidebarItem
                      active={message.sender === "Mira Chen"}
                      description={message.preview}
                      onClick={() => setOpen(true)}
                    >
                      {message.sender} · {message.subject}
                    </AppWorkspace.SidebarItem>
                  )}
                </For>
                <Show when={!open()}>
                  <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
                    Show contact
                  </Button>
                </Show>
              </AppWorkspace.Main>
              <AppWorkspace.Detail id="contact" open={open()} width="lg" onClose={() => setOpen(false)}>
                <DetailPanel>
                  <DetailPanel.Header
                    title="Mira Chen"
                    subtitle="Workshop coordinator"
                    actions={
                      <IconButton
                        label="Close contact"
                        variant="ghost"
                        size="sm"
                        data-workspace-detail-close=""
                        onClick={() => setOpen(false)}
                      >
                        <i class="ti ti-x" aria-hidden="true" />
                      </IconButton>
                    }
                  />
                  <DetailPanel.Body>
                    <DetailPanel.Section title="Contact">
                      <DescriptionList
                        items={[
                          { term: "Email", description: "mira@example.com" },
                          { term: "Team", description: "Studio" },
                          { term: "Location", description: "Berlin" },
                        ]}
                      />
                    </DetailPanel.Section>
                  </DetailPanel.Body>
                </DetailPanel>
              </AppWorkspace.Detail>
            </AppWorkspace.Content>
          </AppWorkspace>
        </div>
      </div>
      <Show when={props.host < 1440}>
        <aside class="ui-workspace-host-panel" aria-label="Host panel">
          <p>Host panel</p>
        </aside>
      </Show>
      <style>{`
        .ui-workspace-host-page{position:fixed;inset:0;display:flex;background:var(--k2b-surface-muted)}
        .ui-workspace-host-area{flex:none;min-width:0;height:100%}
        .ui-workspace-host-card{height:calc(100% - 16px);margin:8px 8px 8px 64px}
        .ui-workspace-host-panel{flex:1;min-width:0;padding:1rem;color:var(--k2b-text-muted)}
        @media(max-width:47.999rem){.ui-workspace-host-card{height:100%;margin:0}}
      `}</style>
    </div>
  );
}
