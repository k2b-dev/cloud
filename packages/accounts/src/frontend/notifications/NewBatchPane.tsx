import { Band, Bar, Button, Field, Input, Lookup, Notice, Pane, Text } from "@k2b/ui/v2";
import { Show } from "solid-js";
import { audienceLookup } from "../audit/entities";
import { useAccountsMessages } from "../messages";
import { useNotificationMessages } from "./messages";
import { useNewBatchForm } from "./new-batch";

const audience = audienceLookup();

/**
 * A new notification batch beside the list of batches: the message, who gets it, and the recipient preview, then
 * "Create draft". The list keeps its one primary ("New notification"), so the form saves with a default button; on the
 * phone the form is the page, with one way back to the list.
 */
export default function NewBatchPane(props: { closeHref: string }) {
  const t = useAccountsMessages();
  const words = useNotificationMessages();
  const form = useNewBatchForm();
  const required = (value: string) => (form.tried() && !value.trim() ? words().required : undefined);
  const audienceError = () => (form.tried() && !form.hasAudience() ? words().audienceRequired : undefined);
  return (
    <Pane
      detail
      label={t().newNotificationBatch}
      width={{ min: 400, default: 480 }}
      back={{ label: t().notifications, href: props.closeHref }}
      head={
        <Bar
          start={<Text type="lead">{t().newNotificationBatch}</Text>}
          end={<Button variant="ghost" icon="x" label={t().close} href={props.closeHref} />}
        />
      }
    >
      <Band>
        <Text>{t().newNotificationDescription}</Text>
        <Field name="subject" label={t().subject} hint={t().subjectDescription} error={required(form.subject())} required>
          <Input value={form.subject()} placeholder={t().subjectExample} disabled={form.saving()} onInput={form.setSubject} />
        </Field>
        <Field
          name="body"
          label={t().body}
          hint={`${t().bodyDescription} ${t().messageTemplateDescription}`}
          error={required(form.body())}
          required
        >
          <Input multiline value={form.body()} placeholder={t().bodyPlaceholder} disabled={form.saving()} onInput={form.setBody} />
        </Field>
      </Band>
      <Band>
        {/* one search over users and groups, as the v1 dialog searched them; members of chosen groups are included */}
        <Field name="audience" label={t().audience} hint={words().audienceHint} error={audienceError()}>
          <Lookup
            label={t().recipients}
            value={form.audience()}
            onChange={form.setAudience}
            load={audience.load}
            resolve={audience.resolve}
            minChars={2}
          />
        </Field>
      </Band>
      <Notice
        tone={form.previewFailed() ? "bad" : "note"}
        icon={form.previewFailed() ? undefined : "eye"}
        title={t().livePreview}
        actions={[
          {
            label: form.previewing() ? t().previewing : t().refreshPreview,
            icon: "refresh",
            onClick: form.refreshPreview,
            disabled: form.previewing() || form.saving() || !form.hasAudience(),
          },
        ]}
      >
        {form.previewText()}
      </Notice>
      <Show when={form.error()}>
        {(message) => (
          <Notice tone="bad" icon="alert-circle">
            {message()}
          </Notice>
        )}
      </Show>
      <Bar
        end={
          <>
            <Button href={props.closeHref} disabled={form.saving()}>
              {t().cancel}
            </Button>
            {/* a default button: the page's one primary stays "New notification" in the head */}
            <Button icon="device-floppy" busy={form.saving()} onClick={() => void form.create()}>
              {t().createDraft}
            </Button>
          </>
        }
      />
    </Pane>
  );
}
