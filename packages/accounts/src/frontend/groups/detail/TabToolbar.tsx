import { SearchBar } from "@k2b/cloud/ssr/islands";
import { FilterToggle } from "@k2b/ui";
import type { JSX } from "solid-js/jsx-runtime";
import { useAccountsMessages } from "../../messages";

type Props = {
  searchAction: string;
  /** URL to toggle indirect/recursive mode (omit to hide the button) */
  indirectToggleUrl?: string;
  /** Whether indirect mode is currently active */
  indirect?: boolean;
  /** URL to toggle service-account memberships (omit to hide the button) */
  serviceAccountsToggleUrl?: string;
  /** Whether service-account memberships are currently visible */
  showServiceAccounts?: boolean;
  /** Slot for action buttons (e.g. AddMember) */
  actions?: JSX.Element;
};

/**
 * Shared toolbar for group detail tabs.
 * Renders: SearchBar + optional indirect toggle + optional action buttons.
 */
export default function TabToolbar(props: Props) {
  const messages = useAccountsMessages();
  return (
    <div class="flex flex-wrap gap-2 items-stretch">
      <div class="flex-1">
        <SearchBar action={props.searchAction} />
      </div>
      {props.indirectToggleUrl && (
        <FilterToggle
          href={props.indirectToggleUrl}
          icon="ti ti-hierarchy"
          active={Boolean(props.indirect)}
          class="shrink-0 self-stretch"
          title={props.indirect ? messages().showDirectMembers : messages().showAllMembers}
          label={props.indirect ? messages().allMembers : messages().directOnly}
        />
      )}
      {props.serviceAccountsToggleUrl && (
        <FilterToggle
          href={props.serviceAccountsToggleUrl}
          icon="ti ti-user-key"
          active={Boolean(props.showServiceAccounts)}
          class="shrink-0 self-stretch"
          title={props.showServiceAccounts ? messages().hideServiceAccounts : messages().showServiceAccounts}
          label={messages().serviceAccounts}
        />
      )}
      {props.actions}
    </div>
  );
}
