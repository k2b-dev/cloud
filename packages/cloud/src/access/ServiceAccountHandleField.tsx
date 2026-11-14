import { Button, StatusBadge, TextInput, useLocale } from "@k2b/ui";
import { createSignal, onCleanup, Show } from "solid-js";
import { CODE_ACCOUNT_HANDLE_PATTERN } from "../contracts/shared";
import { accessDialogMessages } from "./access-dialog-messages";
import { accessMessages } from "./messages";
import PrincipalAvatar from "./PrincipalAvatar";
import type { FoundServiceAccount } from "./PrincipalPicker";

/**
 * The open field of "Add service account", the same in the access dialog and in every editor that adds by handle:
 * a complete handle is looked up as it is typed or pasted, and the hit below the field adds the account.
 */
export function ServiceAccountHandleField(props: {
  find: (handle: string, signal: AbortSignal) => Promise<FoundServiceAccount | null>;
  /** Adds the hit; the caller closes the field. A rejected promise keeps the hit and says the lookup failed. */
  add: (account: FoundServiceAccount) => void | Promise<unknown>;
  cancel: () => void;
  /** Holds the field, the hit and Cancel while a change saves, so a second handle never replaces the first. */
  disabled?: boolean;
}) {
  const locale = useLocale();
  const t = () => accessDialogMessages.resolve([locale()]).t;
  const access = () => accessMessages.resolve([locale()]).t;
  const [handle, setHandle] = createSignal("");
  const [lookup, setLookup] = createSignal<"idle" | "searching" | "none" | "failed">("idle");
  const [found, setFound] = createSignal<FoundServiceAccount | null>(null);
  let area: HTMLDivElement | undefined;
  let request: AbortController | undefined;
  let disposed = false;
  onCleanup(() => {
    disposed = true;
    request?.abort();
  });
  const findAccount = async (value: string) => {
    const controller = new AbortController();
    request = controller;
    setLookup("searching");
    try {
      const result = await props.find(value, controller.signal);
      if (controller.signal.aborted || disposed) return;
      setFound(result);
      setLookup(result ? "idle" : "none");
      // The hit appears below the field; a sheet keeps both in view.
      queueMicrotask(() => area?.scrollIntoView?.({ block: "nearest" }));
    } catch {
      if (!controller.signal.aborted && !disposed) setLookup("failed");
    }
  };
  const changeHandle = (value: string) => {
    // A changed handle ends the lookup for the old one, so its answer never appears.
    request?.abort();
    setHandle(value);
    setFound(null);
    if (CODE_ACCOUNT_HANDLE_PATTERN.test(value.trim())) void findAccount(value.trim());
    else setLookup("idle");
  };
  const add = (account: FoundServiceAccount) => {
    if (props.disabled) return;
    const focused = document.activeElement instanceof HTMLElement && area?.contains(document.activeElement) ? document.activeElement : null;
    void Promise.resolve(props.add(account))
      .catch(() => {
        if (!disposed) setLookup("failed");
      })
      .finally(() => {
        // Saving disabled the focused control. When the field stays open, focus returns there unless the person moved on.
        if (disposed || !focused) return;
        queueMicrotask(() => {
          if (!disposed && (document.activeElement === null || document.activeElement === document.body)) focused.focus();
        });
      });
  };
  return (
    <div ref={area} class="flex flex-col gap-2">
      <form
        class="flex items-center gap-2 [&>*:first-child]:min-w-0 [&>*:first-child]:flex-1"
        onSubmit={(event) => {
          event.preventDefault();
          if (props.disabled) return;
          const account = found();
          const value = handle().trim();
          if (account) add(account);
          else if (lookup() === "searching") return;
          // Enter asks again for a complete handle, so a failed lookup can be retried.
          else if (CODE_ACCOUNT_HANDLE_PATTERN.test(value)) void findAccount(value);
          else setLookup("none");
        }}
      >
        <TextInput
          icon="ti ti-code"
          aria-label={t().serviceAccountHandle}
          placeholder={t().serviceAccountHandlePlaceholder}
          value={handle}
          onValueChange={changeHandle}
          disabled={props.disabled}
          autofocus
        />
        <Button variant="text" size="sm" disabled={props.disabled} onClick={() => props.cancel()}>
          {t().cancel}
        </Button>
      </form>
      <Show when={found()}>
        {(account) => (
          <button
            type="button"
            class="flex w-full items-center gap-3 rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-subtle)] p-2 text-left hover:bg-[var(--ui-surface-muted)]"
            disabled={props.disabled}
            onClick={() => add(account())}
          >
            <PrincipalAvatar
              entry={{
                principal: account().principal,
                avatarHash: account().display.avatarHash,
                serviceAccountKind: account().display.serviceAccountKind,
              }}
              label={account().display.displayName}
            />
            <span class="min-w-0 flex-[1_1_10rem]">
              {/* A long title wraps on a phone instead of pushing the mark out of the sheet. */}
              <span class="block min-w-0 break-words max-sm:text-sm sm:text-[15px] font-medium text-primary">
                {account().display.displayName}
              </span>
              <span class="block break-words text-[13px] text-dimmed">{account().description || t().serviceAccount}</span>
            </span>
            <StatusBadge class="shrink-0" tone="neutral" icon={null} label={access().codeServiceAccount} />
          </button>
        )}
      </Show>
      <Show when={lookup() !== "idle"}>
        <p class="text-[13px] text-dimmed" role="status">
          {lookup() === "searching"
            ? t().serviceAccountSearching
            : lookup() === "none"
              ? t().serviceAccountNotFound
              : t().serviceAccountLookupFailed}
        </p>
      </Show>
    </div>
  );
}
