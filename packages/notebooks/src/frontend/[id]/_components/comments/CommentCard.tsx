import { CloudAvatar } from "@k2b/cloud/account/ui";
import { Button, Dropdown, type DropdownItem, Format, IconButton, TextInput, toast } from "@k2b/ui";
import { createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js";
import type { Annotation } from "../../../../lib/annotation-contracts";
import { type CommentsUi, isOpen, MUTATION_WINDOW_MS } from "./comments-ui";

type Person = Annotation["author"];

const Who = (props: { ui: CommentsUi; person: Person; at: string; via: Annotation["via"]; actions?: JSX.Element }) => {
  const t = () => props.ui.t();
  const mine = () => props.person.kind === "user" && props.person.id === props.ui.me.id;
  return (
    <div class="notebook-comment__who">
      <CloudAvatar
        username={props.person.name}
        userId={props.person.id}
        avatarHash={props.person.avatarHash ?? null}
        kind={props.person.kind}
        size="xs"
      />
      <b>{mine() ? t().you : props.person.name}</b>
      <Format.RelativeTime class="notebook-comment__time" value={props.at} />
      <Show when={props.via}>
        {(via) => <span class="notebook-comment__time">· {via() === "assistant" ? t().viaAssistant : t().viaMcp}</span>}
      </Show>
      {props.actions}
    </div>
  );
};

/** Minutes left to change a comment, counted down while the card shows it. */
const useMinutesLeft = (createdAt: string) => {
  const left = () => Math.ceil((new Date(createdAt).getTime() + MUTATION_WINDOW_MS - Date.now()) / 60_000);
  const [minutes, setMinutes] = createSignal(left());
  const timer = setInterval(() => setMinutes(left()), 15_000);
  onCleanup(() => clearInterval(timer));
  return minutes;
};

const EditBox = (props: { ui: CommentsUi; item: Annotation }) => {
  const t = () => props.ui.t();
  const [text, setText] = createSignal(props.item.body);
  const [saving, setSaving] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  const minutes = useMinutesLeft(props.item.createdAt);
  const save = async () => {
    if (saving() || !text().trim()) return;
    setSaving(true);
    setFailed(false);
    try {
      await props.ui.edit(props.item, text());
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };
  let box!: HTMLDivElement;
  onMount(() => box.querySelector("textarea")?.focus());
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the field inside takes the keys; the wrapper adds ⌘↵ and Escape.
    <div
      ref={box}
      class="notebook-comment__compose"
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
          event.preventDefault();
          void save();
        }
        if (event.key === "Escape") {
          event.stopPropagation();
          props.ui.setEditing(null);
        }
      }}
    >
      <TextInput icon={false} multiline lines={2} aria-label={t().edit} value={text()} onValueChange={setText} />
      <Show when={failed()}>
        <p class="notebook-comment__error" role="alert">
          {t().notSaved}
        </p>
      </Show>
      <div class="notebook-comment__row">
        <span class="notebook-comment__hint">{t().editable({ minutes: minutes() })}</span>
        <Button size="sm" variant="ghost" onClick={() => props.ui.setEditing(null)}>
          {t().cancel}
        </Button>
        <Button size="sm" loading={saving()} disabled={!text().trim() || minutes() <= 0} onClick={() => void save()}>
          {t().save}
        </Button>
      </div>
    </div>
  );
};

const ReplyBox = (props: { ui: CommentsUi; item: Annotation }) => {
  const t = () => props.ui.t();
  const [text, setText] = createSignal("");
  const [sending, setSending] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  let key = crypto.randomUUID();
  const send = async () => {
    if (sending() || !text().trim()) return;
    setSending(true);
    setFailed(false);
    try {
      await props.ui.reply(props.item, text(), key);
      setText("");
      key = crypto.randomUUID();
    } catch {
      setFailed(true);
    } finally {
      setSending(false);
    }
  };
  return (
    <div class="notebook-comment__reply">
      <TextInput
        icon={false}
        multiline
        lines={1}
        aria-label={t().replyLabel}
        placeholder={t().reply}
        value={text()}
        disabled={sending()}
        onValueChange={(value: string) => {
          setText(value);
          setFailed(false);
        }}
        onSubmit={() => void send()}
      />
      <Show when={failed()}>
        <p class="notebook-comment__error" role="alert">
          {t().notSaved}
        </p>
      </Show>
    </div>
  );
};

/** A suggestion as the card shows it: the old passage struck through, the new text after it. */
export const SuggestionDiff = (props: { from: string; to: string }) => (
  <>
    <Show when={props.from}>
      <del class="notebook-comment__del">{props.from}</del>{" "}
    </Show>
    <Show when={props.to}>
      <ins class="notebook-comment__ins">{props.to}</ins>
    </Show>
  </>
);

/**
 * One comment in the margin, a popover or a sheet. Closed, it shows the author, the first lines and the number of
 * replies; open, everything with its actions. People who may only read see no actions.
 */
export function CommentCard(props: { ui: CommentsUi; item: Annotation; ref?: (element: HTMLElement) => void; style?: JSX.CSSProperties }) {
  const t = () => props.ui.t();
  const item = () => props.item;
  const active = () => props.ui.active() === item().id;
  const resolved = () => !isOpen(item());
  const writer = () => props.ui.canWrite();
  // Replies after the first page load on request and stay while the comment reloads.
  const [more, setMore] = createSignal<{ items: Annotation["replies"]; cursor: string | null } | null>(null);
  const [loadingMore, setLoadingMore] = createSignal(false);
  const replies = () => {
    const first = item().replies;
    const seen = new Set(first.map((reply) => reply.id));
    return [...first, ...(more()?.items.filter((reply) => !seen.has(reply.id)) ?? [])];
  };
  const moreCursor = () => (more() ? more()!.cursor : item().repliesNextCursor);
  const loadMore = async (cursor: string) => {
    setLoadingMore(true);
    try {
      const page = await props.ui.store.replies(item().id, cursor);
      setMore((previous) => ({ items: [...(previous?.items ?? []), ...page.items], cursor: page.nextCursor }));
    } catch {
      toast.error(t().actionFailed);
    } finally {
      setLoadingMore(false);
    }
  };
  const mine = () => item().author.kind === "user" && item().author.id === props.ui.me.id;
  const stateBy = () => {
    const by = item().stateBy;
    if (!by) return "";
    return by.kind === "user" && by.id === props.ui.me.id ? t().byYou : by.name;
  };
  const menu = (): DropdownItem[] => [
    ...(item().canEdit ? [{ label: t().edit, icon: "ti ti-pencil", action: () => props.ui.setEditing(item().id) }] : []),
    { label: t().copyLink, icon: "ti ti-link", immediate: true, action: () => void props.ui.copyLink(item()) },
    ...(item().canDelete && !item().replies.length
      ? [{ label: t().delete, icon: "ti ti-trash", variant: "danger" as const, action: () => void props.ui.remove(item()) }]
      : []),
  ];
  const label = () =>
    item().orphan ? t().deletedPassage({ name: item().author.name }) : t().commentBy({ name: mine() ? t().you : item().author.name });

  return (
    <article
      ref={props.ref}
      class="notebook-comment"
      data-annotation-card={item().id}
      data-active={active() ? "" : undefined}
      data-hover={props.ui.hover() === item().id && !active() ? "" : undefined}
      data-resolved={resolved() ? "" : undefined}
      style={props.style}
      tabIndex={0}
      aria-label={label()}
      onMouseEnter={() => props.ui.setHover(item().id)}
      onMouseLeave={() => props.ui.setHover(null)}
      onClick={(event) => {
        if (!active() && !(event.target as Element).closest("button, a, textarea, input")) props.ui.setActive(item().id);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" && event.target === event.currentTarget) props.ui.setActive(item().id);
      }}
    >
      <Who
        ui={props.ui}
        person={item().author}
        at={item().createdAt}
        via={item().via}
        actions={
          <Show when={writer() && !resolved()}>
            <span class="notebook-comment__actions">
              <IconButton
                size="sm"
                variant="ghost"
                label={t().resolve}
                loading={props.ui.busy().has(item().id)}
                onClick={() => void props.ui.resolve(item(), true)}
              >
                <i class="ti ti-check" aria-hidden="true" />
              </IconButton>
              <Dropdown.Root items={menu()} align="end" label={t().moreActions} phone="sheet">
                <Dropdown.Trigger iconOnly size="sm" variant="ghost" label={t().moreActions}>
                  <i class="ti ti-dots" aria-hidden="true" />
                </Dropdown.Trigger>
              </Dropdown.Root>
            </span>
          </Show>
        }
      />
      <Show when={item().orphan}>
        <p class="notebook-comment__orphan">
          {t().orphan} <s>„{item().quote}“</s>
        </p>
      </Show>
      <Show
        when={props.ui.editing() === item().id && item().canEdit}
        fallback={
          <Show when={item().body}>
            <p class="notebook-comment__text">
              {item().body}
              <Show when={item().editedAt}>
                {" "}
                <span class="notebook-comment__edited">{t().edited}</span>
              </Show>
            </p>
          </Show>
        }
      >
        <EditBox ui={props.ui} item={item()} />
      </Show>
      <Show when={item().suggestion !== null && item().state !== "accepted"}>
        <div class="notebook-comment__suggestion">
          <span class="notebook-comment__label">{t().suggestion}</span>
          <SuggestionDiff from={item().quote} to={item().suggestion ?? ""} />
        </div>
      </Show>
      <Show when={resolved()}>
        <p class="notebook-comment__state">
          <i class="ti ti-check" aria-hidden="true" />
          {item().state === "accepted" ? t().acceptedBy({ name: stateBy() }) : t().resolvedBy({ name: stateBy() })}
          <Show when={writer() && item().state === "resolved"}>
            {" · "}
            <button type="button" class="notebook-comment__link" onClick={() => void props.ui.resolve(item(), false)}>
              {t().reopen}
            </button>
          </Show>
        </p>
      </Show>
      <Show
        when={active() && !resolved()}
        fallback={
          <Show when={item().replies.length && !resolved()}>
            <p class="notebook-comment__more">{t().replies({ count: item().replies.length })}</p>
          </Show>
        }
      >
        <Show when={item().suggestion !== null && writer()}>
          <div class="notebook-comment__row">
            <Button
              size="sm"
              loading={props.ui.busy().has(item().id)}
              onMouseEnter={() => props.ui.setPreview(item().id)}
              onMouseLeave={() => props.ui.setPreview(null)}
              onFocus={() => props.ui.setPreview(item().id)}
              onBlur={() => props.ui.setPreview(null)}
              onClick={() => void props.ui.accept(item())}
            >
              {t().accept}
            </Button>
            <span class="notebook-comment__hint">{t().acceptHint}</span>
          </div>
        </Show>
        <Show when={replies().length}>
          <ul class="notebook-comment__replies">
            <For each={replies()}>
              {(reply) => (
                <li>
                  <Who ui={props.ui} person={reply.author} at={reply.createdAt} via={reply.via} />
                  <p class="notebook-comment__text">
                    {reply.body}
                    <Show when={reply.editedAt}>
                      {" "}
                      <span class="notebook-comment__edited">{t().edited}</span>
                    </Show>
                  </p>
                </li>
              )}
            </For>
          </ul>
        </Show>
        <Show when={moreCursor()}>
          {(cursor) => (
            <Button size="sm" variant="ghost" loading={loadingMore()} onClick={() => void loadMore(cursor())}>
              {t().moreReplies}
            </Button>
          )}
        </Show>
        <Show when={writer()}>
          <ReplyBox ui={props.ui} item={item()} />
        </Show>
      </Show>
    </article>
  );
}
