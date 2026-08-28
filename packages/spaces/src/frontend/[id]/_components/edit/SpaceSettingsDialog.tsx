import { query } from "@k2b/stdlib/solid";
import { Button, IconButton, Placeholder, Tooltip } from "@k2b/ui";
import { Show } from "solid-js";
import { apiClient } from "@/api/client";
import type { SpaceSettingsContext } from "@/settings-context";
import { useSpaceMessages } from "../../messages";
import SpaceEditPanel from "./SpaceEditPanel";
import { readErrorMessage } from "./utils";

type Props = {
  spaceId: string;
  baseUrl: string;
  close: () => void;
  onWorkspaceChange: () => void;
};

const settingsDialogFrameClass = "flex h-[86vh] min-h-0 flex-col overflow-hidden";

export default function SpaceSettingsDialog(props: Props) {
  const m = useSpaceMessages();
  const settings = query.create<string, SpaceSettingsContext>({
    source: () => props.spaceId,
    load: async (spaceId, context) => {
      const response = await apiClient[":id"]["settings-context"].$get(
        { param: { id: spaceId } },
        { init: { signal: context.abortSignal } },
      );
      if (!response.ok) throw new Error(await readErrorMessage(response, m.loadSpaceSettingsFailed));
      return response.json();
    },
  });

  return (
    <Show
      when={settings.data()}
      fallback={
        <div class={`paper relative ${settingsDialogFrameClass} rounded-[var(--ui-radius-frame)] [box-shadow:var(--ui-shadow-float)]`}>
          <Tooltip.Anchor content={m.closeSettings} class="absolute right-4 top-4 z-10">
            <IconButton label={m.closeSettings} onClick={props.close}>
              <i class="ti ti-x" />
            </IconButton>
          </Tooltip.Anchor>
          <Show
            when={settings.error()}
            fallback={<Placeholder state="loading" variant="panel" title={m.loadingSpaceSettings} class="flex-1" />}
          >
            {(error) => (
              <Placeholder
                state="error"
                variant="panel"
                title={m.spaceSettingsUnavailable}
                description={error().message}
                class="flex-1"
                action={
                  <Button type="button" variant="secondary" size="sm" disabled={settings.loading()} onClick={() => void settings.refresh()}>
                    <i class={settings.loading() ? "ti ti-loader-2 animate-spin" : "ti ti-refresh"} />
                    {m.retry}
                  </Button>
                }
              />
            )}
          </Show>
        </div>
      }
    >
      {(context) => (
        <div class={settingsDialogFrameClass}>
          <SpaceEditPanel
            space={context().space}
            baseUrl={props.baseUrl}
            initialSettings={context().settings}
            accessEntries={context().accessEntries}
            apiKeys={context().apiKeys}
            wormholes={context().wormholes}
            isAdmin={context().permission === "admin"}
            canWrite={context().permission === "write" || context().permission === "admin"}
            onWorkspaceChange={props.onWorkspaceChange}
            onSettingsChange={() =>
              settings.invalidate().catch(() => {
                throw new Error(m.settingsRefreshFailed);
              })
            }
            onClose={props.close}
          />
        </div>
      )}
    </Show>
  );
}
