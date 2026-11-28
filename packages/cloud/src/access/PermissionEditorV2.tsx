import { useLocale } from "@k2b/ui";
import { Button, confirm, Empty, Failed, List, Loading, Menu, Notice, Popover, Row, Text } from "@k2b/ui/v2";
import { createSignal, For, type JSX, mergeProps, onCleanup, Show } from "solid-js";
import type { AccessEntry } from "../contracts/shared";
import { accessDialogMessages } from "./access-dialog-messages";
import { createGroupCoverage, type GroupCoverage } from "./group-coverage";
import { accessMessages } from "./messages";
import type { PermissionEditorProps } from "./PermissionEditor";
import { createPermissionEditorState } from "./permission-editor-state";
import { levelKey, type ResolvedLevel } from "./permission-levels";
import { principalFace } from "./principal-face";
import { serviceAccountKindDisplay } from "./service-account-kind";

/** Who receives access through a group, behind its "Members" button, so opening it moves nothing on the page. */
function GroupMembers(props: { coverage: GroupCoverage; groupName: string; disabled: boolean }) {
  const locale = useLocale();
  const access = () => createPermissionWords(locale());
  const members = () => props.coverage.members;
  const shown = () =>
    members()
      .pages()
      .flatMap((page) => (page.visible ? page.members : []));
  const first = () => members().pages()[0];
  const total = () => {
    const page = first();
    return page?.visible ? page.total : 0;
  };
  return (
    <Popover
      label={access().groupMembersOf({ name: props.groupName })}
      title={access().groupMembersOf({ name: props.groupName })}
      icon="users"
      variant="ghost"
      disabled={props.disabled}
      content={
        <>
          <Show when={members().error()}>
            <Failed text={access().groupMembersFailed} onRetry={() => void members().refresh()} />
          </Show>
          <Show when={!members().error() && members().pages().length === 0}>
            <Loading rows={3} lines={1} />
          </Show>
          <Show when={first() && !first()!.visible}>
            <Text muted>{access().groupMembersHidden}</Text>
          </Show>
          <Show when={first()?.visible}>
            <Text type="meta">{access().groupMemberCount({ count: total() })}</Text>
            <Show when={first()?.directoryGroup}>
              <Text type="meta">{access().directoryGroupHint}</Text>
            </Show>
            <List label={access().groupMembersOf({ name: props.groupName })}>
              <For each={shown()}>
                {(member) =>
                  member.kind === "service_account" ? (
                    <Row
                      {...principalFace(
                        { type: "service_account", serviceAccountId: member.serviceAccount.id },
                        member.serviceAccount.name,
                        {
                          serviceAccountKind: member.serviceAccount.kind,
                        },
                      )}
                      lines={[member.serviceAccount.name]}
                      meta={serviceAccountKindDisplay(member.serviceAccount.kind, access()).label}
                    />
                  ) : (
                    <Row
                      {...principalFace(
                        { type: "user", userId: member.user.id },
                        member.user.displayName || member.user.mail || member.user.uid,
                        member.user,
                      )}
                      lines={[member.user.displayName || member.user.mail || member.user.uid]}
                    />
                  )
                }
              </For>
            </List>
            <Show when={members().hasMore()}>
              <Button variant="text" busy={members().loadingMore()} onClick={() => void members().loadMore()}>
                {access().showMoreMembers({ count: Math.min(total() - shown().length, 20) })}
              </Button>
            </Show>
          </Show>
        </>
      }
    >
      {access().groupMembers}
    </Popover>
  );
}

const createPermissionWords = (locale: string) => accessMessages.resolve([locale]).t;

/**
 * The permission editor on v2: who has access, each a row with its face, kind, level menu and Remove; changes apply at
 * once, a failure says so in its row with "Try again", and the last manager keeps Manage. The same state and rules as
 * the v1 `PermissionEditor` (`createPermissionEditorState`). Adding someone comes with the single-choice `Lookup`.
 */
export function PermissionEditorV2(props: PermissionEditorProps) {
  const locale = useLocale();
  // k2b-ui gap: Row keeps no focus when its own action leaves; after a removal the focus goes to the next row's Remove.
  const anchors = new Set<HTMLElement>();
  const [loose, setLoose] = createSignal<string>();
  // v2 has one look: saves and failures always speak in their own row (the v1 `expanded` behaviour).
  const state = createPermissionEditorState(mergeProps(props, { expanded: true }), locale, {
    confirm: (question) => confirm({ title: question.title, description: question.body, confirm: state.t().removeAccess }),
    // v2 is `expanded`: a failure speaks in its own row, with its message and "Try again"; one without a row left (the
    // entry went meanwhile) says so above the list
    error: setLoose,
    focusAdd: () => {},
    focusAfterRemoval: (index) =>
      queueMicrotask(() => {
        // The removed row took its own anchor along: find the list through a row that is still there.
        const anchor = [...anchors].find((element) => element.isConnected);
        const list = anchor?.closest('[data-k2-part="List"]');
        if (!list) return;
        const removes = [...list.querySelectorAll<HTMLButtonElement>("[data-access-remove-anchor] button")];
        // The next or previous Remove; when only the protected last manager remains, the first control left in the list.
        const next =
          [removes[index], removes[index - 1]].find((button) => button && !button.disabled) ??
          list.querySelector<HTMLElement>("button:not(:disabled), a[href]");
        next?.focus();
      }),
  });
  const t = state.t;
  const levelOf = (entry: AccessEntry, allowed: ResolvedLevel[]) =>
    allowed.find((option) => option.key === levelKey(entry.permission, entry.scope))?.label ?? entry.permission;
  const kindLine = (entry: AccessEntry, allowed: ResolvedLevel[]) =>
    props.entryDetail?.(entry) ??
    (entry.principal.type === "user"
      ? t().person
      : entry.principal.type === "group"
        ? t().group
        : entry.principal.type === "authenticated"
          ? (props.signedIn?.description ?? t().signedInPermission({ level: levelOf(entry, allowed).toLocaleLowerCase(locale()) }))
          : entry.principal.type === "public"
            ? t().anyoneWithLink
            : entry.principal.type === "service_account"
              ? entry.serviceAccountKind === "code"
                ? t().codeAccessAuthority
                : (entry.serviceAccountKind && serviceAccountKindDisplay(entry.serviceAccountKind, t()).label) || t().agentServiceAccount
              : "");

  const EntryRow = (rowProps: { entry: AccessEntry }): JSX.Element => {
    const entry = () => rowProps.entry;
    const allowed = () => state.allowed(entry().principal);
    const lastManager = () => entry().id === state.lastManagerId();
    const manage = () => allowed().find((option) => option.level === "admin" && !option.scope)?.label ?? t().manage;
    const feedback = () => state.feedback[entry().id];
    const saving = () => entry().id === state.pending() || state.updatingRow(entry().id) !== undefined || entry().id === state.revoking();
    const shown = () => state.updatingRow(entry().id) ?? { permission: entry().permission, scope: entry().scope };
    const hasPicker = () =>
      state.canEdit() && allowed().length > 1 && allowed().some((option) => option.key === levelKey(entry().permission, entry().scope));
    // A group's coverage loads with its row, so its list usually opens complete.
    const coverage =
      entry().principal.type === "group" ? createGroupCoverage((entry().principal as { groupId: string }).groupId) : undefined;
    const second = () =>
      feedback()?.retry
        ? feedback()!.message
        : state.canEdit() && lastManager()
          ? t().lastManager({ level: manage() })
          : kindLine(entry(), allowed());
    return (
      <Row
        {...principalFace(entry().principal, state.labelOf(entry()), entry())}
        lines={[state.labelOf(entry()), second()]}
        meta={props.ownEntryIds?.includes(entry().id) ? t().you : undefined}
        end={
          <>
            <Show when={coverage}>
              {(members) => <GroupMembers coverage={members()} groupName={state.labelOf(entry())} disabled={saving()} />}
            </Show>
            <Show when={feedback()?.retry}>
              <Button variant="text" disabled={state.saving()} onClick={() => feedback()?.retry?.()}>
                {t().retry}
              </Button>
            </Show>
            <Show
              when={saving()}
              fallback={
                <Show when={feedback() && !feedback()!.retry}>
                  {
                    <Text type="meta" tone="ok">
                      {t().saved}
                    </Text>
                  }
                </Show>
              }
            >
              <Text type="meta">{t().saving}</Text>
            </Show>
            <Show when={hasPicker()} fallback={<Text type="meta">{levelOf({ ...entry(), ...shown() }, allowed())}</Text>}>
              <Menu
                label={t().permissionFor({ name: state.labelOf(entry()) })}
                variant="ghost"
                disabled={state.saving()}
                items={[
                  {
                    title: t().permissionFor({ name: state.labelOf(entry()) }),
                    choice: levelKey(shown().permission, shown().scope),
                    onChoose: (key: string) => {
                      const option = allowed().find((candidate) => candidate.key === key);
                      if (option && key !== levelKey(entry().permission, entry().scope))
                        state.startUpdate({ accessId: entry().id, permission: option.level, scope: option.scope });
                    },
                    items: allowed().map((option) => {
                      const locked = lastManager() && (option.level !== "admin" || option.scope !== undefined);
                      return {
                        value: option.key,
                        label: option.label,
                        disabled: locked,
                        meta: locked ? t().lastManagerOption({ level: manage() }) : undefined,
                      };
                    }),
                  },
                ]}
              >
                {levelOf({ ...entry(), ...shown() }, allowed())}
              </Menu>
            </Show>
            <Show when={state.canEdit()}>
              {/* The remove button keeps its place: disabled for the last manager, with the reason as its name. */}
              <span
                ref={(element) => {
                  anchors.add(element);
                  onCleanup(() => anchors.delete(element));
                }}
                data-access-remove-anchor=""
              >
                <Button
                  variant="ghost"
                  icon="x"
                  label={lastManager() ? t().lastManager({ level: manage() }) : t().remove({ name: state.labelOf(entry()) })}
                  disabled={state.saving() || entry().id === state.pending() || lastManager()}
                  busy={entry().id === state.revoking()}
                  onClick={() => state.startRevoke(entry())}
                />
              </span>
            </Show>
          </>
        }
      />
    );
  };

  return (
    <>
      <Show when={loose()}>{(message) => <Notice tone="bad">{message()}</Notice>}</Show>
      <Show when={state.feedback.add}>
        {(failure) => (
          <Notice tone="bad" actions={failure().retry ? [{ label: t().retry, onClick: () => failure().retry?.() }] : undefined}>
            {failure().message}
          </Notice>
        )}
      </Show>
      <Show when={state.shareEntries().length > 0} fallback={<Empty icon="lock-open-off" text={t().noDirectGrants} />}>
        <List label={accessDialogMessages.resolve([locale()]).t.summaryTitle}>
          <For each={state.shareEntries()}>{(entry) => <EntryRow entry={entry} />}</For>
        </List>
      </Show>
    </>
  );
}
