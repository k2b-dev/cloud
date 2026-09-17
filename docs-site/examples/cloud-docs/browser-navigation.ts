import { consumeCommandLink, openCommand, registerCommandHandler, registerContextAwareCommand } from "@k2b/cloud/browser/commands";
import { openGlobalSearch, registerSearchNavigation, type SearchNavigationTarget } from "@k2b/cloud/browser/search";
import { onCleanup, onMount } from "solid-js";
import { z } from "zod";

const ComposeInput = z.object({ spaceId: z.string().optional() }).strict();

// Call within the active island's Solid owner.
export function setupTaskNavigation(props: {
  currentSpaceId: () => string;
  openTaskForm: (input: z.infer<typeof ComposeInput>) => void;
  canOpenInCurrentView: (href: string) => boolean;
  openInCurrentView: (target: SearchNavigationTarget) => Promise<void>;
  searchLabel: string;
  searchDescription: string;
}) {
  onMount(() => {
    onCleanup(registerCommandHandler("spaces.task.compose", ComposeInput, props.openTaskForm,
      (input) => !input.spaceId || input.spaceId === props.currentSpaceId()));
    onCleanup(registerSearchNavigation(async (target) => {
      if (!props.canOpenInCurrentView(target.href)) return false;
      await props.openInCurrentView(target);
      return true;
    }));
    onCleanup(registerContextAwareCommand({
      id: "spaces.search",
      title: props.searchLabel,
      description: props.searchDescription,
      action: { search: { scope: { appId: "spaces", label: props.searchLabel } } },
    }));
    void consumeCommandLink();
  });
  return {
    compose: () => openCommand("spaces.task.compose", { spaceId: props.currentSpaceId() }),
    search: () => openGlobalSearch({ scope: { appId: "spaces", label: props.searchLabel } }),
  };
}
