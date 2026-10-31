import { Button, useLocale } from "@k2b/ui";
import { openAddDomainDialog } from "./domains-dialogs";
import { domainsMessages } from "./domains-messages";
import type { AppDomainEntry } from "./domains-model";
import { domainsState } from "./domains-state";

/** "Add domain" in the head of the domains column; the column reads the list again after a domain was added. */
export default function DomainsAdd(props: { app: { id: string; name: string }; initial: AppDomainEntry[] }) {
  const locale = useLocale();
  const t = () => domainsMessages.resolve([locale()]).t;
  return (
    <Button
      size="sm"
      variant="secondary"
      onClick={() =>
        void openAddDomainDialog(props.app, domainsState.domains() ?? props.initial, locale(), () =>
          domainsState.setRevision((value) => value + 1),
        )
      }
    >
      <i class="ti ti-plus" aria-hidden="true" />
      {t().add}
    </Button>
  );
}
