import type { DateContext } from "@k2b/stdlib";
import { dates } from "@k2b/stdlib";
import { FloatingWindow, type FloatingWindowRect, type FloatingWindowState, toast, useLocale } from "@k2b/ui";
import { type Accessor, createEffect, createSignal, For, onCleanup, onMount, type Setter } from "solid-js";
import { apiClient } from "../../api/client";
import type { MailDraft, SenderIdentity } from "../../contracts";
import { readApiError } from "./api-response";
import type { MailComposerHost, MailInlineDraftControls } from "./MailComposer";
import MailInlineDraft from "./MailInlineDraft";
import { mailComposeWindowMessages } from "./mail-compose-window-messages";
import {
  type DraftWindowOpenOptions,
  readComposeWindows,
  registerDraftWindowHost,
  type StoredComposeWindow,
  writeComposeWindows,
} from "./mail-compose-windows";

/** Below this width a window is a full-screen sheet (the `FloatingWindow` phone rule); Send then moves into its head. */
const SHEET_QUERY = "(max-width: 639.98px)";
const WINDOW_SIZE = { width: 560, height: 600, minWidth: 420, minHeight: 360 };

type ComposeWindow = {
  key: number;
  draftId: string;
  initialDraft?: MailDraft;
  fresh: boolean;
  /** Reopened from this tab's memory: a draft that is gone by now closes without a word. */
  restored: boolean;
  returnFocus: HTMLElement | null;
  state: Accessor<FloatingWindowState>;
  setState: Setter<FloatingWindowState>;
  rect: Accessor<FloatingWindowRect | undefined>;
  setRect: Setter<FloatingWindowRect | undefined>;
};

export type MailComposeWindowsProps = {
  mailboxId: string;
  /** The Mail app's area: windows stay inside it, dock at its bottom, and maximize over it. */
  area: () => HTMLElement | undefined;
  currentUserId: string;
  currentUserEmail: string | null;
  identities: SenderIdentity[];
  dateConfig: DateContext;
  canAdmin: boolean;
  mailboxRecipientSuggestions: boolean;
  calendarIntegrationAvailable: boolean;
  liveDictation: boolean;
  returnHref: string;
  /** A draft was sent, discarded, or saved: Drafts, the list, and the outbox show it. */
  onDraftsChanged: () => void;
  /** Whether a minimized bar lies over the bottom of the area, so the list keeps its last row reachable. */
  onDockedChange?: (docked: boolean) => void;
};

/**
 * The mailbox's draft windows: a new message, a draft from Drafts, or a reply someone moved out of its conversation.
 * Several can be open; minimized ones line up at the bottom. Closing never loses anything: the draft waits in Drafts and
 * the notice opens it again. The open windows of this tab come back after a reload.
 */
export default function MailComposeWindows(props: MailComposeWindowsProps) {
  const locale = useLocale();
  const t = () => mailComposeWindowMessages.resolve([locale()]).t;
  const [windows, setWindows] = createSignal<ComposeWindow[]>([]);
  const controls = new Map<number, MailInlineDraftControls>();
  /** Windows that close because someone takes the draft back, so no notice follows. */
  const recalled = new Set<number>();
  const [sheet, setSheet] = createSignal(false);
  let nextKey = 1;
  let ready = false;

  const create = (draftId: string, options: DraftWindowOpenOptions & { restored?: StoredComposeWindow }): ComposeWindow => {
    const [state, setState] = createSignal<FloatingWindowState>(options.restored?.state ?? "normal");
    const [rect, setRect] = createSignal<FloatingWindowRect | undefined>(options.restored?.rect);
    const active = typeof document === "undefined" ? null : document.activeElement;
    return {
      key: nextKey++,
      draftId,
      initialDraft: options.initialDraft?.id === draftId ? options.initialDraft : undefined,
      fresh: options.fresh ?? false,
      restored: Boolean(options.restored),
      returnFocus: options.returnFocus ?? (active instanceof HTMLElement && active !== document.body ? active : null),
      state,
      setState,
      rect,
      setRect,
    };
  };

  const open = (draftId: string, options: DraftWindowOpenOptions) => {
    const existing = windows().find((entry) => entry.draftId === draftId);
    if (existing) {
      if (existing.state() === "minimized") existing.setState("normal");
      controls.get(existing.key)?.focusText();
      return;
    }
    setWindows((list) => [...list, create(draftId, options)]);
  };

  const remove = (entry: ComposeWindow, options: { returnFocus: boolean }) => {
    controls.delete(entry.key);
    recalled.delete(entry.key);
    setWindows((list) => list.filter((candidate) => candidate !== entry));
    // The focus goes back to what opened the window, such as New message, when it is still there.
    if (options.returnFocus && entry.returnFocus?.isConnected) entry.returnFocus.focus({ preventScroll: true });
  };

  /** Undo of a send and a change of a scheduled one both bring the draft back, into its window. */
  const reopenFromDelivery = async (submissionId: string) => {
    try {
      const response = await apiClient.mailboxes[":mailboxId"]["scheduled-sends"][":scheduledSendId"].cancel.$post({
        param: { mailboxId: props.mailboxId, scheduledSendId: submissionId },
        json: { disposition: "draft" },
      });
      if (!response.ok) throw new Error(await readApiError(response, t().reopenFailed));
      const result = await response.json();
      props.onDraftsChanged();
      open(result.draftId, { fresh: false });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t().reopenFailed);
    }
  };

  const delivered: NonNullable<MailComposerHost["delivered"]> = (delivery) => {
    const submissionId = delivery.submissionId;
    if (delivery.scheduledAt) {
      const notice = toast.success(t().scheduledFor({ value: dates.formatDateTime(delivery.scheduledAt, props.dateConfig) }), {
        iconClass: "ti ti-clock",
        action: submissionId
          ? {
              label: t().change,
              onClick: () => {
                notice.dismiss();
                void reopenFromDelivery(submissionId);
              },
            }
          : null,
      });
      return;
    }
    if (delivery.undoSeconds > 0 && submissionId) {
      // The notice lasts exactly as long as the send can still be undone.
      const notice = toast(t().sendingIn({ seconds: delivery.undoSeconds }), {
        iconClass: "ti ti-send",
        duration: delivery.undoSeconds * 1000,
        action: {
          label: t().undo,
          onClick: () => {
            notice.dismiss();
            void reopenFromDelivery(submissionId);
          },
        },
      });
      return;
    }
    toast.success(t().sending, { iconClass: "ti ti-send" });
  };

  const hostFor = (entry: ComposeWindow, title: Setter<string>, slots: MailComposerHost["window"]): MailComposerHost => ({
    fresh: entry.fresh,
    fullscreen: () => entry.state() === "maximized",
    toggleFullscreen: () => entry.setState((state) => (state === "maximized" ? "normal" : "maximized")),
    register: (next) => controls.set(entry.key, next),
    messageLabel: () => null,
    summary: (value) => title(value.subject),
    window: slots,
    delivered,
    leave: (outcome) => {
      const quiet = recalled.has(entry.key);
      remove(entry, { returnFocus: !quiet });
      if (outcome === "moved") return;
      props.onDraftsChanged();
      if (outcome !== "closed" || quiet) return;
      const notice = toast(t().draftInDrafts, {
        iconClass: "ti ti-file-text",
        action: {
          label: t().open,
          onClick: () => {
            notice.dismiss();
            open(entry.draftId, { fresh: false });
          },
        },
      });
    },
    // Another draft takes this window's place, such as a saved copy of unsaved input or the rest of a shared draft.
    openDraft: (draftId) => {
      const next = create(draftId, { restored: { draftId, state: entry.state(), rect: entry.rect() } });
      controls.delete(entry.key);
      setWindows((list) => list.map((candidate) => (candidate === entry ? next : candidate)));
    },
  });

  /** Close: the composer saves and releases the draft; a window that never loaded has nothing to keep. */
  const close = (entry: ComposeWindow) => {
    const own = controls.get(entry.key);
    if (own) void own.collapse();
    else remove(entry, { returnFocus: true });
  };

  const recall = async (draftId: string): Promise<boolean> => {
    const entry = windows().find((candidate) => candidate.draftId === draftId);
    const own = entry && controls.get(entry.key);
    if (!entry || !own) return false;
    recalled.add(entry.key);
    await own.collapse();
    const gone = !windows().includes(entry);
    if (!gone) recalled.delete(entry.key);
    return gone;
  };

  onMount(() => {
    const media = window.matchMedia(SHEET_QUERY);
    const updateSheet = () => setSheet(media.matches);
    updateSheet();
    media.addEventListener("change", updateSheet);
    onCleanup(() => media.removeEventListener("change", updateSheet));
    // F5: the windows this tab had open in this mailbox come back in the same state and place.
    const stored = readComposeWindows(window.sessionStorage, props.mailboxId);
    setWindows(stored.map((entry) => create(entry.draftId, { restored: entry, returnFocus: null })));
    ready = true;
    onCleanup(
      registerDraftWindowHost({
        mailboxId: props.mailboxId,
        open,
        isOpen: (draftId) => windows().some((entry) => entry.draftId === draftId),
        recall,
      }),
    );
  });

  createEffect(() => {
    const list = windows().map((entry) => {
      const rect = entry.rect();
      return rect ? { draftId: entry.draftId, state: entry.state(), rect } : { draftId: entry.draftId, state: entry.state() };
    });
    if (ready) writeComposeWindows(window.sessionStorage, props.mailboxId, list);
  });
  createEffect(() => props.onDockedChange?.(windows().some((entry) => entry.state() === "minimized")));
  onCleanup(() => props.onDockedChange?.(false));

  return (
    <For each={windows()}>
      {(entry) => {
        const [title, setTitle] = createSignal("");
        // One place each in the window's head, kept across minimize, where the composer shows its status and Send.
        const slot = () => Object.assign(document.createElement("span"), { className: "mail-compose-window-slot" });
        const statusSlot = slot();
        const actionsSlot = slot();
        const slots: MailComposerHost["window"] = { status: () => statusSlot, actions: () => actionsSlot, sheet };
        const host = hostFor(entry, setTitle, slots);
        return (
          <FloatingWindow
            title={title() || t().newMessage}
            class="mail-compose-window"
            placement="dock"
            area={props.area}
            state={entry.state()}
            onStateChange={entry.setState}
            rect={entry.rect()}
            onRectChange={entry.setRect}
            initialWidth={WINDOW_SIZE.width}
            initialHeight={WINDOW_SIZE.height}
            minWidth={WINDOW_SIZE.minWidth}
            minHeight={WINDOW_SIZE.minHeight}
            status={statusSlot}
            actions={sheet() ? actionsSlot : undefined}
            onClose={() => close(entry)}
          >
            <div class="mail-compose-window-body" data-mail-compose-window={entry.draftId}>
              <MailInlineDraft
                mailboxId={props.mailboxId}
                draftId={entry.draftId}
                initialDraft={entry.initialDraft}
                currentUserId={props.currentUserId}
                currentUserEmail={props.currentUserEmail}
                identities={props.identities}
                dateConfig={props.dateConfig}
                canAdmin={props.canAdmin}
                mailboxRecipientSuggestions={props.mailboxRecipientSuggestions}
                calendarIntegrationAvailable={props.calendarIntegrationAvailable}
                liveDictation={props.liveDictation}
                returnHref={props.returnHref}
                host={host}
                // A remembered window whose draft is gone (sent, deleted, no access) closes without a word.
                onUnavailable={entry.restored ? () => remove(entry, { returnFocus: false }) : undefined}
              />
            </div>
          </FloatingWindow>
        );
      }}
    </For>
  );
}
