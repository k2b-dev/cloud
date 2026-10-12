import type { AppWorkspaceSidebarSwitcherProps, AppWorkspaceSwitcherOption } from "@k2b/ui";
import { useLocale } from "@k2b/ui";
import { type Accessor, createSignal } from "solid-js";
import { notebookWorkspaceMessages } from "../../messages";
import { listAccessibleNotebooks } from "./notebooks";
import type { Notebook } from "./types";

const iconClass = (icon: string | null) => (icon ? (icon.startsWith("ti ") ? icon : `ti ${icon}`) : "ti ti-notebook");

/**
 * The notebook's sidebar switcher for the workspace, Book view and the phone menu. The other notebooks load when a
 * pointer or the focus first reaches it, so the list is usually there when the panel opens.
 */
export function createNotebookSwitcher(
  notebook: Accessor<Pick<Notebook, "id" | "name" | "icon">>,
): Accessor<AppWorkspaceSidebarSwitcherProps> {
  const locale = useLocale();
  const t = () => notebookWorkspaceMessages.resolve([locale()]).t;
  const [options, setOptions] = createSignal<AppWorkspaceSwitcherOption[]>();
  const [failed, setFailed] = createSignal(false);
  let requested = false;
  const load = () => {
    if (requested) return;
    requested = true;
    setFailed(false);
    listAccessibleNotebooks(locale())
      .then((notebooks) =>
        setOptions(
          notebooks.map((item) => ({ id: item.id, label: item.name, icon: iconClass(item.icon), href: `/app/notebooks/${item.id}` })),
        ),
      )
      .catch(() => {
        requested = false;
        setFailed(true);
      });
  };
  return () => ({
    currentId: notebook().id,
    label: notebook().name,
    icon: iconClass(notebook().icon),
    switchLabel: t().switchNotebook,
    options: options(),
    error: failed() ? t().failedLoadNotebooks : undefined,
    onLoad: load,
    actions: [{ id: "all", label: t().allNotebooks, icon: "ti ti-layout-grid", href: "/app/notebooks" }],
  });
}
