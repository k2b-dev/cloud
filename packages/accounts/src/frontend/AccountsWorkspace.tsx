import { AppWorkspace, ScrollArea } from "@k2b/ui";
import type { JSX } from "solid-js";
import AccountsNavSidebar, { type AccountsNavActiveKey } from "./AccountsNavSidebar";

type Props = {
  active: AccountsNavActiveKey;
  isAdmin: boolean;
  pendingRequests: number;
  scrollPreserveKey: string;
  children: JSX.Element;
};

export default function AccountsWorkspace(props: Props) {
  return (
    <AppWorkspace class="h-full">
      <AccountsNavSidebar active={props.active} isAdmin={props.isAdmin} pendingRequests={props.pendingRequests} />
      <AppWorkspace.Content>
        <AppWorkspace.Main class="p-[var(--ui-space-shell)]">
          <ScrollArea class="flex-1" scrollPreserveKey={props.scrollPreserveKey}>
            {props.children}
          </ScrollArea>
        </AppWorkspace.Main>
      </AppWorkspace.Content>
    </AppWorkspace>
  );
}
