import { importOnDemand } from "@k2b/cloud/browser/reload";
import type { AppWorkspaceSidebarSwitcherProps, AppWorkspaceSwitcherOption } from "@k2b/ui";
import { useLocale } from "@k2b/ui";
import { type Accessor, createSignal, getOwner, runWithOwner } from "solid-js";
import { notebooksPageMessages } from "../../../messages";
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
  const owner = getOwner();
  let creation: ReturnType<typeof import("../../../create-notebook-dialog").createNotebookCreation> | undefined;
  const create = async () => {
    if (!canCreate || creating()) return;
    setCreating(true);
    try {
      const dialog = await importOnDemand(() => import("../../../create-notebook-dialog"));
      if (!dialog) return;
      creation ??= runWithOwner(owner, () => dialog.createNotebookCreation(() => notebooksPageMessages.resolve([locale()]).t));
      await creation?.createBlank();
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
    actions: [
      ...(canCreate ? [{ id: "new", label: t().newNotebook, icon: "ti ti-plus", action: () => void create(), disabled: creating() }] : []),
      { id: "all", label: t().allNotebooks, icon: "ti ti-layout-grid", href: "/app/notebooks" },
    ],
  });
}
