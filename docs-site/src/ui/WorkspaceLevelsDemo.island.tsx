import {
  AppWorkspace,
  type AppWorkspaceLayoutState,
  appWorkspaceLayoutStyle,
  Button,
  DescriptionList,
  Placeholder,
  serializeAppWorkspaceLayoutState,
  StatusBadge,
} from "@k2b/ui";
import { For, Show } from "solid-js";

type Model = { id: string; name: string; summary: string; context: string; access: string };
type Provider = { id: string; name: string; kind: string; status: "Connected" | "Key missing"; models: Model[] };

const providers: Provider[] = [
  {
    id: "northstar",
    name: "Northstar AI",
    kind: "OpenAI-compatible",
    status: "Connected",
    models: [
      { id: "atlas", name: "Atlas", summary: "Drafting and research", context: "128,000 tokens", access: "Everyone" },
      { id: "atlas-mini", name: "Atlas Mini", summary: "Fast answers", context: "64,000 tokens", access: "Everyone" },
      { id: "lumen", name: "Lumen", summary: "Images and documents", context: "32,000 tokens", access: "Design team" },
    ],
  },
  {
    id: "harbor",
    name: "Harbor Compute",
    kind: "Self-hosted",
    status: "Connected",
    models: [{ id: "keel", name: "Keel 70B", summary: "Long reports", context: "200,000 tokens", access: "Analysts" }],
  },
  { id: "meridian", name: "Meridian", kind: "Hosted API", status: "Key missing", models: [] },
];

const base = "/en/ui/demo/workspace-levels";
const href = (level: string, provider?: string, model?: string) =>
  `${base}?${new URLSearchParams({ level, ...(provider ? { provider } : {}), ...(model ? { model } : {}) }).toString()}`;

/**
 * A full-page settings area in three levels for the UI catalog: areas,
 * providers with their models, and one model. The URL holds the selection,
 * and the column widths go to a cookie that the server reads on the next
 * request, as Cloud does with its per-app workspace cookie.
 */
export default function WorkspaceLevelsDemo(props: {
  level: string;
  provider?: string;
  model?: string;
  layoutState: AppWorkspaceLayoutState | null;
}) {
  const provider = () => providers.find((candidate) => candidate.id === props.provider) ?? providers[0]!;
  const model = () => provider().models.find((candidate) => candidate.id === props.model);
  const level = () => (props.level === "model" && !model() ? "providers" : props.level);
  return (
    <div class="k2b-ui ui-workspace-levels-demo-page" style={appWorkspaceLayoutStyle(props.layoutState)}>
      <AppWorkspace.LayoutStateProvider state={props.layoutState}>
        <AppWorkspace
          flat
          mobileSurface="flush"
          class="ui-workspace-levels-demo"
          onLayoutChange={(state) => {
            document.cookie = `ui_demo_workspace_levels=${serializeAppWorkspaceLayoutState(state)}; Path=${base}; Max-Age=31536000; SameSite=Lax`;
          }}
        >
          <AppWorkspace.Sidebar label="Administration">
            <AppWorkspace.SidebarDesktop>
              <AppWorkspace.SidebarBody>
                <AppWorkspace.SidebarSection title="Administration">
                  <AppWorkspace.SidebarItem href={href("areas")} icon="ti ti-sparkles" active>
                    AI
                  </AppWorkspace.SidebarItem>
                  <AppWorkspace.SidebarItem href={href("areas")} icon="ti ti-mail">
                    Outgoing mail
                  </AppWorkspace.SidebarItem>
                  <AppWorkspace.SidebarItem href={href("areas")} icon="ti ti-shield">
                    Security
                  </AppWorkspace.SidebarItem>
                </AppWorkspace.SidebarSection>
              </AppWorkspace.SidebarBody>
            </AppWorkspace.SidebarDesktop>
          </AppWorkspace.Sidebar>
          <AppWorkspace.Content>
            <AppWorkspace.Main level={level()}>
              <AppWorkspace.MainPane
                id="areas"
                label="AI"
                description={`${providers.length} providers`}
                href={href("areas")}
                defaultSize={260}
                minSize={220}
                maxSize={400}
              >
                <AppWorkspace.SidebarSection title="Providers">
                  <For each={providers}>
                    {(candidate) => (
                      <AppWorkspace.SidebarItem
                        href={href("providers", candidate.id)}
                        icon="ti ti-plug-connected"
                        description={`${candidate.status} · ${candidate.models.length} models`}
                        active={level() !== "areas" && candidate.id === provider().id}
                      >
                        {candidate.name}
                      </AppWorkspace.SidebarItem>
                    )}
                  </For>
                </AppWorkspace.SidebarSection>
                <AppWorkspace.SidebarSection title="Settings">
                  <AppWorkspace.SidebarItem href={href("areas")} icon="ti ti-adjustments">
                    General
                  </AppWorkspace.SidebarItem>
                  <AppWorkspace.SidebarItem href={href("areas")} icon="ti ti-coins">
                    Budgets
                  </AppWorkspace.SidebarItem>
                </AppWorkspace.SidebarSection>
              </AppWorkspace.MainPane>
              <AppWorkspace.MainPane
                id="providers"
                label={level() === "areas" ? "Provider" : provider().name}
                description={level() === "areas" ? "None selected" : provider().kind}
                href={href("providers", provider().id)}
                actions={
                  <Show when={level() !== "areas"}>
                    <Button size="sm" variant="secondary">
                      Add models
                    </Button>
                  </Show>
                }
              >
                <Show
                  when={level() !== "areas"}
                  fallback={
                    <Placeholder
                      icon="ti ti-plug-connected"
                      title="No provider selected"
                      description="Choose a provider to see its models."
                    />
                  }
                >
                  <Show
                    when={provider().models.length}
                    fallback={
                      <Placeholder icon="ti ti-key" title="No models yet" description="Add an API key to load this provider's models." />
                    }
                  >
                    <AppWorkspace.SidebarSection title={`${provider().models.length} models`}>
                      <For each={provider().models}>
                        {(candidate) => (
                          <AppWorkspace.SidebarItem
                            href={href("model", provider().id, candidate.id)}
                            icon="ti ti-cube"
                            description={candidate.summary}
                            active={candidate.id === model()?.id && level() === "model"}
                          >
                            {candidate.name}
                          </AppWorkspace.SidebarItem>
                        )}
                      </For>
                    </AppWorkspace.SidebarSection>
                  </Show>
                </Show>
              </AppWorkspace.MainPane>
              <AppWorkspace.MainPane
                id="model"
                label={(level() === "model" && model()?.name) || "Model"}
                description={level() === "model" && model() ? provider().name : "None selected"}
                actions={
                  <Show when={level() === "model" && model()}>
                    <StatusBadge tone="ok" label="Active" variant="dot" />
                  </Show>
                }
              >
                <Show
                  when={level() === "model" && model()}
                  fallback={<Placeholder icon="ti ti-cube" title="No model selected" description="Choose a model to see its details." />}
                >
                  {(current) => (
                    <div class="ui-workspace-levels-demo-detail">
                      <DescriptionList
                        items={[
                          { term: "Provider", description: provider().name },
                          { term: "Use", description: current().summary },
                          { term: "Context window", description: current().context },
                          { term: "Available to", description: current().access },
                        ]}
                      />
                    </div>
                  )}
                </Show>
              </AppWorkspace.MainPane>
            </AppWorkspace.Main>
          </AppWorkspace.Content>
        </AppWorkspace>
      </AppWorkspace.LayoutStateProvider>
      <style>{`.ui-workspace-levels-demo-page{position:fixed;inset:0;background:var(--k2b-surface)}.ui-workspace-levels-demo{height:100%}.ui-workspace-levels-demo-detail{padding:0.25rem 1rem 1rem}.ui-workspace-levels-demo .k2b-app-workspace__level-body>.k2b-app-workspace__sidebar-section{padding-inline:0.5rem}`}</style>
    </div>
  );
}
