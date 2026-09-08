import { ButtonLink } from "@k2b/ui";
import { SearchBar } from "@valentinkolb/cloud/ssr/islands";
import type { JSX } from "solid-js/jsx-runtime";
import { useAccountsMessages } from "../../messages";

type Props = {
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
        <SearchBar />
      </div>
      {props.indirectToggleUrl && (
        <ButtonLink
          href={props.indirectToggleUrl}
          size="sm"
          variant={props.indirect ? "secondary" : "subtle"}
          class="shrink-0 self-stretch"
          title={props.indirect ? messages().showDirectMembers : messages().showAllMembers}
          aria-current={props.indirect ? "true" : undefined}
        >
          <i class="ti ti-hierarchy text-sm" />
          {props.indirect ? messages().allMembers : messages().directOnly}
        </ButtonLink>
      )}
      {props.serviceAccountsToggleUrl && (
        <ButtonLink
          href={props.serviceAccountsToggleUrl}
          size="sm"
          variant={props.showServiceAccounts ? "primary" : "subtle"}
          class="shrink-0 self-stretch"
          title={props.showServiceAccounts ? messages().hideServiceAccounts : messages().showServiceAccounts}
          aria-current={props.showServiceAccounts ? "true" : undefined}
        >
          <i class="ti ti-user-key text-sm" />
          Service accounts
        </ButtonLink>
      )}
      {props.actions}
    </div>
  );
}
