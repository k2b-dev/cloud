import type { DateContext } from "@k2b/stdlib";
import { IconButton, useLocale } from "@k2b/ui";
import { notebookWorkspaceMessages } from "../../messages";
import type { Notebook, NoteTreeNode } from "../sidebar/types";
import { openNotebookSettingsDialog } from "./NotebookSettingsPanel";

type Props = {
  notebook: Notebook;
  tree: NoteTreeNode[];
  permission: string;
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
    <IconButton label={t().notebookSettings} tooltip={t().settings} onClick={() => void open()}>
      <i class="ti ti-settings" />
    </IconButton>
  );
}
