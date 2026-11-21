import { Button, PanelDialog, useLocale } from "@k2b/ui";
import { createMemo, createSignal, type JSX, Show } from "solid-js";
import type { CloudResourceRef } from "../contracts/capabilities";
import { accessDialogMessages } from "./access-dialog-messages";
import type { FoundServiceAccount } from "./PrincipalPicker";
import { ServiceAccountHandleField } from "./ServiceAccountHandleField";
import { findTargetServiceAccount } from "./service-account-lookup";

/**
 * What a service account is, as the server describes it, and what it may: "Service account of a mailbox · may edit".
 * Read-only, the level stands there alone instead of beside the row.
 */
export const serviceAccountLine = (locale: string, account: { description?: string; level?: string; readOnly?: boolean }) => {
  const t = accessDialogMessages.resolve([locale]).t;
  const description = account.description || t.serviceAccount;
  if (!account.level) return description;
  return account.readOnly ? t.accountMayAlone({ level: account.level }) : `${description} · ${t.accountMay({ level: account.level })}`;
};

/**
 * The section "Service accounts" that every share editor has, as in the approved mockup: the title with its count,
 * "Add service account" beside it, the rows, the field for a handle, and one note under the rows or the empty text.
 * The caller renders its rows as `AccessRowFrame` list items, so they match the access dialog's.
 */
export function ServiceAccountSection(props: {
  /** The resource being shared; the platform looks a handle up against it, and Core rechecks Manage. */
  target?: CloudResourceRef;
  /** Overrides the targeted lookup, for example in an embedded test harness. */
  find?: (handle: string, signal: AbortSignal) => Promise<FoundServiceAccount | null>;
  /** The resource's name in the note under the rows. */
  resourceName: string;
  /** The rows that still have access. */
  count: number;
  /** Whether any row is listed, including one staged for removal. */
  hasRows: boolean;
  /** Read-only, the section shows only who is listed. */
  readOnly?: boolean;
  /** Holds the button and the field while a change saves. */
  disabled: boolean;
  /** Adds the hit. `false` or a rejection keeps the field open with its handle, so the same click retries. */
  add: (account: FoundServiceAccount) => void | boolean | Promise<boolean | undefined>;
  /** The rows, as list items. */
  children?: JSX.Element;
}) {
  const locale = useLocale();
  const t = () => accessDialogMessages.resolve([locale()]).t;
  const find = createMemo(() => {
    const target = props.target;
    return props.find ?? (target ? (handle: string, signal: AbortSignal) => findTargetServiceAccount(target, handle, signal) : undefined);
  });
  const canAdd = () => find() !== undefined && !props.readOnly;
  const [open, setOpen] = createSignal(false);
  let area: HTMLLIElement | undefined;
  const openField = () => {
    setOpen(true);
    // On a phone the sheet brings the field and its hit into view itself.
    queueMicrotask(() => area?.scrollIntoView?.({ block: "nearest" }));
  };
  const add = (account: FoundServiceAccount) => {
    const result = props.add(account);
    // A staged add closes at once; a saving one when it saved.
    if (result instanceof Promise)
      return result.then((saved) => {
        if (saved !== false) setOpen(false);
      });
    if (result !== false) setOpen(false);
  };
  return (
    <PanelDialog.Section
      title={
        <>
          {t().serviceAccounts} <span class="font-normal text-dimmed">{props.count}</span>
        </>
      }
      actions={
        // Beside the title at every width, as in the approved mockup; gone while the field is open.
        <Show when={canAdd() && !open()}>
          {/* The full label at every width, as in the approved mockup; it fits beside the title on a phone. */}
          <Button variant="secondary" size="sm" disabled={props.disabled} onClick={openField}>
            <i class="ti ti-plus" aria-hidden="true" />
            {t().addServiceAccount}
          </Button>
        </Show>
      }
    >
      {/* Only rows or the open field make a list, so nothing stands empty before the text below. */}
      <Show when={props.hasRows || open()}>
        <ul class="flex flex-col">
          {props.children}
          <Show when={open() && canAdd() && find()}>
            {(lookup) => (
              <li ref={area} class="py-2">
                <ServiceAccountHandleField find={lookup()} add={add} cancel={() => setOpen(false)} disabled={props.disabled} />
              </li>
            )}
          </Show>
        </ul>
      </Show>
      {/* As in the approved mockup: one note under the rows, or the empty text; neither while adding. */}
      <Show when={!open()}>
        <p class="text-[13px] text-dimmed">
          {props.hasRows ? t().serviceAccountNote({ name: props.resourceName }) : t().serviceAccountsEmpty}
        </p>
      </Show>
    </PanelDialog.Section>
  );
}
