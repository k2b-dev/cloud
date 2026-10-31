import { Dropdown, type DropdownAction, useLocale } from "@k2b/ui";
import { appsHref } from "./model";
import { appsPageMessages } from "./page-messages";
import { openRemoveDialog } from "./remove-dialog";

/**
 * The row menu of the app list. "Remove from list" is offered only for an app that is not running; for a running app
 * the entry stays visible but disabled and says why, so the way out never disappears silently.
 */
export default function AppRowMenu(props: {
  app: { id: string; name: string };
  adminHref: string | null;
  logsHref: string | null;
  removable: boolean;
  neverStarted: boolean;
}) {
  const locale = useLocale();
  const t = () => appsPageMessages.resolve([locale()]).t;
  const items = (): DropdownAction[] => [
    { icon: "ti ti-arrow-right", label: t().open, href: appsHref({ app: props.app.id }) },
    ...(props.adminHref ? [{ icon: "ti ti-arrow-up-right", label: t().adminOf({ name: props.app.name }), href: props.adminHref }] : []),
    ...(props.logsHref ? [{ icon: "ti ti-list-details", label: t().logs, href: props.logsHref }] : []),
    props.removable && !props.neverStarted
      ? { icon: "ti ti-trash", label: t().remove, variant: "danger" as const, action: () => void openRemoveDialog(props.app, locale()) }
      : {
          icon: "ti ti-trash",
          label: t().removeOff,
          description: props.neverStarted ? t().removeOffNever : t().removeOnlyStopped,
          disabled: true as const,
        },
  ];
  return (
    <Dropdown.Root items={items()} position="bottom-right" label={t().actionsFor({ name: props.app.name })} phone="sheet" lazy>
      <Dropdown.Trigger iconOnly label={t().actionsFor({ name: props.app.name })} size="xs" variant="ghost">
        <i class="ti ti-dots" aria-hidden="true" />
      </Dropdown.Trigger>
    </Dropdown.Root>
  );
}
