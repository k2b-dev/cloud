import { Button, TextInput, useLocale } from "@k2b/ui";
import { createEffect, createSignal, on, onCleanup, Show } from "solid-js";
import type { CloudResourceRef } from "../contracts/capabilities";
import { accessDialogMessages } from "./access-dialog-messages";
import type { FoundServiceAccount } from "./PrincipalPicker";
import { findTargetServiceAccount } from "./service-account-lookup";

/** The inline editor uses the same targeted lookup as the staged access dialog. */
export function ServiceAccountLookup(props: {
  target: CloudResourceRef;
  disabled: boolean;
  empty: boolean;
  add: (account: FoundServiceAccount) => Promise<boolean>;
}) {
  const locale = useLocale();
  const t = () => accessDialogMessages.resolve([locale()]).t;
  const [open, setOpen] = createSignal(false);
  const [handle, setHandle] = createSignal("");
  const [found, setFound] = createSignal<FoundServiceAccount | null>(null);
  const [state, setState] = createSignal<"idle" | "searching" | "none" | "failed">("idle");
  let request: AbortController | undefined;
  onCleanup(() => request?.abort());
  const reset = () => {
    request?.abort();
    setFound(null);
    setState("idle");
  };
  createEffect(on(() => `${props.target.type}:${props.target.id}`, reset, { defer: true }));
  const search = async () => {
    if (props.disabled) return;
    reset();
    const controller = new AbortController();
    request = controller;
    setState("searching");
    try {
      const account = await findTargetServiceAccount(props.target, handle(), controller.signal);
      if (controller.signal.aborted) return;
      setFound(account);
      setState(account ? "idle" : "none");
    } catch {
      if (!controller.signal.aborted) setState("failed");
    }
  };
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
        <form
          class="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void search();
          }}
        >
          <TextInput
            class="min-w-0 flex-1"
            aria-label={t().serviceAccountHandle}
            placeholder={t().serviceAccountHandlePlaceholder}
            value={handle}
            disabled={props.disabled}
            onValueChange={(value) => {
              reset();
              setHandle(value);
            }}
            autofocus
          />
          <Button
            type="submit"
            size="sm"
            variant="secondary"
            loading={state() === "searching"}
            disabled={props.disabled || !handle().trim()}
          >
            {t().serviceAccountFind}
          </Button>
          <Button
            size="sm"
            variant="text"
            disabled={props.disabled}
            onClick={() => {
              reset();
              setOpen(false);
            }}
          >
            {t().cancel}
          </Button>
        </form>
        <Show when={found()}>
          {(account) => (
            <div class="flex min-w-0 items-center gap-2">
              <span class="min-w-0 flex-1 break-words text-sm">{account().display.displayName}</span>
              <Button
                size="sm"
                disabled={props.disabled}
                onClick={() =>
                  void props
                    .add(account())
                    .then((saved) => {
                      if (saved) {
                        reset();
                        setHandle("");
                        setOpen(false);
                      }
                    })
                    .catch(() => setState("failed"))
                }
              >
                {t().add}
              </Button>
            </div>
          )}
        </Show>
        <Show when={state() === "none" || state() === "failed"}>
          <p role="status" class="text-[13px] text-dimmed">
            {state() === "none" ? t().serviceAccountNotFound : t().serviceAccountLookupFailed}
          </p>
        </Show>
      </Show>
    </section>
  );
}
