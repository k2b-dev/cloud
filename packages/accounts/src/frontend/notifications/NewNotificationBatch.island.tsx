import { navigateTo } from "@k2b/ssr/nav";
import { query } from "@k2b/stdlib/solid";
import {
  Button,
  dialogCore,
  NoticeCard,
  PanelDialog,
  panelDialogOptions,
  panelDialogWideOptions,
  prompts,
  TextInput,
  useLocale,
} from "@k2b/ui";
import { EntitySearch, type EntitySearchPrincipal } from "@valentinkolb/cloud/account/ui";
import { formatNumber } from "@valentinkolb/cloud/shared";
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { apiClient } from "@/api/client";
import AccountAvatar from "@/frontend/AccountAvatar";
import { useAccountsMessages } from "../messages";

type SelectedUser = {
  id: string;
  label: string;
  mail: string | null;
  provider: "local" | "ipa";
  avatarHash: string | null;
};

type SelectedGroup = {
  id: string;
  label: string;
  provider: "local" | "ipa";
};

type SelectionPayload = {
  userIds?: string[];
  groupIds?: string[];
};

type PreviewState = {
  targetCount: number;
  deliverableCount: number;
  skippedNoEmailCount: number;
  recipientHash: string;
};

type PreviewSource = {
  key: string;
  selection: SelectionPayload;
  hasAudience: boolean;
};

type PreviewResult = {
  sourceKey: string;
  data: PreviewState;
};

const readError = async (res: Response, fallback: string) => {
  try {
    const data = await res.json();
    return data.message ?? data.error?.message ?? fallback;
  } catch {
    return fallback;
  }
};

function BatchDialog(props: { close: () => void }) {
  const messages = useAccountsMessages();
  const locale = useLocale();
  let active = true;
  onCleanup(() => {
    active = false;
  });
  const [subject, setSubject] = createSignal("");
  const [body, setBody] = createSignal("");
  const [users, setUsers] = createSignal<SelectedUser[]>([]);
  const [groups, setGroups] = createSignal<SelectedGroup[]>([]);
  const [loading, setLoading] = createSignal(false);

  const selection = createMemo<SelectionPayload>(() => ({
    userIds: users().map((user) => user.id),
    groupIds: groups().map((group) => group.id),
  }));

  const selectionHasAudience = (value: SelectionPayload) => (value.userIds?.length ?? 0) > 0 || (value.groupIds?.length ?? 0) > 0;
  const selectionKey = (value: SelectionPayload) => JSON.stringify(value);
  const hasAudience = () => selectionHasAudience(selection());
  const canCreate = () => subject().trim().length > 0 && body().trim().length > 0 && hasAudience();
  const previewSource = createMemo<PreviewSource>(() => {
    const currentSelection = selection();
    return {
      key: selectionKey(currentSelection),
      selection: currentSelection,
      hasAudience: selectionHasAudience(currentSelection),
    };
  });

  const previewQuery = query.create<PreviewSource, PreviewResult>({
    source: previewSource,
    enabled: () => previewSource().hasAudience,
    isSameSource: (left, right) => left.key === right.key,
    load: async (source, { abortSignal }) => {
      const res = await apiClient.notifications.batches.preview.$post(
        { json: { selection: source.selection } },
        { init: { signal: abortSignal } },
      );
      if (!res.ok) throw new Error(await readError(res, messages().previewRecipientsFailed));
      return { sourceKey: source.key, data: await res.json() };
    },
  });

  const currentPreview = () => {
    const result = previewQuery.data();
    return result?.sourceKey === previewSource().key ? result.data : null;
  };
  const previewLoading = () => previewQuery.loading() || previewQuery.refreshing();

  const addUser = (principal: EntitySearchPrincipal) => {
    if (principal.type !== "user") return;
    setUsers((current) =>
      current.some((user) => user.id === principal.userId)
        ? current
        : [
            ...current,
            {
              id: principal.userId,
              label: principal.displayName || principal.uid,
              mail: principal.mail,
              provider: principal.provider,
              avatarHash: principal.avatarHash,
            },
          ],
    );
  };

  const addGroup = (principal: EntitySearchPrincipal) => {
    if (principal.type !== "group") return;
    setGroups((current) =>
      current.some((group) => group.id === principal.groupId)
        ? current
        : [...current, { id: principal.groupId, label: principal.name, provider: principal.provider }],
    );
  };

  const remove = <T extends { id: string }>(id: string, setter: (fn: (current: T[]) => T[]) => void) => {
    setter((current) => current.filter((item) => item.id !== id));
  };

  const refreshPreview = async (expectedSourceKey = previewSource().key) => {
    if (!previewSource().hasAudience) {
      prompts.error(messages().selectAudience);
      return null;
    }
    await previewQuery.refresh();
    if (!active) return null;
    if (previewSource().key !== expectedSourceKey) {
      prompts.error(messages().audienceChanged);
      return null;
    }
    if (previewQuery.error()) {
      prompts.error(previewQuery.error()!.message);
      return null;
    }
    if (previewQuery.stale()) {
      prompts.error(messages().previewNotConfirmed);
      return null;
    }
    return currentPreview();
  };

  const createDraft = async () => {
    if (!canCreate()) {
      prompts.error(messages().requiredNotificationFields);
      return;
    }
    const draftSource = previewSource();
    const draftSelection = draftSource.selection;
    const latestPreview = await refreshPreview(draftSource.key);
    if (!latestPreview) return;
    if (latestPreview.deliverableCount === 0) {
      prompts.error(messages().noDeliverableAudience);
      return;
    }
    setLoading(true);
    try {
      const res = await apiClient.notifications.batches.$post({
        json: { subject: subject(), bodyMarkdown: body(), selection: draftSelection },
      });
      if (!res.ok) throw new Error(await readError(res, messages().createNotificationFailed));
      const batch = await res.json();
      props.close();
      navigateTo(`/app/accounts/notifications/${batch.id}`);
    } catch (error) {
      prompts.error(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  };

  const openUserPicker = () => {
    void dialogCore.open<void>(
      (close) => (
        <PanelDialog>
          <PanelDialog.Header title={messages().addUser} subtitle={messages().addUserDescription} icon="ti ti-user-plus" close={close} />
          <PanelDialog.Body>
            <EntitySearch
              includeUsers
              placeholder={messages().searchUsers}
              excludeUserIds={users().map((user) => user.id)}
              onSelect={(principal) => {
                addUser(principal);
                close();
              }}
              resultsHeightClass="h-72"
            />
          </PanelDialog.Body>
        </PanelDialog>
      ),
      panelDialogOptions,
    );
  };

  const openGroupPicker = () => {
    void dialogCore.open<void>(
      (close) => (
        <PanelDialog>
          <PanelDialog.Header
            title={messages().addGroup}
            subtitle={messages().addGroupDescription}
            icon="ti ti-users-group"
            close={close}
          />
          <PanelDialog.Body>
            <EntitySearch
              includeGroups
              placeholder={messages().searchGroups}
              excludeGroupIds={groups().map((group) => group.id)}
              onSelect={(principal) => {
                addGroup(principal);
                close();
              }}
              resultsHeightClass="h-72"
            />
          </PanelDialog.Body>
        </PanelDialog>
      ),
      panelDialogOptions,
    );
  };

  const previewLabel = () => {
    if (!hasAudience()) return messages().noAudience;
    if (previewLoading()) return messages().resolvingRecipients;
    const error = previewQuery.error();
    if (error) return error.message;
    const data = currentPreview();
    if (!data) return messages().previewUpdatesAutomatically;
    return messages().previewSummary({
      deliverable: formatNumber(data.deliverableCount, { locale: locale() }),
      matched: formatNumber(data.targetCount, { locale: locale() }),
      withoutEmail: formatNumber(data.skippedNoEmailCount, { locale: locale() }),
    });
  };

  return (
    <PanelDialog>
      <PanelDialog.Header
        title={messages().newNotificationBatch}
        subtitle={messages().newNotificationDescription}
        icon="ti ti-mail-plus"
        close={props.close}
      />
      <PanelDialog.Body>
        <div class="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,24rem)]">
          <PanelDialog.Section title={messages().message} subtitle={messages().messageTemplateDescription} icon="ti ti-message-2">
            <TextInput
              label={messages().subject}
              description={messages().subjectDescription}
              placeholder={messages().subjectExample}
              value={subject}
              onValueChange={setSubject}
              required
            />

            <TextInput
              label={messages().body}
              description={messages().bodyDescription}
              placeholder={messages().bodyPlaceholder}
              markdown
              lines={13}
              value={body}
              onValueChange={setBody}
              required
            />
          </PanelDialog.Section>

          <aside class="flex min-w-0 flex-col gap-3">
            <PanelDialog.Section title={messages().selectedUsers} subtitle={messages().selectedUsersDescription} icon="ti ti-users">
              <div class="flex items-center justify-between gap-2">
                <span class="text-xs text-dimmed">{messages().selectedUserCount({ count: users().length })}</span>
                <Button size="sm" variant="subtle" onClick={openUserPicker}>
                  <i class="ti ti-user-plus" />
                  <span>{messages().addUser}</span>
                </Button>
              </div>
              <Show when={users().length > 0} fallback={<p class="text-xs text-dimmed">{messages().noSelectedUsers}</p>}>
                <div class="flex flex-col gap-2">
                  <For each={users()}>
                    {(user) => (
                      <Button
                        size="sm"
                        variant="subtle"
                        class="justify-start"
                        aria-label={messages().removeLabel({ name: user.label })}
                        onClick={() => remove<SelectedUser>(user.id, setUsers)}
                      >
                        <AccountAvatar name={user.label} userId={user.id} avatarHash={user.avatarHash} size="xs" />
                        <span class="min-w-0 flex-1 truncate text-left">{user.label}</span>
                        <span class="text-[10px] uppercase text-dimmed">{user.provider}</span>
                        <i class="ti ti-x text-dimmed" />
                      </Button>
                    )}
                  </For>
                </div>
              </Show>
            </PanelDialog.Section>

            <PanelDialog.Section title={messages().selectedGroups} subtitle={messages().selectedGroupsDescription} icon="ti ti-users-group">
              <div class="flex items-center justify-between gap-2">
                <span class="text-xs text-dimmed">{messages().selectedGroupCount({ count: groups().length })}</span>
                <Button size="sm" variant="subtle" onClick={openGroupPicker}>
                  <i class="ti ti-plus" />
                  <span>{messages().addGroup}</span>
                </Button>
              </div>
              <Show when={groups().length > 0} fallback={<p class="text-xs text-dimmed">{messages().noSelectedGroups}</p>}>
                <div class="flex flex-col gap-2">
                  <For each={groups()}>
                    {(group) => (
                      <Button
                        size="sm"
                        variant="subtle"
                        class="justify-start"
                        aria-label={messages().removeLabel({ name: group.label })}
                        onClick={() => remove<SelectedGroup>(group.id, setGroups)}
                      >
                        <i class="ti ti-users-group" />
                        <span class="min-w-0 flex-1 truncate text-left">{group.label}</span>
                        <span class="text-[10px] uppercase text-dimmed">{group.provider}</span>
                        <i class="ti ti-x text-dimmed" />
                      </Button>
                    )}
                  </For>
                </div>
              </Show>
            </PanelDialog.Section>

            <PanelDialog.Section title={messages().livePreview} subtitle={messages().livePreviewDescription} icon="ti ti-eye">
              <NoticeCard
                tone={previewQuery.error() ? "danger" : previewLoading() ? "info" : "neutral"}
                icon={false}
                bodyClass="flex items-start gap-2"
              >
                <i
                  class={
                    previewLoading()
                      ? "ti ti-loader-2 mt-0.5 shrink-0 animate-spin"
                      : previewQuery.error()
                        ? "ti ti-alert-circle mt-0.5 shrink-0"
                        : "ti ti-users mt-0.5 shrink-0"
                  }
                />
                <span>{previewLabel()}</span>
              </NoticeCard>
            </PanelDialog.Section>
          </aside>
        </div>
      </PanelDialog.Body>

      <PanelDialog.Footer>
        <div class="min-w-0 text-xs text-dimmed">{previewLabel()}</div>
        <div class="ml-auto flex flex-wrap justify-end gap-2">
          <Button size="sm" variant="secondary" onClick={props.close} disabled={loading()}>
            {messages().cancel}
          </Button>
          <Button
            size="sm"
            variant="subtle"
            onClick={() => void previewQuery.refresh()}
            disabled={previewLoading() || loading() || !hasAudience()}
          >
            <i class={previewLoading() ? "ti ti-loader-2 animate-spin" : "ti ti-refresh"} />
            <span>{previewLoading() ? messages().previewing : messages().refreshPreview}</span>
          </Button>
          <Button size="sm" onClick={createDraft} disabled={loading() || !canCreate()}>
            <i class={loading() ? "ti ti-loader-2 animate-spin" : "ti ti-device-floppy"} />
            <span>{loading() ? messages().creating : messages().createDraft}</span>
          </Button>
        </div>
      </PanelDialog.Footer>
    </PanelDialog>
  );
}

export default function NewNotificationBatch() {
  const messages = useAccountsMessages();
  const open = () => {
    void dialogCore.open<void>((close) => <BatchDialog close={close} />, panelDialogWideOptions);
  };

  return (
    <Button size="sm" class="ml-auto max-w-full shrink-0 whitespace-nowrap" onClick={open}>
      <i class="ti ti-plus" />
      <span>{messages().newNotification}</span>
    </Button>
  );
}
