import { AppWorkspace, SPOTLIGHT_SHORTCUT_TITLE, SpotlightButton, type SpotlightButtonVariant, useLocale } from "@k2b/ui";
import { navigateToNotebookNote } from "../../../lib/soft-navigation";
import { buildNoteUrl } from "../../../params";
import { openNoteSearchPrompt } from "./openNoteSearchPrompt";
import { notebookWorkspaceMessages } from "../../messages";

type Props = {
  notebookId: string;
  notebookName: string;
  variant?: SpotlightButtonVariant | "workspace-icon" | "workspace-sidebar";
  viewTransitionName?: string;
};

export default function SearchButton(props: Props) {
  const locale = useLocale();
  const t = () => notebookWorkspaceMessages.resolve([locale()]).t;
  const handleSearch = async () => {
    const picked = await openNoteSearchPrompt(props.notebookId, props.notebookName, locale());
    if (picked) {
      void navigateToNotebookNote(buildNoteUrl(props.notebookId, picked.id));
    }
  };

  if (props.variant === "workspace-icon") {
    return (
      <AppWorkspace.SidebarIconAction
        icon="ti ti-search"
        label={`${t().searchNotes} (${SPOTLIGHT_SHORTCUT_TITLE})`}
        onClick={() => void handleSearch()}
        viewTransitionName={props.viewTransitionName}
      />
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
    <SpotlightButton
      variant={props.variant}
      onClick={handleSearch}
      title={`${t().searchNotes} (${SPOTLIGHT_SHORTCUT_TITLE})`}
      ariaLabel={t().searchNotes}
    />
  );
}
