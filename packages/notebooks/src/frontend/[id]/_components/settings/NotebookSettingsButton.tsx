import type { DateContext } from "@k2b/stdlib";
import { AppWorkspace, useLocale } from "@k2b/ui";
import type { Notebook, NoteTreeNode } from "../sidebar/types";
import { notebookWorkspaceMessages } from "../../messages";
import { openNotebookSettingsDialog } from "./NotebookSettingsPanel";

type Props = {
  notebook: Notebook;
  tree: NoteTreeNode[];
  permission: string;
  viewTransitionName?: string;
  dateConfig: DateContext;
};

export default function NotebookSettingsButton(props: Props) {
  const locale = useLocale();
  const t = () => notebookWorkspaceMessages.resolve([locale()]).t;
  const isAdmin = () => props.permission === "admin";
  const canWrite = () => props.permission === "write" || props.permission === "admin";

  const open = async () => {
    await openNotebookSettingsDialog({
      notebook: props.notebook,
      tree: props.tree,
      isAdmin: isAdmin(),
      canWrite: canWrite(),
      dateConfig: props.dateConfig,
    });
  };

  return (
    <AppWorkspace.SidebarItem
      icon="ti ti-settings"
      onClick={() => void open()}
      title={t().settings}
      viewTransitionName={props.viewTransitionName}
    >
      {t().settings}
    </AppWorkspace.SidebarItem>
  );
}
