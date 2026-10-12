import { type AppWorkspaceSidebarSwitcherProps, type AppWorkspaceSwitcherOption, useLocale } from "@k2b/ui";
import { type Accessor, createSignal } from "solid-js";
import { apiClient } from "../../../api/client";
import type { PublicBase } from "../../../api/public-dto";
import { workspaceMessages } from "./messages";

/** The base's sidebar switcher for the sidebar and the phone menu; the other bases load when it is first reached. */
export function createBaseSwitcher(base: Accessor<Pick<PublicBase, "id" | "name">>): Accessor<AppWorkspaceSidebarSwitcherProps> {
  const locale = useLocale();
  const t = () => workspaceMessages.resolve([locale()]).t;
  const [options, setOptions] = createSignal<AppWorkspaceSwitcherOption[]>();
  const [failed, setFailed] = createSignal(false);
  let requested = false;
  const load = async () => {
    if (requested) return;
    requested = true;
    setFailed(false);
    try {
      const items: AppWorkspaceSwitcherOption[] = [];
      // The endpoint's largest page; the first response's total bounds the pages, even if bases are added meanwhile.
      const limit = 500;
      let total = 1;
      for (let offset = 0; offset < total; offset += limit) {
        const response = await apiClient.bases.$get({ query: { limit: String(limit), offset: String(offset) } });
        if (!response.ok) throw new Error();
        const payload = await response.json();
        if (!("items" in payload)) throw new Error();
        if (offset === 0) total = payload.total;
        items.push(...payload.items.map((item) => ({ id: item.id, label: item.name, href: `/app/grids/${item.id}` })));
      }
      setOptions(items);
    } catch {
      requested = false;
      setFailed(true);
    }
  };
  return () => ({
    currentId: base().id,
    label: base().name,
    icon: "ti ti-table",
    switchLabel: t().switchBase,
    options: options(),
    error: failed() ? t().failedLoadBases : undefined,
    onLoad: () => void load(),
    actions: [{ id: "all", label: t().allGrids, icon: "ti ti-layout-grid", href: "/app/grids" }],
  });
}
