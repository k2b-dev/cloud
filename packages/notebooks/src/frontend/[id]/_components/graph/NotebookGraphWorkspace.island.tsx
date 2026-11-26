import NotebookSidebarBody from "../sidebar/NotebookSidebarBody";
import { useNotebookSidebar } from "../sidebar/notebook-sidebar-state";
import type { NotebookContext } from "../sidebar/types";
import GraphFrame, { type GraphFrameProps } from "./GraphWorkspace";

/** The notebook's Links graph in the notebook's shell: its sidebar marks Links as the current page. */
export default function NotebookGraphWorkspace(
  props: Omit<GraphFrameProps, "shell"> & {
    ctx: NotebookContext;
    /** The page Links returns to from the sidebar's footer. */
    graphBack?: string;
  },
) {
  const sidebar = useNotebookSidebar({ ctx: props.ctx, current: "graph", graphBack: props.graphBack });
  return (
    <GraphFrame
      {...props}
      shell={{
        sidebar: <NotebookSidebarBody sidebar={sidebar} current="graph" />,
        navigation: sidebar.mobileNavigation,
        navigationLabel: props.ctx.notebook.name,
      }}
    />
  );
}
