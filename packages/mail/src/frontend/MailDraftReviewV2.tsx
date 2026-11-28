import { Band, Bar, Empty, Facts, Icon, Inline, Pane, Path, Prose, Section, Text, Workspace } from "@k2b/ui/v2";
import { Show } from "solid-js";

/** What the review page shows, read once on the server; the page has no island. */
export type MailDraftReviewData = {
  mailbox: { name: string; href: string };
  subject: string;
  /** The words above the draft: who may only read it, or which version was put up for review. */
  note: string | null;
  facts: { label: string; value: string }[];
  body: { format: "markdown" | "text"; text: string } | null;
  attachments: string[];
  text: { attachments: string; noMessageBody: string; text: string };
};

/** A review whose version is no longer the draft's: it says so and leads to the current draft. */
export type MailDraftReviewChanged = {
  mailbox: { name: string; href: string };
  subject: string;
  title: string;
  description: string;
  current: { label: string; href: string };
};

const head = (props: { mailbox: { name: string; href: string }; subject: string }) => (
  <Bar
    start={<Path label={props.mailbox.name} items={[{ label: props.mailbox.name, href: props.mailbox.href }, { label: props.subject }]} />}
  />
);

/**
 * A draft as it is put up for review, on UI v2: the place in the head, why it is shown (read only, or the version under
 * review), its recipients, its text and its attachments. Rendered on the server; nothing on it can change the draft.
 */
export function MailDraftReviewV2(props: MailDraftReviewData) {
  return (
    <Workspace head={head(props)}>
      <Pane label={props.subject}>
        {/* why the draft is shown, quietly above its facts: no warning, no band of its own */}
        <Band>
          <Show when={props.note}>
            {(note) => (
              <Inline>
                <Icon name="file-pencil" />
                <Text muted>{note()}</Text>
              </Inline>
            )}
          </Show>
          <Facts
            items={[
              ...props.facts,
              ...(props.attachments.length > 0 ? [{ label: props.text.attachments, value: props.attachments.join(", ") }] : []),
            ]}
          />
        </Band>
        {/* the text at the reading measure, with the room a section gives what follows a block */}
        <Section title={props.text.text} measure>
          <Show when={props.body} fallback={<Prose>{props.text.noMessageBody}</Prose>}>
            {(body) => (body().format === "markdown" ? <Prose markdown={body().text} /> : <Prose>{body().text}</Prose>)}
          </Show>
        </Section>
      </Pane>
    </Workspace>
  );
}

/** The review's version is gone: one sentence in the draft's place, and the way to the draft as it is now. */
export function MailDraftReviewChangedV2(props: MailDraftReviewChanged) {
  return (
    <Workspace head={head(props)}>
      <Pane label={props.subject}>
        <Empty
          icon="file-alert"
          tone="warn"
          text={`${props.title}. ${props.description}`}
          action={{ label: props.current.label, href: props.current.href }}
        />
      </Pane>
    </Workspace>
  );
}
