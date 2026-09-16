import { AppWorkspace, SpotlightButton, type SpotlightButtonVariant, Tooltip, useLocale } from "@k2b/ui";
import { notebookWorkspaceMessages } from "../../messages";
import { openNoteSearchPrompt } from "./openNoteSearchPrompt";

type Props = {
  notebookId: string;
  notebookName: string;
  variant?: SpotlightButtonVariant | "workspace-icon" | "workspace-sidebar";
  viewTransitionName?: string;
};

export default function SearchButton(props: Props) {
  const locale = useLocale();
  const t = () => notebookWorkspaceMessages.resolve([locale()]).t;
  const handleSearch = () => openNoteSearchPrompt(props.notebookId, props.notebookName);

  if (props.variant === "workspace-icon") {
    return (
      <Tooltip.Anchor content={t().searchNotes} class="w-full">
        <AppWorkspace.SidebarIconAction
          icon="ti ti-search"
          label={t().searchNotes}
          onClick={() => void handleSearch()}
          viewTransitionName={props.viewTransitionName}
        />
      </Tooltip.Anchor>
    );
  }

  if (props.variant === "workspace-sidebar") {
    return (
      <AppWorkspace.SidebarItem icon="ti ti-search" onClick={() => void handleSearch()} viewTransitionName={props.viewTransitionName}>
        {t().searchNotes}
      </AppWorkspace.SidebarItem>
    );
  }

  return (
    <Tooltip.Anchor content={t().searchNotes}>
      <SpotlightButton variant={props.variant} onClick={handleSearch} title="" ariaLabel={t().searchNotes} />
    </Tooltip.Anchor>
  );
}
