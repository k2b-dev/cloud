import { AppWorkspace, Tooltip } from "@k2b/ui";

export default function SidebarTableMeta(props: { tableName: string }) {
  return (
    <AppWorkspace.SidebarItemMeta>
      <Tooltip.Anchor content={props.tableName}>
        <span class="block max-w-20 k2b-truncate-fade text-[9px] uppercase tracking-wider">{props.tableName}</span>
      </Tooltip.Anchor>
    </AppWorkspace.SidebarItemMeta>
  );
}
