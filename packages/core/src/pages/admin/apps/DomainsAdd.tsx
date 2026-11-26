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
      disabled={domainsState.busy() !== null}
      onClick={() =>
        void openAddDomainDialog(props.app, domainsState.domains() ?? props.initial, locale(), (added) => {
          domainsState.setRevision((value) => value + 1);
          // A new domain's first check runs in the background: read the list once more after a few seconds.
          if (added) setTimeout(() => domainsState.setRevision((value) => value + 1), 6000);
        })
      }
    >
      <i class="ti ti-plus" aria-hidden="true" />
      {t().add}
    </Button>
  );
}
