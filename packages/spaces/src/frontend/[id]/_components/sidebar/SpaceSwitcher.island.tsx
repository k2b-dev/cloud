import { AppWorkspace } from "@k2b/ui";
import type { Space } from "../../../../contracts";
import { createSpaceSwitcher } from "./space-switcher";

export default function SpaceSwitcher(props: { space: Pick<Space, "id" | "name" | "color"> }) {
  const switcher = createSpaceSwitcher(() => props.space);
  return <AppWorkspace.SidebarSwitcher {...switcher()} />;
}
