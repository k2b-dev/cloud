import { isManagerEntry } from "@k2b/cloud/access/ui";
import { cloudAvatarImage } from "@k2b/cloud/account/ui";
import {
  Band,
  Bar,
  Choice,
  Empty,
  Failed,
  Field,
  Inline,
  Input,
  List,
  Loading,
  Menu,
  type MenuEntry,
  Notice,
  Row,
  Section,
  Text,
} from "@k2b/ui/v2";
import { For, type JSX, Show } from "solid-js";
import type { z } from "zod";
import type { MemberSchema, PermissionSchema, SharedItem } from "../../service/contracts";
import { type ChatInfoPanelProps, createMemberList } from "../ChatInfoPanel";
import { type ChatNotificationSettingsProps, createNotificationChoice, NOTIFICATION_SETTINGS_HREF } from "../ChatNotificationSettings";
import { type ChatSharedSectionProps, createSharedList, SHARED_KINDS, sharedRowView } from "../ChatSharedSection";

type Member = z.infer<typeof MemberSchema>;
type Permission = z.infer<typeof PermissionSchema>;
/** `groupSize` stops counting here; the server answers 501 for "more than 500". */
const GROUP_COUNT_LIMIT = 500;
/** The longest member search the server takes. */
const SEARCH_MAX = 100;

/**
 * The chat's level of notifications on v2: three levels as one choice, what the chosen one means under it, the
 * duration of "Off", and where Cloud keeps browser, email and quiet hours. A choice saves at once; a failed save says so
 * with its retry, and a browser that blocks notifications says so too.
 */
function NotificationsV2(props: ChatNotificationSettingsProps): JSX.Element {
  const choice = createNotificationChoice(props);
  const t = choice.t;
  const levels = ["all", "mentions", "none"] as const;
  return (
    <Band label={t().notificationsLabel}>
      <Field
        label={t().notificationsLabel}
        hint={choice.description(choice.value())}
        action={{ label: t().notificationsSettingsLink, icon: "settings", href: NOTIFICATION_SETTINGS_HREF }}
      >
        <Choice
          name="chat-notifications"
          value={choice.value()}
          disabled={choice.pending() !== null}
          options={levels.map((level) => ({
            value: level,
            label:
              props.notifications.defaultLevel === level ? `${choice.label(level)} · ${t().notificationsDefault}` : choice.label(level),
          }))}
          onChange={(level) => choice.choose(levels.find((entry) => entry === level) ?? "all")}
        />
      </Field>
      <Show when={choice.value() === "none"}>
        <Field
          label={t().muteForLabel}
          hint={choice.pending() === null && props.notifications.level === "none" ? choice.untilSentence() : undefined}
        >
          <Choice
            name="chat-mute-for"
            value={choice.muteFor() ?? undefined}
            options={[
              { value: "1h", label: t().muteFor1h },
              { value: "8h", label: t().muteFor8h },
              { value: "1w", label: t().muteFor1w },
              { value: "forever", label: t().muteForever },
            ]}
            onChange={(duration) => {
              if (duration === "1h" || duration === "8h" || duration === "1w" || duration === "forever") choice.chooseDuration(duration);
            }}
          />
        </Field>
      </Show>
      <Show when={choice.failed()}>
        {(input) => (
          <Notice tone="bad" actions={[{ label: t().retry, onClick: () => choice.save(input()) }]}>
            {t().notificationsNotSaved({ level: choice.label(props.notifications.level) })}
          </Notice>
        )}
      </Show>
      <Show when={!choice.failed() && choice.blocked()}>
        <Notice tone="warn" icon="bell-off">
          {t().notificationsBlocked}
        </Notice>
      </Show>
      <Show when={props.notifications.following?.first ? props.notifications.following : null}>
        {(following) => <Text type="meta">{t().followingSummary({ name: following().first!.name, more: following().count - 1 })}</Text>}
      </Show>
    </Band>
  );
}

/** One shared item: its symbol, title and who shared it when; it jumps to its message. */
function SharedRowV2(props: { item: SharedItem; meta: string; cards: ChatSharedSectionProps["cards"]; onJump: () => void }): JSX.Element {
  const row = sharedRowView(props);
  return (
    <Row
      icon={row.icon().replace(/^ti ti-/, "")}
      lines={[
        row.title() || " ",
        row.unavailable()
          ? `${row.t().noAccess} · ${props.meta}`
          : row.view()?.status
            ? `${row.view()?.status} · ${props.meta}`
            : props.meta,
      ]}
      onOpen={props.onJump}
    />
  );
}

/**
 * What the chat shared on v2: the kind and, in a chat with threads, the thread as two choices, then the items newest
 * first, each jumping to its message. A failed read says so with "Try again"; more come a page at a time.
 */
function SharedV2(props: ChatSharedSectionProps): JSX.Element {
  const shared = createSharedList(props);
  const t = shared.t;
  return (
    <Section
      title={t().shared}
      more={
        shared.cursor() && !shared.incomplete()
          ? {
              label: t().showMoreShared,
              icon: "dots",
              disabled: shared.status() !== "ready" || shared.loadingMore(),
              onClick: () => shared.more(),
            }
          : undefined
      }
    >
      {/* k2b-ui gap (owner Z2): a v2 `Select` used only in this lazy page still moves its listbox behaviour through the `@k2b/ui/v2` barrel into the chunk every Chat page loads (+47 KB over Chat's v2 budget). The choice is a menu with a tick (menu behaviour is loaded already) until the barrel splits. */}
      <Bar
        start={
          <Inline>
            <Menu
              label={t().sharedKinds}
              items={[
                {
                  title: t().sharedKinds,
                  choice: shared.kind(),
                  onChoose: (value: string) => {
                    const chosen = SHARED_KINDS.find((entry) => entry.kind === value);
                    if (chosen) shared.setKind(chosen.kind);
                  },
                  items: SHARED_KINDS.map((entry) => ({ label: t()[entry.label], value: entry.kind })),
                },
              ]}
            >
              {t()[SHARED_KINDS.find((entry) => entry.kind === shared.kind())?.label ?? "sharedAll"]}
            </Menu>
            <Show when={(props.threads?.items.length ?? 0) > 0}>
              <Menu
                label={t().sharedThread}
                items={[
                  {
                    title: t().sharedThread,
                    choice: shared.thread(),
                    onChoose: (value: string) => shared.setThread(value || "all"),
                    items: shared.threadOptions().map((option) => ({ label: option.label, value: option.value })),
                  },
                ]}
              >
                {shared.threadOptions().find((option) => option.value === shared.thread())?.label ?? t().wholeChat}
              </Menu>
            </Show>
          </Inline>
        }
      />
      <Show when={shared.incomplete() && shared.status() === "ready"}>
        <Notice tone="warn" actions={[{ label: t().retry, onClick: () => shared.refresh() }]}>
          {t().discussionsIncomplete}
        </Notice>
      </Show>
      <Show when={shared.status() === "failed"}>
        <Failed text={t().sharedFailed} onRetry={() => shared.refresh()} />
      </Show>
      <Show when={shared.status() === "loading"}>
        <Loading rows={3} lines={2} />
      </Show>
      <Show when={shared.status() === "ready" && shared.items().length === 0 && !shared.incomplete()}>
        <Empty icon="share" text={shared.kind() === "all" && shared.thread() === "all" ? t().nothingShared : t().nothingForFilter} />
      </Show>
      <Show when={shared.status() !== "loading" && shared.items().length > 0}>
        {/* k2b-ui gap (DP Tiles media): images show as rows with a symbol until tiles can show a picture. */}
        <List label={t().shared}>
          <For each={shared.items()}>
            {(item) => <SharedRowV2 item={item} meta={shared.meta(item)} cards={props.cards} onJump={() => props.onJump(item)} />}
          </For>
        </List>
      </Show>
    </Section>
  );
}

/**
 * The chat's info on v2, beside the history or as its own page on a phone: what the chat is for, the reader's
 * notifications, the members (searchable, a page at a time; managers change levels and remove behind each row's "…"),
 * and what the chat shared. The chat's own deeds stand in the info's head.
 */
export default function ChatInfoV2(props: ChatInfoPanelProps): JSX.Element {
  const members = createMemberList(props);
  const t = members.t;
  const permissionLabel = (permission: Permission) =>
    permission === "read" ? t().permissionRead : permission === "write" ? t().permissionWrite : t().permissionManage;
  const markers = (member: Member) =>
    [
      member.principal.type === "user" && member.principal.userId === props.viewerId ? t().ownMember : null,
      member.guest ? t().guestMember : null,
      member.deactivated ? t().deactivatedMember : null,
      member.groupSize === null
        ? null
        : member.groupSize > GROUP_COUNT_LIMIT
          ? t().largeGroup
          : t().groupPeople({ count: member.groupSize }),
      member.serviceAccountKind
        ? member.serviceAccountKind === "agent" || member.serviceAccountKind === "standalone"
          ? t().agentAccount
          : member.serviceAccountKind === "resource_bound"
            ? t().resourceAccount
            : member.serviceAccountKind === "code"
              ? t().codeAccount
              : t().delegatedAccount
        : null,
      // A code account acts with the authority of the code that runs it, as v1 says under its name.
      member.serviceAccountKind === "code" ? t().codeAuthority : null,
      permissionLabel(member.permission),
    ].filter((marker) => marker !== null);
  const memberMenu = (member: Member): readonly MenuEntry[] => {
    if (!members.manager()) return [];
    const own = member.principal.type === "user" && member.principal.userId === props.viewerId;
    const locked = member.principal.type !== "group" && !member.deactivated && members.managers() === 1 && isManagerEntry(member);
    // Groups always write; only a direct person's level changes.
    const levels: Permission[] = member.principal.type === "group" ? [] : ["read", "write", "admin"];
    return [
      ...(levels.length
        ? [
            {
              title: t().permissionFor({ name: member.displayName }),
              choice: member.permission,
              onChoose: (value: string) => {
                const level = levels.find((entry) => entry === value);
                if (level) void members.changePermission(member, level);
              },
              items: levels
                .filter((level) => member.serviceAccountKind !== "code" || level !== "admin")
                .map((level) => ({
                  label: permissionLabel(level),
                  value: level,
                  disabled: members.changing() || (locked && level !== "admin"),
                  meta: locked && level !== "admin" ? t().lastManager : undefined,
                })),
            } satisfies MenuEntry,
          ]
        : []),
      ...(own
        ? []
        : [
            {
              label: t().removeName({ name: member.displayName }),
              icon: "user-minus",
              danger: true,
              disabled: members.changing() || locked,
              meta: locked ? t().lastManager : undefined,
              onClick: () => void members.remove(member),
            } satisfies MenuEntry,
          ]),
    ];
  };
  return (
    <>
      <Show
        when={!members.system()}
        fallback={
          <Band label={t().membersTitle}>
            <Text>
              {t().systemMembers}. {t().systemAccessHint}
            </Text>
          </Band>
        }
      >
        <Band label={t().purpose}>
          <Text type="meta">{t().purpose}</Text>
          <Text>{props.conversation.purpose || t().noPurpose}</Text>
        </Band>
      </Show>
      <Show when={props.notificationProps}>{(notifications) => <NotificationsV2 {...notifications()} />}</Show>
      <Show when={!members.system()}>
        <Section
          title={t().membersTitle}
          count={props.conversation.memberCount}
          actions={members.manager() ? [{ label: t().addPeople, icon: "user-plus", onClick: props.onAddPeople }] : undefined}
          more={
            members.cursor() && !members.moreFailed()
              ? {
                  label: t().showMoreMembers,
                  icon: "dots",
                  disabled: members.status() !== "ready" || members.loadingMore(),
                  onClick: () => void members.more(),
                }
              : undefined
          }
        >
          <Input
            type="search"
            maxLength={SEARCH_MAX}
            icon="search"
            label={t().searchMembers}
            placeholder={t().searchMembers}
            value={members.input()}
            onInput={members.setInput}
          />
          <Show when={members.status() === "error"}>
            <Failed text={t().membersFailed} onRetry={() => void members.load()} />
          </Show>
          <Show when={members.status() === "loading" && members.rows.length === 0}>
            <Loading rows={4} lines={2} />
          </Show>
          <Show when={members.status() === "ready" && members.rows.length === 0 && members.query()}>
            <Empty icon="users" text={t().noMemberMatches({ q: members.query() })} />
          </Show>
          <List label={t().membersTitle}>
            <For each={members.rows}>
              {(member) => (
                <Row
                  // A group shows its sign; a person or an account its picture (initials while it loads or has none).
                  icon={member.principal.type === "group" ? "users-group" : undefined}
                  avatar={
                    member.principal.type === "group"
                      ? undefined
                      : {
                          name: member.displayName,
                          image: cloudAvatarImage({
                            kind: member.principal.type === "service_account" ? "service_account" : "user",
                            userId: member.principal.type === "user" ? member.principal.userId : undefined,
                            avatarHash: member.avatarHash,
                          }),
                        }
                  }
                  lines={[member.displayName, markers(member).join(" · ")]}
                  end={
                    <Show when={memberMenu(member).length > 0}>
                      <Menu label={t().permissionFor({ name: member.displayName })} items={memberMenu(member)} />
                    </Show>
                  }
                />
              )}
            </For>
          </List>
          <Show when={members.moreFailed()}>
            <Notice tone="bad" actions={[{ label: t().retry, onClick: () => void members.more() }]}>
              {t().membersFailed}
            </Notice>
          </Show>
        </Section>
      </Show>
      <Show when={props.sharedProps}>{(shared) => <SharedV2 {...shared()} />}</Show>
    </>
  );
}
