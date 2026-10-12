import { AppWorkspace } from "@k2b/ui";
import type { Space } from "../../../../contracts";
import { createSpaceSwitcher } from "./space-switcher";

export default function SpaceSwitcher(props: { canCreate: boolean; space: Pick<Space, "id" | "name" | "color"> }) {
  const switcher = createSpaceSwitcher(() => props.space, props.canCreate);
  return <AppWorkspace.SidebarSwitcher {...switcher()} />;
}
