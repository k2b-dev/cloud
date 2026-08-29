import { FileBrowserPanel, IconButton, prompts, Tooltip, useLocale } from "@k2b/ui";
import { conversationFileSource } from "@valentinkolb/cloud/ai/solid";
import { type Accessor, onCleanup } from "solid-js";
import { type AssistantLiveHub, AssistantLiveProvider, matchesAssistantInvalidation } from "./assistant-live";
import { assistantMessages } from "./messages";

type AssistantFilesDialogProps = {
  conversationId: string;
  initialPath?: string;
  refreshKey: Accessor<string>;
  live: AssistantLiveHub;
  close: () => void;
};

function AssistantFilesDialog(props: AssistantFilesDialogProps) {
  const locale = useLocale();
  const t = () => assistantMessages.resolve([locale()]).t;
  const source = conversationFileSource("/api/ai", props.conversationId);
  let refreshVisible = async (): Promise<void> => undefined;
  const unregister = props.live.register({
    matches: matchesAssistantInvalidation(["conversation-files"], { conversationId: props.conversationId }),
    invalidate: () => refreshVisible(),
  });
  onCleanup(unregister);

  return (
    <div class="dialog-fixed-frame relative flex min-h-0 flex-col overflow-hidden rounded-[var(--ui-radius-frame)] bg-[var(--k2b-surface)] [box-shadow:var(--ui-shadow-float)]">
      <Tooltip.Anchor content={t().closeFiles} class="absolute right-3 top-3 z-20">
        <IconButton label={t().closeFiles} onClick={props.close}>
          <i class="ti ti-x" aria-hidden="true" />
        </IconButton>
      </Tooltip.Anchor>
      <FileBrowserPanel
        source={source}
        readOnly
        refreshKey={props.refreshKey()}
        registerRefresh={(refresh) => {
          refreshVisible = refresh;
          return () => {
            refreshVisible = async () => undefined;
          };
        }}
        initialPath={props.initialPath === "/" ? undefined : props.initialPath}
        class="min-h-0 flex-1 p-4 pr-14"
      />
    </div>
  );
}

export const openAssistantFilesDialog = (options: {
  conversationId: string;
  initialPath?: string;
  refreshKey: Accessor<string>;
  live: AssistantLiveHub;
}): Promise<void> =>
  prompts.dialog<void>(
    (close) => (
      <AssistantLiveProvider value={options.live}>
        <AssistantFilesDialog {...options} close={() => close()} />
      </AssistantLiveProvider>
    ),
    { surface: "bare", header: false, size: "wide" },
  );
