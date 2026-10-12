import type { AppWorkspaceSidebarSwitcherProps, AppWorkspaceSwitcherOption } from "@k2b/ui";
import { type Accessor, createSignal } from "solid-js";
import { apiClient } from "../../../../api/client";
import type { Space } from "../../../../contracts";
import { useSpaceMessages } from "../../messages";

/** The space's sidebar switcher for the sidebar and the phone menu; the other spaces load when it is first reached. */
export function createSpaceSwitcher(space: Accessor<Pick<Space, "id" | "name" | "color">>): Accessor<AppWorkspaceSidebarSwitcherProps> {
  const t = useSpaceMessages();
  const [options, setOptions] = createSignal<AppWorkspaceSwitcherOption[]>();
  const [failed, setFailed] = createSignal(false);
  let requested = false;
  const load = async () => {
    if (requested) return;
    requested = true;
    setFailed(false);
    try {
      const response = await apiClient.index.$get();
      if (!response.ok) throw new Error();
      const items = await response.json();
      if (!Array.isArray(items)) throw new Error();
      setOptions(
        items.map((item) => ({
          id: item.id,
          label: item.name,
          icon: "ti ti-layout-kanban",
          color: item.color,
          href: `/app/spaces/${item.id}`,
        })),
      );
    } catch {
      requested = false;
      setFailed(true);
    }
  };
  return () => ({
    currentId: space().id,
    label: space().name,
    icon: "ti ti-layout-kanban",
    color: space().color,
    switchLabel: t.switchSpace,
    options: options(),
    error: failed() ? t.failedLoadSpaces : undefined,
    onLoad: () => void load(),
    actions: [{ id: "all", label: t.allSpaces, icon: "ti ti-layout-grid", href: "/app/spaces" }],
  });
}
