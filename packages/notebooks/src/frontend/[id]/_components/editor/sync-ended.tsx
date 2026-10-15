import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { createLoginRedirectUrl } from "@k2b/cloud/shared";
import { refreshCurrentPath } from "@k2b/ssr/nav";
import { clipboard } from "@k2b/stdlib/browser";
import { Button, IconButton, InlineGuidance, prompts, toast, useLocale } from "@k2b/ui";
import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import type { YjsProviderError } from "../../../lib/yjs/provider";
import { notebookWorkspaceMessages } from "../../messages";

export type SyncEnded = { code: YjsProviderError["code"]; unsent: boolean };
export const signInCodes = new Set<YjsProviderError["code"]>(["SESSION_EXPIRED", "LOGIN_REQUIRED"]);

export function createSyncEnded(opts: {
  hasUnsentChanges: () => boolean;
  resume: () => void;
  focusEditor: () => void;
  messages: () => Pick<ReturnType<typeof notebookWorkspaceMessages.resolve>["t"], "leaveUnsavedConfirm" | "leaveNote">;
}) {
  const [ended, setEnded] = createSignal<SyncEnded | null>(null, {
    equals: (a, b) => a?.code === b?.code && a?.unsent === b?.unsent,
  });
  const [leaveConfirmed, setLeaveConfirmed] = createSignal(false);
  let pendingLeave: Promise<boolean> | undefined;
  const shouldConfirmLeave = () => !!ended()?.unsent && !leaveConfirmed();
  const allowLeave = () => {
    setLeaveConfirmed(true);
  };
  const confirmLeave = (): Promise<boolean> => {
    if (!shouldConfirmLeave()) return Promise.resolve(true);
    if (pendingLeave) return pendingLeave;
    const t = opts.messages();
    pendingLeave = prompts
      .confirm(t.leaveUnsavedConfirm, {
        title: t.leaveNote,
        icon: "ti ti-logout",
        variant: "danger",
        confirmText: t.leaveNote,
      })
      .then((leave) => {
        if (leave) allowLeave();
        return leave === true;
      })
      .finally(() => {
        pendingLeave = undefined;
      });
    return pendingLeave;
  };
  createEffect(() => {
    const code = ended()?.code;
    if (!code || !signInCodes.has(code)) return;
    const onFocus = () => opts.resume();
    const onVisible = () => {
      if (document.visibilityState === "visible") opts.resume();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    onCleanup(() => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    });
  });
  return {
    ended,
    confirmLeave,
    allowLeave,
    shouldConfirmLeave,
    end: (error: YjsProviderError): void => {
      setEnded({ code: error.code, unsent: opts.hasUnsentChanges() });
    },
    /** Re-reads the save state; late echoes or edits after the end can change it. */
    refresh: (): void => {
      setEnded((previous) => previous && { code: previous.code, unsent: opts.hasUnsentChanges() });
    },
    ready: (): void => {
      // The bar unmounts with its focused button, so hand focus back to the note instead of dropping it on the page.
      const barFocused = !!document.activeElement?.closest("[data-sync-ended]");
      setEnded(null);
      setLeaveConfirmed(false);
      if (barFocused) opts.focusEditor();
    },
    extension: (): Extension => (ended() ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []),
  };
}

const iconFor = (code: SyncEnded["code"]) => {
  if (signInCodes.has(code)) return "ti ti-login-2";
  if (code === "NOTE_NOT_FOUND") return "ti ti-file-x";
  if (code === "ACCESS_REVOKED" || code === "ACCESS_DENIED") return "ti ti-shield-off";
  if (code === "NOTE_LOCKED") return "ti ti-lock";
  if (code === "STORAGE_EXHAUSTED") return "ti ti-database-off";
  return "ti ti-alert-triangle";
};

export function SyncEndedBar(props: {
  ended: SyncEnded;
  sync: ReturnType<typeof createSyncEnded>;
  markdown: () => string;
  noteHref: () => string;
}) {
  const locale = useLocale();
  const t = () => notebookWorkspaceMessages.resolve([locale()]).t;
  let primary!: HTMLButtonElement;
  const signIn = () => signInCodes.has(props.ended.code);
  const title = () => {
    const code = props.ended.code;
    if (signInCodes.has(code)) return t().sessionExpired;
    if (code === "NOTE_NOT_FOUND") return t().noteNotFound;
    if (code === "ACCESS_REVOKED" || code === "ACCESS_DENIED") return t().accessChanged;
    if (code === "NOTE_LOCKED") return t().noteLocked;
    if (code === "STORAGE_EXHAUSTED") return t().storageFull;
    return t().connectionClosed;
  };
  const onPrimary = () => {
    if (signIn()) {
      window.open(createLoginRedirectUrl(new URL(props.noteHref(), window.location.href).href), "_blank", "noopener");
    } else {
      void clipboard.copy(props.markdown()).then(
        () => toast.success(t().contentCopied),
        () => toast.error(t().contentCopyFailed),
      );
    }
  };
  const onReload = async () => {
    if (
      props.ended.unsent &&
      !(await prompts.confirm(t().discardUnsavedConfirm, {
        title: t().reload,
        icon: "ti ti-refresh",
        variant: "danger",
        confirmText: t().reload,
      }))
    )
      return;
    props.sync.allowLeave();
    refreshCurrentPath();
  };
  // The unsent text exists only in this tab: closing it or following a link asks first, like Reload does.
  createEffect(() => {
    if (!props.sync.shouldConfirmLeave()) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    let replaying = false;
    const click = (event: MouseEvent) => {
      if (replaying || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!link || link.target === "_blank" || link.hasAttribute("download") || link.getAttribute("href")?.startsWith("#")) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void props.sync.confirmLeave().then((leave) => {
        if (!leave || !link.isConnected) return;
        replaying = true;
        link.click();
        replaying = false;
      });
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", click, true);
    onCleanup(() => {
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", click, true);
    });
  });
  onMount(() => {
    // Keep keyboard focus reachable when the editor stops accepting input.
    if (document.activeElement?.closest(".cm-editor") || document.activeElement === document.body) primary.focus();
  });
  return (
    <div
      class="notebooks-editor-toolbar mt-1 flex min-w-0 items-center gap-2 px-2 py-2 text-base text-dimmed"
      data-sync-ended={props.ended.code}
    >
      <InlineGuidance
        role="alert"
        tone={props.ended.unsent ? "danger" : "warning"}
        icon={iconFor(props.ended.code)}
        class="min-w-0 flex-1 items-center"
      >
        {/* The save state leads, so a narrow phone row truncates the reason, never whether text is lost. */}
        <span class="block truncate">
          {props.ended.unsent ? t().changesNotSaved : t().allChangesSaved}. {title()}
        </span>
      </InlineGuidance>
      <Show when={!signIn()}>
        <IconButton size="xs" variant="ghost" class="text-dimmed shrink-0" label={t().reload} onClick={() => void onReload()}>
          <i class="ti ti-refresh" aria-hidden="true" />
        </IconButton>
      </Show>
      <Button ref={primary} size="xs" variant="primary" class="shrink-0" onClick={onPrimary}>
        <i class={signIn() ? "ti ti-login-2" : "ti ti-copy"} aria-hidden="true" />
        {signIn() ? t().signInAgain : t().copyText}
      </Button>
    </div>
  );
}
