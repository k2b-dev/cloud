import type { AiProject } from "@k2b/cloud/ai";
import { BottomSheet, bottomSheetOptions, dialogCore } from "@k2b/ui";
import type { JSX } from "solid-js";
import { AssistantChatContextBox, type ContextBoxActions } from "./AssistantChatContextBox";
import type { ChatSidebarState } from "./AssistantChatSidebar";

/**
 * The box as a sheet from below on phones. Its Back entry closes it; an action that leaves the sheet (open, jump) runs
 * only after the sheet and its history entry are gone, so the action's own history entry follows it. While the sheet is
 * open it keeps what the person reads, like the island under the pointer.
 */
export const openAssistantContextBoxSheet = async (props: {
  state: ChatSidebarState;
  actions: ContextBoxActions;
  project?: AiProject | null;
  wrap?: (children: () => JSX.Element) => JSX.Element;
}) => {
  let after: (() => void) | undefined;
  await dialogCore.open<void>(
    (close, context) => {
      const leave =
        <A extends unknown[]>(run: (...args: A) => void) =>
        (...args: A) => {
          after = () => run(...args);
          close();
        };
      const actions: ContextBoxActions = {
        onOpen: leave(props.actions.onOpen),
        onJump: leave(props.actions.onJump),
        onOpenAll: leave(props.actions.onOpenAll),
        onOpenSources: leave(props.actions.onOpenSources),
        onOpenContext: leave(props.actions.onOpenContext),
      };
      const dismiss = () => void context.requestDismiss();
      const content = () => (
        // As high as the box (at most ten rows), over the chat without dimming it (concept v12, picture 66).
        <BottomSheet onDismiss={dismiss}>
          <BottomSheet.Body>
            {/* The box brings its own head with "New · n" and "Open as tab"; the handle closes the sheet. */}
            <div class="assistant-context-sheet">
              <AssistantChatContextBox
                state={props.state}
                actions={actions}
                project={props.project}
                frozen={() => true}
                variant="sheet"
                headingId="assistant-context-sheet-title"
              />
            </div>
          </BottomSheet.Body>
        </BottomSheet>
      );
      return props.wrap ? props.wrap(content) : content();
    },
    { ...bottomSheetOptions, history: true },
  );
  after?.();
};
