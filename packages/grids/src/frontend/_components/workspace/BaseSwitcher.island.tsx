import { AppWorkspace } from "@k2b/ui";
import type { PublicBase } from "../../../api/public-dto";
import { createBaseSwitcher } from "./base-switcher";

export default function BaseSwitcher(props: { base: Pick<PublicBase, "id" | "name"> }) {
  const switcher = createBaseSwitcher(() => props.base);
  return <AppWorkspace.SidebarSwitcher {...switcher()} />;
}
