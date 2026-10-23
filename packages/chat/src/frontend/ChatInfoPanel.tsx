import { isManagerEntry } from "@k2b/cloud/access/ui";
import {
  Button,
  DetailPanel,
  Dropdown,
  type DropdownItem,
  IconButton,
  InlineGuidance,
  prompts,
  SelectChip,
  TextInput,
  Tooltip,
  toast,
} from "@k2b/ui";
import { createEffect, createSignal, For, type JSX, on, onCleanup, Show } from "solid-js";
import { createStore, produce, reconcile } from "solid-js/store";
import type { z } from "zod";
import type { MemberSchema, PermissionSchema } from "../service/contracts";
import { type ChatDialogStore, type Conversation, errorMessage, useChatMessages } from "./chat-dialog";
import { MemberAvatar } from "./MemberPicker";

type Member = z.infer<typeof MemberSchema>;
type Permission = z.infer<typeof PermissionSchema>;
const SEARCH_DELAY_MS = 250;
/** `groupSize` stops counting here; the server answers 501 for "more than 500". */
const GROUP_COUNT_LIMIT = 500;

/**
 * The chat's info beside the history, or its own page on a phone: the purpose and the members, a page of 100 at a
 * time and searchable on the server. Managers change permissions and remove members by the permission editor's rules;
 * the server decides every change again.
 */
export default function ChatInfoPanel(props: {
  conversation: Conversation;
  viewerId: string;
  /** Members load only while the panel shows. */
  active: boolean;
  /** Changes when the membership changed, by the viewer or through a live membership message, preserving the number of loaded rows. */
  revision: number;
  store: ChatDialogStore | undefined;
  onClose: () => void;
  onAddPeople: () => void;
  onEditDetails: () => void;
  /** For admins: "New thread", also where the chat has none yet. */
  onCreateThread?: () => void;
  /** What the chat shared, below its members. */
  shared?: JSX.Element;
  onLeave: () => void;
}): JSX.Element {
  const t = useChatMessages();
  const [input, setInput] = createSignal("");
  const [query, setQuery] = createSignal("");
  const [rows, setRows] = createStore<Member[]>([]);
  const [managers, setManagers] = createSignal(0);
  const [cursor, setCursor] = createSignal<string | null>(null);
  const [status, setStatus] = createSignal<"loading" | "ready" | "error">("loading");
  const [loadingMore, setLoadingMore] = createSignal(false);
  const [moreFailed, setMoreFailed] = createSignal(false);
  const [changing, setChanging] = createSignal(false);
  const manager = () => props.conversation.permission === "admin";
  let list: HTMLUListElement | undefined;
  let retryMore: HTMLButtonElement | undefined;
  let request = 0;

  const read = (after?: string) =>
    props.store?.members(props.conversation.id, { ...(query() ? { q: query() } : {}), ...(after ? { cursor: after } : {}) });
  const load = async (preserveDepth = false) => {
    const depth = preserveDepth ? rows.length : 0;
    const mine = ++request;
    setStatus("loading");
    // A page of the previous list no longer belongs here; its answer is dropped.
    setLoadingMore(false);
    setMoreFailed(false);
    try {
      let page = await read();
      if (!page || mine !== request) return;
      const items = [...page.items];
      while (items.length < depth && page.nextCursor) {
        page = await read(page.nextCursor);
        if (!page || mine !== request) return;
        items.push(...page.items);
      }
      setRows(reconcile(items, { key: "accessId" }));
      setManagers(page.managers);
      setCursor(page.nextCursor);
      setStatus("ready");
    } catch {
      if (mine === request) setStatus("error");
    }
  };
  const more = async () => {
    const after = cursor();
    if (!after || status() !== "ready" || loadingMore()) return;
    const mine = request;
    const retry = moreFailed();
    setLoadingMore(true);
    try {
      const page = await read(after);
      if (!page || mine !== request) return;
      setRows(produce((current) => current.push(...page.items)));
      setManagers(page.managers);
      setCursor(page.nextCursor);
      setMoreFailed(false);
    } catch {
      // The failure stays where the next page would have come, with its retry.
      if (mine === request) setMoreFailed(true);
    } finally {
      if (mine === request) setLoadingMore(false);
    }
    if (mine !== request) return;
    // The button leaves after the last page, and the retry after it worked; reading goes on in the list. A failure
    // takes the button's place, so focus moves to its retry.
    if (moreFailed()) {
      if (!document.activeElement || document.activeElement === document.body) retryMore?.focus();
    } else if ((!cursor() || retry) && list?.contains(document.activeElement) === false) list.focus();
  };
  createEffect(
    on(input, (value) => {
      const timer = setTimeout(() => setQuery(value.trim()), SEARCH_DELAY_MS);
      onCleanup(() => clearTimeout(timer));
    }),
  );
  createEffect(
    on([() => props.active, () => props.store, query, () => props.revision], ([active, store, q], previous) => {
      // Only a new search starts again from the first page; a membership change or a return to the panel keeps the
      // rows the reader loaded.
      if (active && store) void load(!!previous && previous[1] === store && previous[2] === q && rows.length > 0);
    }),
  );

  /**
   * A change keeps the list as it is: the row updates in place, and only the manager count is read again. The change
   * is already saved, so a failed count is not reported as a failed change; the next membership message reads it again.
   */
  const recount = async () => {
    const page = await props.store?.members(props.conversation.id, {}).catch(() => undefined);
    if (page) setManagers(page.managers);
  };
  const changePermission = async (member: Member, permission: Permission) => {
    const store = props.store;
    if (!store || changing() || member.permission === permission) return;
    setChanging(true);
    try {
      await store.updateMember(props.conversation.id, member.accessId, permission);
      setRows((row) => row.accessId === member.accessId, "permission", permission);
      await recount();
    } catch (failure) {
      toast.error(errorMessage(failure, t().requestFailed));
    } finally {
      setChanging(false);
    }
  };
  const remove = async (member: Member) => {
    const store = props.store;
    if (!store || changing()) return;
    const confirmed = await prompts.confirm(t().removeMemberDescription, {
      title: t().removeMemberTitle({ name: member.displayName }),
      icon: "ti ti-user-minus",
      confirmText: t().remove,
      variant: "danger",
    });
    if (!confirmed) return;
    setChanging(true);
    try {
      const result = await store.removeMember(props.conversation.id, member.accessId);
      if (result.keptThroughGroup) toast(t().removedKeptThroughGroup({ name: member.displayName }));
      setRows((current) => current.filter((row) => row.accessId !== member.accessId));
      list?.focus();
      await recount();
    } catch (failure) {
      toast.error(errorMessage(failure, t().requestFailed));
    } finally {
      setChanging(false);
    }
  };

  // The chat's own commands sit in the header: below a member list that loads, they would move.
  const commands = (): DropdownItem[] => [
    ...(props.conversation.permission !== "read" ? [{ label: t().editDetails, icon: "ti ti-pencil", action: props.onEditDetails }] : []),
    ...(props.onCreateThread
      ? [{ label: t().newThread, icon: "ti ti-hash", description: t().newThreadHint, action: props.onCreateThread }]
      : []),
    // Alone in a chat there is nobody to leave it to.
    ...(props.conversation.memberCount > 1
      ? [{ label: t().leaveChat, icon: "ti ti-logout", variant: "danger" as const, action: props.onLeave }]
      : []),
  ];

  return (
    <DetailPanel>
      <DetailPanel.Header
        icon={props.conversation.icon ?? (props.conversation.memberCount <= 2 ? "ti ti-user" : "ti ti-users")}
        title={props.conversation.title}
        subtitle={t().members({ count: props.conversation.memberCount })}
        actions={
          <>
            <Show when={commands().length > 0}>
              <Dropdown.Root position="bottom-right" items={commands()}>
                <Dropdown.Trigger
                  iconOnly
                  label={t().chatActions({ title: props.conversation.title })}
                  tooltip={t().chatActions({ title: props.conversation.title })}
                  size="sm"
                  variant="ghost"
                >
                  <i class="ti ti-dots" aria-hidden="true" />
                </Dropdown.Trigger>
              </Dropdown.Root>
            </Show>
            <IconButton label={t().closeChatInfo} size="sm" variant="ghost" onClick={props.onClose}>
              <i class="ti ti-x" aria-hidden="true" />
            </IconButton>
          </>
        }
        primaryActions={
          manager() ? (
            <Button size="sm" variant="secondary" onClick={props.onAddPeople}>
              <i class="ti ti-user-plus" aria-hidden="true" />
              {t().addPeople}
            </Button>
          ) : undefined
        }
      />
      <DetailPanel.Body scrollPreserveKey={`chat-info-${props.conversation.id}`}>
        <DetailPanel.Section icon="ti ti-target-arrow" title={t().purpose}>
          <Show when={props.conversation.purpose} fallback={<p class="text-sm text-dimmed">{t().noPurpose}</p>}>
            {(purpose) => <p class="chat-info__purpose">{purpose()}</p>}
          </Show>
        </DetailPanel.Section>
        <DetailPanel.Section icon="ti ti-users" title={t().membersTitle}>
          <div class="flex flex-col gap-2" aria-busy={status() === "loading"}>
            <TextInput
              type="search"
              aria-label={t().searchMembers}
              placeholder={t().searchMembers}
              icon="ti ti-search"
              maxLength={100}
              value={input}
              onValueChange={setInput}
            />
            <Show when={status() === "error"}>
              <InlineGuidance tone="danger" icon="ti ti-alert-circle" role="alert">
                {t().membersFailed}{" "}
                <Button variant="text" size="xs" onClick={() => void load()}>
                  {t().retry}
                </Button>
              </InlineGuidance>
            </Show>
            <Show when={status() === "loading" && rows.length === 0}>
              <InlineGuidance loading>{t().membersLoading}</InlineGuidance>
            </Show>
            <Show when={status() === "ready" && rows.length === 0 && query()}>
              <p class="text-sm text-dimmed">{t().noMemberMatches({ q: query() })}</p>
            </Show>
            <ul ref={list} tabindex="-1" aria-label={t().membersTitle} class="flex flex-col outline-none">
              <For each={rows}>
                {(member) => (
                  <ChatMemberRow
                    member={member}
                    own={member.principal.type === "user" && member.principal.userId === props.viewerId}
                    manager={manager()}
                    locked={member.principal.type === "user" && !member.deactivated && managers() === 1 && isManagerEntry(member)}
                    disabled={changing()}
                    onPermission={(permission) => void changePermission(member, permission)}
                    onRemove={() => void remove(member)}
                  />
                )}
              </For>
            </ul>
            <Show when={cursor()}>
              <Show
                when={moreFailed()}
                fallback={
                  <Button
                    variant="text"
                    size="xs"
                    class="self-start"
                    loading={loadingMore()}
                    disabled={status() !== "ready"}
                    onClick={() => void more()}
                  >
                    {t().showMoreMembers}
                  </Button>
                }
              >
                <InlineGuidance tone="danger" icon="ti ti-alert-circle" role="alert">
                  {t().membersFailed}{" "}
                  <Button ref={retryMore} variant="text" size="xs" loading={loadingMore()} onClick={() => void more()}>
                    {t().retry}
                  </Button>
                </InlineGuidance>
              </Show>
            </Show>
          </div>
        </DetailPanel.Section>
        {/* Below the members, it waits for their first page, so their arrival never pushes it down. */}
        <Show when={status() !== "loading" || rows.length > 0}>{props.shared}</Show>
      </DetailPanel.Body>
    </DetailPanel>
  );
}

const LEVELS: readonly { value: Permission; icon: string }[] = [
  { value: "read", icon: "ti ti-eye" },
  { value: "write", icon: "ti ti-pencil" },
  { value: "admin", icon: "ti ti-shield" },
];

/**
 * One member like a permission editor row: avatar, name, quiet markers, the permission, and removal for managers. The
 * last manager's row keeps its level and cannot be removed, with the reason on the disabled controls.
 */
export function ChatMemberRow(props: {
  member: Member;
  own: boolean;
  manager: boolean;
  locked: boolean;
  disabled: boolean;
  onPermission: (permission: Permission) => void;
  onRemove: () => void;
}): JSX.Element {
  const t = useChatMessages();
  const label = (permission: Permission) =>
    permission === "read" ? t().permissionRead : permission === "write" ? t().permissionWrite : t().permissionManage;
  const level = () => LEVELS.find((option) => option.value === props.member.permission) ?? LEVELS[1]!;
  const size = (count: number) => (count > GROUP_COUNT_LIMIT ? t().largeGroup : t().groupPeople({ count }));
  const markers = () =>
    [
      props.own ? t().ownMember : null,
      props.member.guest ? t().guestMember : null,
      props.member.deactivated ? t().deactivatedMember : null,
      props.member.groupSize === null ? null : size(props.member.groupSize),
    ].filter((marker) => marker !== null);
  // Groups always write; only a direct person's level changes.
  const editable = () => props.manager && props.member.principal.type === "user";
  return (
    <li class="chat-member-row">
      <MemberAvatar principal={props.member.principal} displayName={props.member.displayName} avatarHash={props.member.avatarHash} />
      <span class="chat-member-row__name">
        <span class="truncate text-sm">{props.member.displayName}</span>
        <Show when={markers().length > 0}>
          <span class="truncate text-xs text-dimmed">{markers().join(" · ")}</span>
        </Show>
      </span>
      <Show
        when={editable()}
        fallback={
          <span class="flex min-h-7 shrink-0 items-center gap-1 rounded-full bg-[var(--ui-surface-muted)] px-2.5 py-1 text-xs text-secondary">
            <i class={level().icon} aria-hidden="true" />
            {label(level().value)}
          </span>
        }
      >
        <SelectChip
          aria-label={t().permissionFor({ name: props.member.displayName })}
          value={() => props.member.permission}
          icon={level().icon}
          size="xs"
          position="bottom-left"
          disabled={props.disabled}
          options={LEVELS.map((option) => {
            const kept = props.locked && option.value !== "admin";
            return {
              value: option.value,
              label: label(option.value),
              icon: option.icon,
              disabled: kept,
              description: kept ? t().lastManager : undefined,
            };
          })}
          onValueChange={props.onPermission}
        />
      </Show>
      <Show when={props.manager}>
        {/* Your own row has no remove button, but keeps its place so every level lines up. */}
        <span class="chat-member-row__remove-slot">
          <Show when={!props.own}>
            <Tooltip.Anchor
              content={props.locked ? t().lastManager : t().removeName({ name: props.member.displayName })}
              class="chat-member-row__remove"
            >
              <IconButton
                label={t().removeName({ name: props.member.displayName })}
                size="xs"
                variant="ghost"
                tooltip={false}
                disabled={props.disabled || props.locked}
                // A disabled button takes no focus and touch has no hover, so the reason reaches assistive technology too.
                aria-description={props.locked ? t().lastManager : undefined}
                onClick={props.onRemove}
              >
                <i class="ti ti-x" aria-hidden="true" />
              </IconButton>
            </Tooltip.Anchor>
          </Show>
        </span>
      </Show>
    </li>
  );
}
