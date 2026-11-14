import { Button, useLocale } from "@k2b/ui";
import { createEffect, createSignal, on, Show } from "solid-js";
import type { CloudResourceRef } from "../contracts/capabilities";
import { accessDialogMessages } from "./access-dialog-messages";
import type { FoundServiceAccount } from "./PrincipalPicker";
import { ServiceAccountHandleField } from "./ServiceAccountHandleField";
import { findTargetServiceAccount } from "./service-account-lookup";

/** The inline editor adds by handle with the same field and targeted lookup as the staged access dialog. */
export function ServiceAccountLookup(props: {
  target: CloudResourceRef;
  disabled: boolean;
  empty: boolean;
  add: (account: FoundServiceAccount) => Promise<boolean>;
}) {
  const locale = useLocale();
  const t = () => accessDialogMessages.resolve([locale()]).t;
  const [open, setOpen] = createSignal(false);
  // Another target closes the field, so a hit for the old one is never added.
  createEffect(
    on(
      () => `${props.target.type}:${props.target.id}`,
      () => setOpen(false),
      { defer: true },
    ),
  );
  return (
    <section class="flex flex-col gap-2">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h3 class="text-sm font-semibold text-primary">{t().serviceAccounts}</h3>
        <Show when={!open()}>
          <Button size="sm" variant="secondary" disabled={props.disabled} onClick={() => setOpen(true)}>
            <i class="ti ti-plus" aria-hidden="true" />
            {t().addServiceAccount}
          </Button>
        </Show>
      </div>
      <Show
        when={open()}
        fallback={
          <Show when={props.empty}>
            <p class="text-[13px] text-dimmed">{t().serviceAccountsEmpty}</p>
          </Show>
        }
      >
        {/* A failed save keeps the handle and the hit, so the same click retries. */}
        <ServiceAccountHandleField
          find={(handle, signal) => findTargetServiceAccount(props.target, handle, signal)}
          add={(account) =>
            props.add(account).then((saved) => {
              if (saved) setOpen(false);
            })
          }
          cancel={() => setOpen(false)}
          disabled={props.disabled}
        />
      </Show>
    </section>
  );
}
