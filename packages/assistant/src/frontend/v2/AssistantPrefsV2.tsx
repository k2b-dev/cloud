import { confirmDiscardIfDirty, useLocale } from "@k2b/ui";
import { Canvas, Failed, Loading, Pane, Tabs } from "@k2b/ui/v2";
import { createResource, createSignal, Match, Show, Switch } from "solid-js";
import { assistantApi } from "../../api/client";
import {
  ApiAccessPanel,
  ApprovalPreferences,
  type AssistantPrefsSeed,
  ChatSettings,
  loadOpenAiApiAccess,
  MemorySettings,
  SystemPromptPanel,
} from "../AssistantPrefsModals";
import { AssistantSkillEditor, type AssistantSkillEditorRequest, AssistantSkillsSettings } from "../AssistantSkillsSettings";
import { type AssistantPrefsTab, assistantPrefsHref } from "../assistant-navigation";
import { assistantMessages } from "../messages";
import { useAssistantText } from "../ui-copy";

/**
 * Gustav's settings as a page of v2 (screen brief 3, recipe "settings"): its tabs in the pane's head, each tab's
 * content below. The address names the tab (`?prefs=<tab>`), so reload and Back keep it. Unsaved personalization asks
 * before another tab opens, as the dialog asked before it closed.
 */
export default function AssistantPrefsV2(props: {
  basePath: string;
  tab: AssistantPrefsTab;
  onTab: (tab: AssistantPrefsTab) => void;
  /** The settings the server read for this page, so its first picture shows them; without them the page reads them. */
  initial?: AssistantPrefsSeed | null;
}) {
  const text = useAssistantText();
  const locale = useLocale();
  // Each read is one number: 0 while the server's settings stand, so the page reads nothing on its first picture.
  const [reads, setReads] = createSignal(props.initial ? 0 : 1);
  const [read] = createResource(reads, async (): Promise<AssistantPrefsSeed> => {
    // The optional tab is known before the tabs show, so the list never shifts; a failed lookup only hides it.
    const [prefs, access] = await Promise.all([assistantApi.getPrefs(), loadOpenAiApiAccess().catch(() => null)]);
    return { prefs, access };
  });
  const data = () => (reads() === 0 ? (props.initial ?? undefined) : read());
  const refetch = () => setReads((count) => count + 1);
  const [dirty, setDirty] = createSignal(false);
  const [suggest, setSuggest] = createSignal<boolean>();
  const [skillEditor, setSkillEditor] = createSignal<AssistantSkillEditorRequest>();
  const [skillsRefresh, setSkillsRefresh] = createSignal(0);
  const choose = async (tab: AssistantPrefsTab) => {
    if (tab === props.tab) return;
    if (!(await confirmDiscardIfDirty(dirty))) return;
    setSkillEditor(undefined);
    props.onTab(tab);
  };
  const tabs = (): { id: AssistantPrefsTab; label: string; icon: string }[] => [
    { id: "personalization", label: text("Personalization"), icon: "user-cog" },
    { id: "chat", label: text("Chat"), icon: "message-circle" },
    { id: "skills", label: text("Skills"), icon: "sparkles" },
    { id: "system-prompt", label: text("System prompt"), icon: "code" },
    { id: "approvals", label: text("Approvals"), icon: "shield-check" },
    ...(data()?.access ? [{ id: "api-access" as const, label: text("API access"), icon: "api" }] : []),
  ];

  return (
    <Pane
      // The name the sidebar and the path give it, also while its code loads.
      label={assistantMessages.resolve([locale()]).t.personalize}
      head={
        <Tabs
          label={text("Gustav settings")}
          items={tabs().map((entry) => ({
            label: entry.label,
            icon: entry.icon,
            current: entry.id === props.tab,
            href: assistantPrefsHref(props.basePath, entry.id),
            // The link took the click; the workspace moves the address, after the question about unsaved changes.
            onNavigate: () => void choose(entry.id),
          }))}
        />
      }
    >
      <Show when={!read.loading} fallback={<Loading rows={4} lines={2} />}>
        <Show when={data()} fallback={<Failed text={text("Failed to load AI preferences")} onRetry={() => void refetch()} />}>
          {(loaded) => (
            // k2b-ui gap: #4405: the settings' fields (label-left rows, switches, the personalization list, the Skill editor)
            // are v1's shared settings parts; they draw themselves here until v2 has its settings fields (recipe
            // "settings"), which the styling round brings.
            <Canvas label={tabs().find((entry) => entry.id === props.tab)?.label ?? text("Gustav settings")}>
              <div class="assistant-prefs-v2">
                <Switch>
                  <Match when={props.tab === "personalization"}>
                    <MemorySettings
                      prefs={loaded().prefs}
                      onDirtyChange={setDirty}
                      // In the flow at the end of the tab; it moves to the pane's foot (sticky while there are changes)
                      // with G's Pane foot (#4334).
                      placeFooter={(footer) => <div class="assistant-prefs-v2__foot">{footer}</div>}
                    />
                  </Match>
                  <Match when={props.tab === "chat"}>
                    <ChatSettings suggest={suggest() ?? loaded().prefs.suggestNextMessage} onSuggestChange={setSuggest} />
                  </Match>
                  <Match when={props.tab === "skills"}>
                    <Show
                      when={skillEditor()}
                      fallback={<AssistantSkillsSettings refreshKey={skillsRefresh()} onOpenEditor={setSkillEditor} />}
                    >
                      {(request) => (
                        <AssistantSkillEditor
                          request={request()}
                          onBack={(changed) => {
                            setSkillEditor(undefined);
                            if (changed) setSkillsRefresh((value) => value + 1);
                          }}
                          onClose={() => setSkillEditor(undefined)}
                        />
                      )}
                    </Show>
                  </Match>
                  <Match when={props.tab === "system-prompt"}>
                    <SystemPromptPanel />
                  </Match>
                  <Match when={props.tab === "approvals"}>
                    <ApprovalPreferences />
                  </Match>
                  <Match when={props.tab === "api-access" && loaded().access}>{(access) => <ApiAccessPanel access={access()} />}</Match>
                </Switch>
              </div>
            </Canvas>
          )}
        </Show>
      </Show>
    </Pane>
  );
}
