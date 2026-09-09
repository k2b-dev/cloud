import { NoticeCard, Button, CheckboxCard, PanelDialog, Select, TextInput, useLocale } from "@k2b/ui";
import { EntitySearch, type EntitySearchPrincipal } from "@k2b/cloud/account/ui";
import { createSignal, For, Show } from "solid-js";
import type { CreateOAuthClient, OAuthClient, OAuthScope, UpdateOAuthClient } from "@/contracts";
import { oauthMessages } from "../messages";

type AccessChoice = "user" | "everybody" | "specific";

type SelectedUser = {
  id: string;
  label: string;
  mail: string | null;
  provider: "local" | "ipa";
};

type SelectedGroup = {
  id: string;
  label: string;
  description: string | null;
  provider: "local" | "ipa";
};

type OAuthClientDialogProps =
  | {
      mode: "create";
      close: () => void;
      loading: () => boolean;
      onSubmit: (data: CreateOAuthClient) => Promise<void>;
    }
  | {
      mode: "edit";
      client: OAuthClient;
      close: () => void;
      loading: () => boolean;
      onSubmit: (data: UpdateOAuthClient) => Promise<void>;
    };

const accessChoiceFromClient = (client?: OAuthClient): AccessChoice => {
  if (client?.accessMode === "specific") return "specific";
  return client?.allowedProfiles.includes("guest") ? "everybody" : "user";
};

const selectedUsersFromClient = (client?: OAuthClient): SelectedUser[] =>
  client?.accessUsers.map((user) => ({
    id: user.id,
    label: user.displayName || user.uid,
    mail: user.mail,
    provider: user.provider,
  })) ?? [];

const selectedGroupsFromClient = (client?: OAuthClient): SelectedGroup[] =>
  client?.accessGroups.map((group) => ({
    id: group.id,
    label: group.name,
    description: group.description,
    provider: group.provider,
  })) ?? [];

const removeById = <T extends { id: string }>(id: string, values: T[]) => values.filter((item) => item.id !== id);

export default function OAuthClientDialog(props: OAuthClientDialogProps) {
  const locale = useLocale();
  const t = () => oauthMessages.resolve([locale()]).t;
  const accessChoiceOptions = (): { id: AccessChoice; label: string; description: string; icon: string }[] => [
    { id: "user", label: t().fullUsersOnly, description: t().fullUsersOnlyDescription, icon: "ti ti-user" },
    { id: "everybody", label: t().everybody, description: t().everybodyDescription, icon: "ti ti-users" },
    { id: "specific", label: t().specific, description: t().specificDescription, icon: "ti ti-user-check" },
  ];
  const scopeOptions = () =>
    [
      { id: "openid", label: "OpenID", description: t().scopeOpenId, icon: "ti ti-fingerprint" },
      { id: "profile", label: t().profileScopeLabel, description: t().scopeProfile, icon: "ti ti-id-badge-2" },
      { id: "email", label: t().emailScopeLabel, description: t().scopeEmail, icon: "ti ti-mail" },
      { id: "groups", label: t().groupsScopeLabel, description: t().scopeGroups, icon: "ti ti-users-group" },
      { id: "offline_access", label: t().offlineAccess, description: t().scopeOffline, icon: "ti ti-refresh" },
      { id: "read", label: t().read, description: t().scopeRead, icon: "ti ti-eye" },
      { id: "write", label: t().write, description: t().scopeWrite, icon: "ti ti-pencil" },
      { id: "admin", label: t().admin, description: t().scopeAdmin, icon: "ti ti-shield-lock" },
    ] as const satisfies readonly { id: OAuthScope; label: string; description: string; icon: string }[];
  const client = () => (props.mode === "edit" ? props.client : undefined);
  const [name, setName] = createSignal(client()?.name ?? "");
  const [description, setDescription] = createSignal(client()?.description ?? "");
  const [redirectUri, setRedirectUri] = createSignal(client()?.redirectUris[0] ?? "");
  const [logoutUri, setLogoutUri] = createSignal(client()?.logoutUri ?? "");
  const [accessChoice, setAccessChoice] = createSignal<AccessChoice>(accessChoiceFromClient(client()));
  const [scopes, setScopes] = createSignal<OAuthScope[]>(client()?.scopes ?? ["openid", "profile", "email"]);
  const [isPublic, setIsPublic] = createSignal(client()?.isPublic ?? false);
  const [users, setUsers] = createSignal<SelectedUser[]>(selectedUsersFromClient(client()));
  const [groups, setGroups] = createSignal<SelectedGroup[]>(selectedGroupsFromClient(client()));

  const selectedLabel = () => accessChoiceOptions().find((option) => option.id === accessChoice())?.label;
  const hasSpecificSelection = () => users().length > 0 || groups().length > 0;
  const canSubmit = () =>
    (props.mode === "edit" || name().trim().length > 0) &&
    redirectUri().trim().length > 0 &&
    (accessChoice() !== "specific" || hasSpecificSelection());

  const addEntity = (principal: EntitySearchPrincipal) => {
    if (principal.type === "user") {
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
              },
            ],
      );
      return;
    }

    if (principal.type === "group") {
      setGroups((current) =>
        current.some((group) => group.id === principal.groupId)
          ? current
          : [
              ...current,
              {
                id: principal.groupId,
                label: principal.name,
                description: principal.description,
                provider: principal.provider,
              },
            ],
      );
    }
  };

  const setScopeEnabled = (scope: OAuthScope, enabled: boolean) =>
    setScopes((current) =>
      enabled ? (current.includes(scope) ? current : [...current, scope]) : current.filter((item) => item !== scope),
    );

  const buildAccessPayload = () => {
    const specific = accessChoice() === "specific";
    return {
      allowedProfiles: accessChoice() === "user" ? (["user"] as ("user" | "guest")[]) : (["user", "guest"] as ("user" | "guest")[]),
      accessMode: specific ? ("specific" as const) : ("profiles" as const),
      allowedUserIds: specific ? users().map((user) => user.id) : [],
      allowedGroupIds: specific ? groups().map((group) => group.id) : [],
    };
  };

  const submit = async () => {
    if (!canSubmit()) return;
    const cleanRedirectUri = redirectUri()
      .trim()
      .replace(/^["']|["']$/g, "");
    const cleanLogoutUri = logoutUri().trim();
    const common = {
      description: description().trim() || undefined,
      redirectUris: [cleanRedirectUri],
      logoutUri: cleanLogoutUri || undefined,
      scopes: scopes(),
      ...buildAccessPayload(),
    };

    if (props.mode === "create") {
      await props.onSubmit({
        ...common,
        name: name().trim(),
        audiences: ["cloud"],
        isPublic: isPublic(),
      });
      return;
    }

    await props.onSubmit({
      ...common,
      description: common.description ?? null,
      logoutUri: cleanLogoutUri || null,
    });
  };

  return (
    <PanelDialog>
      <PanelDialog.Header
        title={props.mode === "create" ? t().newClient : t().editClient({ name: props.client.name })}
        subtitle={t().dialogSubtitle}
        icon={props.mode === "create" ? "ti ti-plus" : "ti ti-pencil"}
        close={props.close}
      />

      <PanelDialog.Body>
        <div class="grid min-w-0 gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,24rem)]">
          <PanelDialog.Section title={t().client} subtitle={t().applicationMetadata} icon="ti ti-key">
            <Show
              when={props.mode === "create"}
              fallback={
                <NoticeCard tone="info" icon={false}>
                  Client ID: <code>{props.mode === "edit" ? props.client.clientId : ""}</code>
                </NoticeCard>
              }
            >
              <TextInput
                label={t().name}
                placeholder={t().namePlaceholder}
                icon="ti ti-tag"
                value={name}
                onValueChange={setName}
                required
              />
            </Show>
            <TextInput
              label={t().description}
              placeholder={t().descriptionPlaceholder}
              icon="ti ti-file-description"
              value={description}
              onValueChange={setDescription}
            />
            <TextInput
              label={t().redirectUri}
              description={t().redirectUriDescription}
              placeholder="https://myapp.example.com/callback"
              icon="ti ti-link"
              value={redirectUri}
              onValueChange={setRedirectUri}
              required
            />
            <TextInput
              label={t().logoutUri}
              description={t().logoutUriDescription}
              placeholder="https://myapp.example.com/logout-callback"
              icon="ti ti-logout"
              value={logoutUri}
              onValueChange={setLogoutUri}
            />
            <Show when={props.mode === "create"}>
              <CheckboxCard
                label={t().publicClient}
                description={t().publicClientDescription}
                icon="ti ti-world"
                variant="input"
                value={isPublic}
                onValueChange={setIsPublic}
              />
            </Show>
          </PanelDialog.Section>

          <aside class="flex min-w-0 flex-col gap-3">
            <PanelDialog.Section title={t().access} subtitle={t().chooseAccess} icon="ti ti-user-check">
              <Select
                label={t().whoCanUse}
                value={accessChoice}
                onValueChange={(value) => {
                  if (value === "user" || value === "everybody" || value === "specific") setAccessChoice(value);
                }}
                selectedLabel={selectedLabel}
                options={accessChoiceOptions()}
                required
              />

              <Show when={accessChoice() === "specific"}>
                <NoticeCard tone="info" icon={false} bodyClass="flex items-start gap-2">
                  <i class="ti ti-info-circle mt-0.5 shrink-0" />
                  <span>{t().nestedGroups}</span>
                </NoticeCard>
                <EntitySearch
                  includeUsers
                  includeGroups
                  excludeUserIds={users().map((user) => user.id)}
                  excludeGroupIds={groups().map((group) => group.id)}
                  placeholder={t().searchUsersGroups}
                  resultsHeightClass="h-56"
                  onSelect={addEntity}
                />
                <SelectedAccessList users={users()} groups={groups()} setUsers={setUsers} setGroups={setGroups} />
              </Show>
            </PanelDialog.Section>

            <PanelDialog.Section title={t().scopes} subtitle={t().claimsClientCanRequest} icon="ti ti-checklist">
              <For each={scopeOptions()}>
                {(scope) => (
                  <ScopeToggle
                    label={scope.label}
                    description={scope.description}
                    icon={scope.icon}
                    checked={() => scopes().includes(scope.id)}
                    onChange={(checked) => setScopeEnabled(scope.id, checked)}
                  />
                )}
              </For>
            </PanelDialog.Section>
          </aside>
        </div>
      </PanelDialog.Body>

      <PanelDialog.Footer>
        <div class="min-w-0 text-xs text-dimmed">
          <Show when={accessChoice() !== "specific" || hasSpecificSelection()} fallback={t().selectPrincipal}>
            {accessChoice() === "specific"
              ? t().selectionCount({ users: users().length, groups: groups().length })
              : t().profileAccessActive}
          </Show>
        </div>
        <div class="ml-auto flex flex-wrap justify-end gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={props.close} disabled={props.loading()}>
            {t().cancel}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => void submit()}
            disabled={!canSubmit()}
            loading={props.loading()}
            loadingLabel={t().saving}
          >
            <i class="ti ti-device-floppy" />
            <span>{props.mode === "create" ? t().create : t().save}</span>
          </Button>
        </div>
      </PanelDialog.Footer>
    </PanelDialog>
  );
}

function ScopeToggle(props: {
  label: string;
  description: string;
  icon: string;
  checked: () => boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <CheckboxCard
      label={props.label}
      description={props.description}
      icon={props.icon}
      variant="input"
      value={props.checked}
      onValueChange={props.onChange}
    />
  );
}

function SelectedAccessList(props: {
  users: SelectedUser[];
  groups: SelectedGroup[];
  setUsers: (fn: (current: SelectedUser[]) => SelectedUser[]) => void;
  setGroups: (fn: (current: SelectedGroup[]) => SelectedGroup[]) => void;
}) {
  const locale = useLocale();
  const t = () => oauthMessages.resolve([locale()]).t;
  return (
    <div class="flex flex-col gap-2">
      <Show when={props.users.length > 0 || props.groups.length > 0} fallback={<p class="text-xs text-dimmed">{t().noPrincipals}</p>}>
        <For each={props.users}>
          {(user) => (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              class="w-full justify-start"
              onClick={() => props.setUsers((current) => removeById(user.id, current))}
            >
              <i class="ti ti-user" />
              <span class="min-w-0 flex-1 truncate text-left">{user.label}</span>
              <span class="text-[10px] uppercase text-dimmed">{user.provider}</span>
              <i class="ti ti-x text-dimmed" />
            </Button>
          )}
        </For>
        <For each={props.groups}>
          {(group) => (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              class="w-full justify-start"
              onClick={() => props.setGroups((current) => removeById(group.id, current))}
            >
              <i class="ti ti-users-group" />
              <span class="min-w-0 flex-1 truncate text-left">{group.label}</span>
              <span class="text-[10px] uppercase text-dimmed">{group.provider}</span>
              <i class="ti ti-x text-dimmed" />
            </Button>
          )}
        </For>
      </Show>
    </div>
  );
}
