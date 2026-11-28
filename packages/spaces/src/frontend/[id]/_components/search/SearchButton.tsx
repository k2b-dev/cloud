import { openGlobalSearch } from "@k2b/cloud/browser/search";

/** Opens Cloud's search scoped to one Space, as the Space menu and its command do. */
export function createSpaceSearch(props: { spaceId: string; spaceName: string }) {
  return () =>
    openGlobalSearch({
      scope: { ref: { type: "spaces.space", id: props.spaceId }, label: props.spaceName, icon: "ti ti-layout-kanban" },
    });
}
