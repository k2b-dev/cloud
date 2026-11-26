import { importOnDemand } from "@k2b/cloud/browser/reload";
import type { AppWorkspaceSidebarSwitcherProps, AppWorkspaceSwitcherOption } from "@k2b/ui";
import { useLocale } from "@k2b/ui";
import { type Accessor, createSignal, onCleanup } from "solid-js";
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
  canCreate: boolean,
): Accessor<AppWorkspaceSidebarSwitcherProps> {
  const locale = useLocale();
  const t = () => notebookWorkspaceMessages.resolve([locale()]).t;
  const [options, setOptions] = createSignal<AppWorkspaceSwitcherOption[]>();
  const [failed, setFailed] = createSignal(false);
  let requested = false;
  const [creating, setCreating] = createSignal(false);
  // the start page's dialog, blank or from a template: one way to make a notebook; it closes with this switcher
  const closing = new AbortController();
  onCleanup(() => closing.abort());
  const create = async (from: "blank" | "template") => {
    if (!canCreate || creating()) return;
    setCreating(true);
    try {
      const dialog = await importOnDemand(() => import("../../../create-notebook-dialog"));
      if (!dialog) return;
      await dialog.openNewNotebookDialog({ kind: from }, locale(), closing.signal);
    } finally {
      setCreating(false);
    }
  };
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
    // No way to an overview: Notebooks has none, `/app/notebooks` opens the notebook used last. The list above is
    // every notebook.
    actions: canCreate
      ? [
          { id: "new", label: t().newNotebook, icon: "ti ti-plus", action: () => void create("blank"), disabled: creating() },
          { id: "template", label: t().fromTemplate, icon: "ti ti-template", action: () => void create("template"), disabled: creating() },
        ]
      : [],
  });
}
