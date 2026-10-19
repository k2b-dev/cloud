import { dates, fileIcons } from "@k2b/stdlib";
import {
  Button,
  Chat,
  type ChatDecisionState,
  type ChatOutcomeLine,
  isStructuredDataValue,
  LocaleProvider,
  MarkdownView,
  ReferenceChip,
  StructuredDataPreview,
} from "@k2b/ui";
import { Lexer, type Token, type Tokens } from "marked";
import { createMemo, createSignal, createUniqueId, For, type JSX, Match, Show, Switch } from "solid-js";
import type { CapabilityPerson, CapabilityPreview } from "../../contracts/capabilities";
import { formatBytes } from "../../shared/format";
import type { ActionCard, ActionChip, ActionPreviewModel, ActionText } from "./action-card";
import { actionMessages } from "./action-messages";

/**
 * The look of every Assistant question and its outcome (card v4): one sentence with chips, Cloud's reason line, the
 * thing itself, two answers that name deed and target, and after the answer one outcome line in the same place. The
 * chat, the approvals page, and Code Mode render the same components from an `ActionCard`.
 */

// ---------------------------------------------------------------------------
// Sentence
// ---------------------------------------------------------------------------

function PersonChips(props: { chip: Extract<ActionChip, { kind: "person" }> }) {
  // List words such as ", " and " und " come from the locale; each name is its own chip, the rest stays text.
  const parts = createMemo(() => {
    const names = props.chip.names;
    const items =
      props.chip.rest > 0 ? [...names.map((_, index) => `\u0000${index}`), props.chip.more] : names.map((_, index) => `\u0000${index}`);
    return new Intl.ListFormat(props.chip.locale, { type: "conjunction" }).formatToParts(items).map((part) => {
      const match = part.type === "element" ? /^\u0000(\d+)$/.exec(part.value) : null;
      return match ? { name: names[Number(match[1])]! } : { text: part.value };
    });
  });
  return <For each={parts()}>{(part) => ("name" in part ? <ReferenceChip kind="person" name={part.name ?? ""} /> : part.text)}</For>;
}

/** A sentence of text and typed chips, in the app's colour. */
export function ActionTextView(props: { text: ActionText; accent?: string }) {
  return (
    <For each={props.text}>
      {(part) => (
        <Switch fallback={part.kind === "text" ? part.text : null}>
          <Match when={part.kind === "chip" ? part.chip : undefined}>
            {(chip) => (
              <Switch>
                <Match when={chip().kind === "person" ? (chip() as Extract<ActionChip, { kind: "person" }>) : undefined}>
                  {(person) => <PersonChips chip={person()} />}
                </Match>
                <Match when={chip().kind === "time" ? (chip() as Extract<ActionChip, { kind: "time" }>) : undefined}>
                  {(time) => <ReferenceChip kind="time" label={time().label} dateTime={time().dateTime} />}
                </Match>
                <Match
                  when={
                    chip().kind === "object" || chip().kind === "place"
                      ? (chip() as Extract<ActionChip, { kind: "object" | "place" }>)
                      : undefined
                  }
                >
                  {(thing) => (
                    <ReferenceChip
                      kind={thing().kind}
                      title={thing().title}
                      href={thing().href}
                      icon={thing().icon}
                      accent={props.accent}
                      gone={thing().gone}
                    />
                  )}
                </Match>
              </Switch>
            )}
          </Match>
        </Switch>
      )}
    </For>
  );
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A calendar day stays that day everywhere; an instant shows in the reader's zone. */
const formatWhen = (value: string, locale: string, timeZone: string, withTime = true): string =>
  DAY.test(value)
    ? dates.formatDate(`${value}T12:00:00.000Z`, { locale, timeZone: "UTC" })
    : withTime
      ? dates.formatDateTime(value, { locale, timeZone })
      : dates.formatDate(value, { locale, timeZone });

const rangeText = (start: string, end: string | undefined, locale: string, timeZone: string, allDay?: boolean): string => {
  const from = formatWhen(start, locale, timeZone, !allDay);
  if (!end) return from;
  // An all-day event never shows an end time, even when its bounds are instants.
  const sameDay =
    !allDay &&
    !DAY.test(start) &&
    !DAY.test(end) &&
    formatWhen(start, locale, timeZone, false) === formatWhen(end, locale, timeZone, false);
  const to = sameDay ? dates.formatTime(end, { locale, timeZone }) : formatWhen(end, locale, timeZone, !allDay);
  return to === from ? from : `${from} – ${to}`;
};

const personRow = (person: CapabilityPerson) => ({
  ...(person.name ? { name: person.name } : {}),
  ...(person.address ? { address: person.address } : {}),
});

/** Block tokens end their line, so the excerpt keeps the text's lines. */
const MARKDOWN_BLOCKS = new Set(["heading", "paragraph", "code", "blockquote", "html", "hr"]);

/**
 * The words of Markdown as the parser reads them: marks dropped, every literal character kept (an intraword `_` is
 * text), and link targets kept, so a link never hides where it goes.
 */
const markdownWords = (tokens: readonly Token[]): string =>
  tokens
    .map((token): string => {
      switch (token.type) {
        case "space":
          return "";
        case "link": {
          const text = markdownWords(token.tokens ?? []);
          return text === token.href ? token.href : `${text} (${token.href})`;
        }
        case "image":
          return token.text;
        case "br":
          return "\n";
        case "list":
          return `${(token as Tokens.List).items.map((item) => markdownWords(item.tokens).trimEnd()).join("\n")}\n`;
        case "table": {
          const table = token as Tokens.Table;
          return `${[table.header, ...table.rows].map((row) => row.map((cell) => markdownWords(cell.tokens)).join(" · ")).join("\n")}\n`;
        }
      }
      const words = "tokens" in token && token.tokens ? markdownWords(token.tokens) : "text" in token ? String(token.text) : token.raw;
      return MARKDOWN_BLOCKS.has(token.type) ? `${words.trimEnd()}\n` : words;
    })
    .join("");

/** About what one line holds in the narrowest column a card stands in, a 20 rem panel. */
const EXCERPT_LINE_CHARS = 40;

/** Whether a text may need more than the excerpt's three lines; counted alike on the server and in the browser. */
const mayOverflow = (text: string): boolean =>
  text.split("\n").reduce((lines, line) => lines + Math.max(1, Math.ceil(line.length / EXCERPT_LINE_CHARS)), 0) > 3;

/**
 * The first lines of a text. With the app's link, its "read" link follows the preview; without one, a text that may
 * not fit offers to show the rest in place, so nothing a person approves stays out of reach.
 */
function PreviewExcerpt(props: { text: string; readMore?: string; label: string }) {
  const id = createUniqueId();
  const [expanded, setExpanded] = createSignal(false);
  return (
    <>
      <Chat.Preview.Excerpt id={id} expanded={expanded()}>
        {props.text}
      </Chat.Preview.Excerpt>
      <Show when={!props.readMore && !expanded() && mayOverflow(props.text)}>
        <Chat.Preview.ShowAll controls={id} onShow={() => setExpanded(true)}>
          {props.label}
        </Chat.Preview.ShowAll>
      </Show>
    </>
  );
}

/** A short excerpt of a body: plain text as it is, Markdown as its words. */
const excerptText = (body: string, format: "plain" | "markdown"): string =>
  format === "plain" ? body : markdownWords(Lexer.lex(body)).trimEnd();

const peopleNames = (people: readonly CapabilityPerson[], locale: string, more = 0): string => {
  const names = people.map((person) => person.name ?? person.address ?? "");
  return new Intl.ListFormat(locale, { type: "conjunction" }).format(
    more > 0 ? [...names, actionMessages(locale).moreCount({ count: more })] : names,
  );
};

const attachmentLook = (name: string) => {
  // The icon name only: its colour comes from the shared file-type tokens, not from a utility class.
  const glyph = fileIcons.getFileIcon({ name, type: "file" }).split(/\s+/)[0] ?? "ti-file";
  return { icon: `ti ${glyph}`, accent: glyph.includes("pdf") ? "var(--k2b-file-type-pdf)" : undefined };
};

/** An app's warning leads with its first short sentence in bold, such as "1 external recipient." */
function WarningText(props: { text: string }) {
  const split = () => {
    const match = /^(.{1,80}?[.!?])\s+(\S.*)$/s.exec(props.text);
    return match ? { lead: match[1]!, rest: match[2]! } : null;
  };
  return (
    <Show when={split()} fallback={props.text}>
      {(parts) => (
        <>
          <b>{parts().lead}</b> {parts().rest}
        </>
      )}
    </Show>
  );
}

function MessagePreview(props: {
  preview: Extract<CapabilityPreview, { kind: "message" }>;
  locale: string;
  timeZone: string;
  readMore?: string;
}) {
  const t = () => actionMessages(props.locale);
  const rows = () => {
    const p = props.preview;
    const more = (count?: number) => (count ? { value: <> {t().andMore({ count })}</> } : {});
    return [
      ...(p.from ? [{ label: t().from, people: [personRow(p.from)] }] : []),
      { label: t().to, people: p.to.map(personRow), ...more(p.more?.to) },
      ...(p.cc?.length || p.more?.cc ? [{ label: t().cc, people: (p.cc ?? []).map(personRow), ...more(p.more?.cc) }] : []),
      ...(p.bcc?.length || p.more?.bcc
        ? [{ label: t().bcc, people: (p.bcc ?? []).map(personRow), emphasis: true, ...more(p.more?.bcc) }]
        : []),
    ];
  };
  const note = () => {
    const p = props.preview;
    if (p.sendAt) {
      const [before, after] = t().sendsAt({ at: "\u0000" }).split("\u0000");
      return (
        <>
          {before}
          <b>{formatWhen(p.sendAt, props.locale, props.timeZone)}</b>
          {after}
        </>
      );
    }
    return p.cc?.length || p.bcc?.length || p.more?.cc || p.more?.bcc ? t().sendsNowWithCopies : t().sendsNow;
  };
  return (
    <>
      <Chat.Preview.Header rows={rows()} note={note()} />
      <Chat.Preview.Title>{props.preview.subject || t().noSubject}</Chat.Preview.Title>
      <Show when={props.preview.body.trim()}>
        <PreviewExcerpt text={excerptText(props.preview.body, props.preview.format)} readMore={props.readMore} label={t().readMail} />
      </Show>
      <For each={props.preview.attachments ?? []}>
        {(attachment) => (
          <Chat.Preview.Line
            icon={attachmentLook(attachment.name).icon}
            accent={attachmentLook(attachment.name).accent}
            meta={attachment.size !== undefined ? formatBytes(attachment.size, { locale: props.locale }) : undefined}
          >
            {attachment.name}
          </Chat.Preview.Line>
        )}
      </For>
      <Show when={props.preview.moreAttachments}>
        {(count) => (
          <Chat.Preview.Line icon="ti ti-paperclip" tone="muted">
            {t().moreAttachments({ count: count() })}
          </Chat.Preview.Line>
        )}
      </Show>
      <For each={props.preview.warnings ?? []}>
        {(warning) => (
          <Chat.Preview.Line icon="ti ti-alert-triangle" tone="warning">
            <WarningText text={warning} />
          </Chat.Preview.Line>
        )}
      </For>
      <Show when={props.readMore}>
        {(href) => (
          <Chat.Preview.ReadMore href={href()} title={t().readMoreTitle}>
            {t().readMail}
          </Chat.Preview.ReadMore>
        )}
      </Show>
    </>
  );
}

function ReviewPreviewBody(props: { model: Extract<ActionPreviewModel, { kind: "review" }>; card: ActionCard; readMore?: string }) {
  const t = () => actionMessages(props.model.locale);
  const locale = () => props.model.locale;
  const tz = () => props.model.timeZone;
  const markIcon = (mark?: "added" | "removed") => (mark === "added" ? "ti ti-plus" : mark === "removed" ? "ti ti-minus" : "ti ti-point");
  const readMore = (label: string) => (
    <Show when={props.readMore}>
      {(href) => (
        <Chat.Preview.ReadMore href={href()} title={t().readMoreTitle}>
          {label}
        </Chat.Preview.ReadMore>
      )}
    </Show>
  );
  const preview = () => props.model.preview;
  return (
    <Chat.Preview>
      <Switch>
        <Match when={preview()?.kind === "message" ? (preview() as Extract<CapabilityPreview, { kind: "message" }>) : undefined}>
          {(message) => <MessagePreview preview={message()} locale={locale()} timeZone={tz()} readMore={props.readMore} />}
        </Match>
        <Match when={preview()?.kind === "event" ? (preview() as Extract<CapabilityPreview, { kind: "event" }>) : undefined}>
          {(event) => (
            <>
              <Chat.Preview.Title>{event().title}</Chat.Preview.Title>
              {/* When, where, and in which calendar, as one line of text like the person would say it. Times show in the
                  reader's zone, the same as the sentence's chips, so the question and the preview never disagree. */}
              <p>
                {[
                  `${rangeText(event().start, event().end, locale(), tz(), event().allDay)}${
                    event().allDay && !DAY.test(event().start) ? ` · ${t().allDay}` : ""
                  }`,
                  event().location,
                  event().place,
                ]
                  .filter(Boolean)
                  .join(", ")}
              </p>
              <Show when={event().recurrence}>
                {(recurrence) => <Chat.Preview.Line icon="ti ti-repeat">{recurrence()}</Chat.Preview.Line>}
              </Show>
              <Show when={event().attendees?.length ? event().attendees : undefined}>
                {(attendees) => (
                  <Chat.Preview.People
                    people={attendees()
                      .slice(0, 3)
                      .map((person) => ({ name: person.name ?? person.address ?? "" }))}
                  >
                    {peopleNames(attendees().slice(0, 3), locale(), attendees().length - 3)}
                  </Chat.Preview.People>
                )}
              </Show>
              <Show when={event().description?.trim()}>
                {(text) => <PreviewExcerpt text={text()} readMore={props.readMore} label={t().readMore} />}
              </Show>
              {readMore(t().readMore)}
            </>
          )}
        </Match>
        <Match when={preview()?.kind === "task" ? (preview() as Extract<CapabilityPreview, { kind: "task" }>) : undefined}>
          {(task) => (
            <>
              <Chat.Preview.Title meta={task().place}>{task().title}</Chat.Preview.Title>
              <Show when={task().due}>
                {(due) => (
                  <Chat.Preview.Line icon="ti ti-calendar-due">{t().due({ at: formatWhen(due(), locale(), tz()) })}</Chat.Preview.Line>
                )}
              </Show>
              <Show when={task().status}>{(status) => <Chat.Preview.Line icon="ti ti-progress">{status()}</Chat.Preview.Line>}</Show>
              <Show when={task().assignees?.length ? task().assignees : undefined}>
                {(assignees) => (
                  <Chat.Preview.People
                    people={assignees()
                      .slice(0, 3)
                      .map((person) => ({ name: person.name ?? person.address ?? "" }))}
                  >
                    {peopleNames(assignees().slice(0, 3), locale(), assignees().length - 3)}
                  </Chat.Preview.People>
                )}
              </Show>
              <Show when={task().checklist?.length ? task().checklist : undefined}>
                {(checklist) => (
                  <Chat.Preview.Lines>
                    <For each={checklist()}>
                      {(item) => (
                        <Chat.Preview.Line icon={item.done ? "ti ti-square-check" : "ti ti-square"}>{item.label}</Chat.Preview.Line>
                      )}
                    </For>
                  </Chat.Preview.Lines>
                )}
              </Show>
              <Show when={task().tags?.length ? task().tags : undefined}>
                {(tags) => (
                  <Chat.Preview.Line icon="ti ti-tag" tone="muted">
                    {tags().join(", ")}
                  </Chat.Preview.Line>
                )}
              </Show>
              <Show when={task().description?.trim()}>
                {(text) => <PreviewExcerpt text={text()} readMore={props.readMore} label={t().readMore} />}
              </Show>
              {readMore(t().readMore)}
            </>
          )}
        </Match>
        <Match when={preview()?.kind === "page" ? (preview() as Extract<CapabilityPreview, { kind: "page" }>) : undefined}>
          {(page) => (
            <>
              <Chat.Preview.Title meta={page().place}>{page().title}</Chat.Preview.Title>
              <Show when={page().body.trim()}>
                <PreviewExcerpt text={excerptText(page().body, page().format)} readMore={props.readMore} label={t().readPage} />
              </Show>
              <Show when={page().changes?.length ? page().changes : undefined}>
                {(changes) => (
                  <Chat.Preview.Lines label={t().changes}>
                    <For each={changes()}>
                      {(change) => (
                        <Chat.Preview.Line icon={markIcon(change.change)} mark={change.change}>
                          {change.text}
                        </Chat.Preview.Line>
                      )}
                    </For>
                  </Chat.Preview.Lines>
                )}
              </Show>
              {readMore(t().readPage)}
            </>
          )}
        </Match>
        <Match when={preview()?.kind === "file" ? (preview() as Extract<CapabilityPreview, { kind: "file" }>) : undefined}>
          {(file) => (
            <>
              <Chat.Preview.Title
                meta={
                  [file().size !== undefined ? formatBytes(file().size, { locale: locale() }) : "", file().place ?? file().path ?? ""]
                    .filter(Boolean)
                    .join(" · ") || undefined
                }
              >
                {file().name}
              </Chat.Preview.Title>
              <Show when={file().to}>
                {(to) => <Chat.Preview.Line icon="ti ti-arrow-right">{t().moveTo({ to: to() })}</Chat.Preview.Line>}
              </Show>
              {readMore(t().readMore)}
            </>
          )}
        </Match>
        <Match when={preview()?.kind === "rule" ? (preview() as Extract<CapabilityPreview, { kind: "rule" }>) : undefined}>
          {(rule) => (
            <>
              <Chat.Preview.Sentence>
                <ActionTextView text={props.model.when ?? []} accent={props.card.app.accent} />
              </Chat.Preview.Sentence>
              <Show when={rule().does.trim()}>
                <PreviewExcerpt text={rule().does} readMore={props.readMore} label={t().readRule} />
              </Show>
              {readMore(t().readRule)}
              <Chat.Preview.Lines label={rule().seesChat ? t().changes : t().ruleMay}>
                <For each={props.model.may ?? []}>
                  {(line) => (
                    <Chat.Preview.Line icon={line.mark === "removed" ? "ti ti-minus" : "ti ti-check"} mark={line.mark}>
                      <ActionTextView text={line.text} accent={props.card.app.accent} />
                    </Chat.Preview.Line>
                  )}
                </For>
                {/* What a routine cannot know is Cloud's fixed line; a Skill that works inside chats needs none. */}
                <Show when={!rule().seesChat}>
                  <Chat.Preview.Line icon="ti ti-info-circle" tone="muted">
                    {t().ruleBlindToChat}
                  </Chat.Preview.Line>
                </Show>
              </Chat.Preview.Lines>
            </>
          )}
        </Match>
        <Match when={preview()?.kind === "fields" ? (preview() as Extract<CapabilityPreview, { kind: "fields" }>) : undefined}>
          {(fields) => {
            const value = (text: string, format?: "date" | "date-time") =>
              format ? formatWhen(text, locale(), tz(), format === "date-time") : text;
            return (
              <>
                <Chat.Preview.Header
                  rows={fields().rows.map((row) => ({
                    label: row.label,
                    value:
                      row.before !== undefined ? (
                        <>
                          <Chat.Mark change="removed">{value(row.before, row.format)}</Chat.Mark>{" "}
                          <Chat.Mark change="added">{value(row.value, row.format)}</Chat.Mark>
                        </>
                      ) : (
                        <span class="cloud-action-preview__value">{value(row.value, row.format)}</span>
                      ),
                  }))}
                />
                {readMore(t().readMore)}
              </>
            );
          }}
        </Match>
      </Switch>
      <Show when={!preview()}>{readMore(t().readMore)}</Show>
      <Show when={props.model.consequences.length > 0}>
        <Chat.Preview.Lines label={t().changes}>
          <For each={props.model.consequences}>
            {(line) => (
              <Chat.Preview.Line icon={markIcon(line.mark)} mark={line.mark}>
                <ActionTextView text={line.text} accent={props.card.app.accent} />
              </Chat.Preview.Line>
            )}
          </For>
        </Chat.Preview.Lines>
      </Show>
    </Chat.Preview>
  );
}

function LegacyPreview(props: { model: Extract<ActionPreviewModel, { kind: "legacy" }>; card: ActionCard; timeZone: string }) {
  const t = () => actionMessages(props.card.locale);
  const [inputOpen, setInputOpen] = createSignal(false);
  const value = (row: { value: string; format?: "date" | "date-time" }) =>
    row.format ? formatWhen(row.value, props.card.locale, props.timeZone, row.format === "date-time") : row.value;
  const input = () => (isStructuredDataValue(props.model.input) ? props.model.input : undefined);
  return (
    <Chat.Preview class="cloud-action-preview--legacy">
      <Show when={props.model.rows.length > 0}>
        <Chat.Preview.Header
          rows={props.model.rows.map((row) => ({
            label: row.label,
            value: row.format ? (
              <time dateTime={row.value}>{value(row)}</time>
            ) : (
              <span class="cloud-action-preview__value">{value(row)}</span>
            ),
          }))}
        />
      </Show>
      <Show when={props.model.markdown}>
        {(markdown) => (
          <MarkdownView class="cloud-action-preview__markdown" markdown={markdown()} headingScale="compact" allowImages={false} />
        )}
      </Show>
      <Show when={props.model.input !== undefined}>
        <div class="cloud-action-preview__input">
          <Button variant="text" size="sm" aria-expanded={inputOpen()} onClick={() => setInputOpen((open) => !open)}>
            {inputOpen() ? t().hideInput : t().showInput}
          </Button>
          <Show when={inputOpen()}>
            <div role="region" aria-label={t().input}>
              <Show when={input()} fallback={<pre class="cloud-action-preview__raw">{JSON.stringify(props.model.input, null, 2)}</pre>}>
                {(data) => <StructuredDataPreview data={data()} class="w-full" />}
              </Show>
            </div>
          </Show>
        </div>
      </Show>
      <Show when={props.card.readMore}>
        {(href) => (
          <Chat.Preview.ReadMore href={href()} title={t().readMoreTitle}>
            {t().readMore}
          </Chat.Preview.ReadMore>
        )}
      </Show>
    </Chat.Preview>
  );
}

/** The thing the question is about, from its review, or an old review's rows and Markdown. */
export function ActionPreview(props: { card: ActionCard; timeZone: string }) {
  return (
    <>
      <Show when={props.card.preview}>
        {(model) => (
          <Switch>
            <Match when={model().kind === "review" ? (model() as Extract<ActionPreviewModel, { kind: "review" }>) : undefined}>
              {(review) => <ReviewPreviewBody model={review()} card={props.card} readMore={props.card.readMore} />}
            </Match>
            <Match when={model().kind === "legacy" ? (model() as Extract<ActionPreviewModel, { kind: "legacy" }>) : undefined}>
              {(legacy) => <LegacyPreview model={legacy()} card={props.card} timeZone={props.timeZone} />}
            </Match>
          </Switch>
        )}
      </Show>
      {/* The review's other links, such as editing the draft, stay one quiet click away before the answer. */}
      <Show when={props.card.links.length > 0 || (!props.card.preview && props.card.readMore)}>
        <Chat.Preview class="cloud-action-preview__links">
          <Show when={!props.card.preview && props.card.readMore}>
            {(href) => (
              <Chat.Preview.ReadMore href={href()} title={actionMessages(props.card.locale).readMoreTitle}>
                {actionMessages(props.card.locale).readMore}
              </Chat.Preview.ReadMore>
            )}
          </Show>
          <For each={props.card.links}>{(link) => <Chat.Preview.ReadMore href={link.href}>{link.label}</Chat.Preview.ReadMore>}</For>
        </Chat.Preview>
      </Show>
    </>
  );
}

// ---------------------------------------------------------------------------
// Outcome and question
// ---------------------------------------------------------------------------

/** One outcome line: what happened, in the card's sentence, with Cloud's detail under it. */
export type ActionLine = Omit<ChatOutcomeLine, "text" | "detail"> & { text: ActionText; detail?: JSX.Element };

/**
 * The outcome line of one call. Pass every line one flow can reach (running and done, or the lines of a check): they
 * share one cell, so switching between them moves nothing.
 */
export function ActionReceipt(props: {
  card: ActionCard;
  lines: Readonly<Record<string, ActionLine>>;
  current: string;
  class?: string;
  anchorId?: string | number;
}) {
  const lines = createMemo(() =>
    Object.fromEntries(
      Object.entries(props.lines).map(([key, line]) => [
        key,
        { ...line, text: <ActionTextView text={line.text} accent={props.card.app.accent} /> } satisfies ChatOutcomeLine,
      ]),
    ),
  );
  return (
    <LocaleProvider locale={props.card.locale}>
      <Chat.Outcome class={`cloud-action-outcome ${props.class ?? ""}`} lines={lines()} current={props.current} anchorId={props.anchorId} />
    </LocaleProvider>
  );
}

export type ActionQuestionProps = {
  card: ActionCard;
  /** `open` shows the question; every other state shows `outcome` in its place. */
  state: ChatDecisionState;
  /** Usually `ActionReceipt`. */
  outcome: JSX.Element;
  timeZone: string;
  onConfirm: () => void | Promise<void>;
  onDecline: () => void | Promise<void>;
  /** The quiet third answer, where remembering for this chat exists. */
  remember?: { label: string; onSelect: () => void | Promise<void> };
  /** Turns the confirming answers off; this reason replaces the asking reason in its place. */
  unavailable?: string;
  anchorId?: string | number;
  class?: string;
};

const confirmIcon = (card: ActionCard): string | undefined =>
  card.reason.code === "sends" ? "ti ti-send" : card.confirm.variant === "danger" ? "ti ti-trash" : undefined;

/** One Assistant question in card v4. An answer collapses it at once to its outcome line, which takes the focus. */
export function ActionQuestion(props: ActionQuestionProps) {
  return (
    <LocaleProvider locale={props.card.locale}>
      <Chat.Decision
        class={`cloud-action-question ${props.class ?? ""}`}
        state={props.state}
        anchorId={props.anchorId}
        sentence={<ActionTextView text={props.card.question} accent={props.card.app.accent} />}
        reason={{ text: props.card.reason.text, icon: props.card.reason.icon, tone: props.card.reason.tone }}
        unavailable={props.unavailable ? { text: props.unavailable, icon: "ti ti-player-pause", tone: "neutral" } : undefined}
        preview={<ActionPreview card={props.card} timeZone={props.timeZone} />}
        confirm={{
          label: props.card.confirm.label,
          variant: props.card.confirm.variant,
          icon: confirmIcon(props.card),
          onSelect: props.onConfirm,
        }}
        decline={{ label: props.card.decline, onSelect: props.onDecline }}
        remember={props.remember}
        outcome={props.outcome}
      />
    </LocaleProvider>
  );
}
