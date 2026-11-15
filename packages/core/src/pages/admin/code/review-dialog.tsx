import { Button, DialogHeader, dialogCore, TextInput } from "@k2b/ui";
import { createSignal, createUniqueId, Show } from "solid-js";
import { CODE_REVIEW_COMMENT_LENGTH } from "../../../code/review-contracts";
import type { CodeReviewMessages } from "./review-messages";

export type CodeReviewDialogKind = "changes" | "reject";

/** What the dialog names: who gets the message, what stays switched on, how many comments go along, and the origin. */
export type CodeReviewDialogInput = {
  kind: CodeReviewDialogKind;
  number: number;
  recipient: string;
  /** The sentence about what keeps running, already worded. */
  keep: string;
  comments: number;
  /** How the person continues after "Request changes": Gustav by itself, by a button, or in the command line. */
  next: "chat" | "button" | "cli";
  draft: string;
  t: CodeReviewMessages;
  /**
   * Sends the decision. It resolves when the page leaves this dialog behind (the decision is saved, or its outcome is
   * unclear). A refusal rejects with the sentence to show; the dialog then stays open with the text.
   */
  send: (comment: string) => Promise<void>;
  /** Keeps what was typed when the dialog closes unsent, so reopening shows it again. */
  keepDraft: (comment: string) => void;
};

/**
 * "Request changes" and "Reject": a required text, an error line that is always there, so checking never moves the
 * dialog, and sending inside the dialog, so a refusal keeps the text in place.
 */
export function openCodeReviewDialog(input: CodeReviewDialogInput): Promise<boolean | undefined> {
  const t = input.t;
  const changes = input.kind === "changes";
  let field: HTMLElement | undefined;
  return dialogCore.open<boolean>(
    (close, context) => {
      // The dialog opens from a button inside the approval, which carries the AI colour. The decision itself is
      // Cloud's administration, not AI: it keeps the page's own colours (v12, picture 49).
      queueMicrotask(() => context.dialog.removeAttribute("data-k2b-primary"));
      const errorId = `code-review-dialog-error-${createUniqueId()}`;
      const [text, setText] = createSignal(input.draft);
      const [error, setError] = createSignal<string | null>(null);
      const [sending, setSending] = createSignal(false);
      const leave = () => {
        if (!sending()) close(false);
      };
      // Escape and the backdrop take the same guarded way as "Cancel": never while a decision is on its way.
      context.setDismissHandler(leave);
      const submit = async (event: SubmitEvent) => {
        event.preventDefault();
        if (sending()) return;
        const comment = text().trim();
        if (!comment) {
          setError(changes ? t.changesMissing : t.rejectMissing);
          field?.focus();
          return;
        }
        setSending(true);
        setError(null);
        try {
          await input.send(comment);
          close(true);
        } catch (failure) {
          setError(failure instanceof Error && failure.message ? failure.message : t.dialogFailed);
          setSending(false);
          field?.focus();
        }
      };
      const lead = () => {
        if (!changes) return t.rejectText({ who: input.recipient, keep: input.keep });
        if (input.next === "cli") return t.changesTextCli({ who: input.recipient, keep: input.keep });
        if (input.next === "button") return t.changesTextButton({ who: input.recipient, keep: input.keep });
        return t.changesTextChat({ who: input.recipient, keep: input.keep });
      };
      return (
        <form class="k2b-dialog__panel" noValidate onSubmit={(event) => void submit(event)} data-code-review-dialog={input.kind}>
          <DialogHeader title={changes ? t.changesTitle({ n: input.number }) : t.rejectTitle({ n: input.number })} close={leave} />
          <div class="k2b-dialog__body core-code-review-dialog">
            <p class="core-code-review-dialog__lead">{lead()}</p>
            <TextInput
              ref={(element) => {
                field = element;
              }}
              label={changes ? t.changesLabel : t.rejectLabel}
              placeholder={changes ? t.changesPlaceholder : t.rejectPlaceholder}
              multiline
              lines={3}
              maxLength={CODE_REVIEW_COMMENT_LENGTH}
              value={text}
              onValueChange={(value) => {
                setText(value);
                // Escape, the close button and "Cancel" all keep the draft for the next opening.
                input.keepDraft(value);
                if (error() && value.trim()) setError(null);
              }}
              readOnly={sending()}
              required
              externalErrorId={error() ? errorId : undefined}
            />
            {/* Always there, so a message never moves the buttons; it is the field's error while it has one. */}
            <p id={errorId} class="core-code-review-dialog__error" role="alert">
              <Show when={error()}>
                {(message) => (
                  <>
                    <i class="ti ti-alert-circle" aria-hidden="true" />
                    {message()}
                  </>
                )}
              </Show>
            </p>
            <Show when={input.comments > 0}>
              <p class="core-code-review-dialog__goes">
                <i class="ti ti-message-2" aria-hidden="true" />
                {t.commentsGoWith({ n: input.comments })}
              </p>
            </Show>
          </div>
          <footer class="k2b-dialog__actions">
            <Button type="button" variant="secondary" disabled={sending()} onClick={leave}>
              {t.dialogCancel}
            </Button>
            <Button type="submit" variant={changes ? "primary" : "danger"} loading={sending()}>
              {changes ? t.changesConfirm : t.rejectConfirm({ n: input.number })}
            </Button>
          </footer>
        </form>
      );
    },
    {
      panelClassName: "k2b-dialog k2b-dialog--medium",
      contentClassName: "k2b-dialog__viewport",
      initialFocus: () => field ?? null,
      ariaLabel: changes ? t.changesTitle({ n: input.number }) : t.rejectTitle({ n: input.number }),
      cancelBehavior: "resolve-undefined",
    },
  );
}
