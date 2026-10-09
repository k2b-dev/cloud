import { coreClient } from "@k2b/cloud/clients/core";
import type { AdminMailApp, AdminMailProfile } from "@k2b/cloud/contracts";
import { mutation, query } from "@k2b/stdlib/solid";
import {
  Button,
  Checkbox,
  CheckboxCard,
  confirmDiscardIfDirty,
  DataTable,
  type DataTableColumn,
  Dropdown,
  dialogCore,
  Format,
  NoticeCard,
  NumberInput,
  PanelDialog,
  Placeholder,
  panelDialogOptions,
  prompts,
  SegmentedControl,
  StatusBadge,
  Switch,
  TextInput,
  toast,
  useLocale,
} from "@k2b/ui";
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { outgoingMailMessages } from "./messages";
import { SendLog, type SendLogState } from "./SendLog";

type SendersState = {
  profiles: AdminMailProfile[];
  apps: { defaultProfile: string | null; items: AdminMailApp[] };
};
export type OutgoingMailState = SendersState & { log: SendLogState };
type Props = { initial: OutgoingMailState };
type Messages = ReturnType<typeof outgoingMailMessages.resolve>["t"];
type AccessMode = "default" | "selected" | "none";

const api = coreClient.admin.core["outgoing-mail"];
/** Core's system email (sign-in, password reset, notifications) always uses the default profile. */
const CORE_APP_ID = "core";
const MB = 1024 * 1024;

const messages = () => {
  const locale = useLocale();
  return () => outgoingMailMessages.resolve([locale()]).t;
};

/**
 * Reads the server's `{ code, message }` error body. Known codes get the reader's language; the
 * server's own text stays only for codes without a translation, such as the SMTP answer of `smtp_failed`.
 */
const failure = async (response: { json: () => Promise<unknown> }, fallback: string, t: Messages) => {
  const body = await response.json().catch(() => null);
  if (!body || typeof body !== "object") return new Error(fallback);
  const code = "code" in body && typeof body.code === "string" ? body.code : undefined;
  const message = "message" in body && typeof body.message === "string" ? body.message : undefined;
  const known: Record<string, string> = {
    revision_conflict: t.conflict,
    profile_exists: t.profileExists,
    profile_unknown: t.profileUnknown,
    profile_is_default: t.profileIsDefault,
    invalid_profile: t.invalidEntries,
  };
  return new Error((code ? known[code] : undefined) ?? message ?? fallback);
};

const loadState = async (signal: AbortSignal, t: Messages): Promise<SendersState> => {
  const [profiles, apps] = await Promise.all([api.profiles.$get({}, { init: { signal } }), api.apps.$get({}, { init: { signal } })]);
  if (!profiles.ok) throw await failure(profiles, t.loadFailed, t);
  if (!apps.ok) throw await failure(apps, t.loadFailed, t);
  return { profiles: (await profiles.json()).items, apps: await apps.json() };
};

const accessLabel = (app: AdminMailApp, profiles: readonly AdminMailProfile[], t: Messages): string => {
  if (app.mode === "default") {
    const current = profiles.find((profile) => profile.isDefault);
    return current ? t.accessDefaultNamed({ name: current.name }) : t.accessDefault;
  }
  if (!app.profiles.length) return t.accessNone;
  return app.profiles.map((key) => profiles.find((profile) => profile.key === key)?.name ?? key).join(", ");
};

/** Names the other apps whose send log this app may read; its own mail is always readable. */
const logLabel = (app: AdminMailApp, apps: readonly AdminMailApp[], t: Messages): string =>
  app.logApps.length
    ? t.logAlso({ names: app.logApps.map((id) => apps.find((entry) => entry.appId === id)?.name ?? id).join(", ") })
    : t.logOwnOnly;

type BounceError = NonNullable<NonNullable<AdminMailProfile["bounces"]>["error"]>;
const bounceReason = (error: BounceError, t: Messages): string =>
  ({
    open_failed: t.bounceOpenFailed,
    search_failed: t.bounceSearchFailed,
    apply_failed: t.bounceApplyFailed,
    save_failed: t.bounceSaveFailed,
    interrupted: t.bounceInterrupted,
  })[error];

/**
 * Whether Core reads this profile's mailbox for bounces, and how the latest check went. The reason
 * stays visible text, because touch screens cannot reveal a tooltip, and wraps inside table cells,
 * which truncate by default.
 */
function BounceStatus(props: { profile: AdminMailProfile; t: Messages; class?: string }) {
  return (
    <p
      class={`mt-0.5 whitespace-normal break-words text-xs ${props.profile.bounces?.error ? "text-red-600 dark:text-red-400" : "text-dimmed"} ${props.class ?? ""}`}
    >
      <Show when={props.profile.bounces} fallback={props.t.bouncesOff}>
        {(bounces) => (
          <Show
            when={bounces().error}
            fallback={
              <Show when={bounces().checkedAt} fallback={props.t.bouncesPending}>
                {(checkedAt) => (
                  <>
                    {props.t.bouncesChecked} <Format.DateTime value={checkedAt()} />
                  </>
                )}
              </Show>
            }
          >
            {(error) => `${props.t.bouncesFailed}: ${bounceReason(error(), props.t)}`}
          </Show>
        )}
      </Show>
    </p>
  );
}

/** Exported for the behavior test: saving replaces the whole profile, including its IMAP mailbox. */
export function ProfileDialog(props: {
  profile?: AdminMailProfile;
  close: () => void;
  onSaved: () => void;
  setDismissHandler: (handler: () => void | Promise<void>) => void;
}) {
  const t = messages();
  const initial = props.profile;
  const [key, setKey] = createSignal(initial?.key ?? "");
  const [name, setName] = createSignal(initial?.name ?? "");
  const [fromAddress, setFromAddress] = createSignal(initial?.fromAddress ?? "");
  const [fromName, setFromName] = createSignal(initial?.fromName ?? "");
  const [smtpHost, setSmtpHost] = createSignal(initial?.smtpHost ?? "");
  const [smtpPort, setSmtpPort] = createSignal<number | null>(initial?.smtpPort ?? 587);
  const [smtpSecure, setSmtpSecure] = createSignal(initial?.smtpSecure ?? false);
  const [smtpUser, setSmtpUser] = createSignal(initial?.smtpUser ?? "");
  const [password, setPassword] = createSignal("");
  const [clearPassword, setClearPassword] = createSignal(false);
  const [pace, setPace] = createSignal<number | null>(initial?.pacePerMinute ?? 60);
  const [dailyLimit, setDailyLimit] = createSignal<number | null>(initial?.dailyRecipientLimit ?? null);
  const [attachmentMb, setAttachmentMb] = createSignal<number | null>(initial ? initial.maxAttachmentBytes / MB : 15);
  const imap = initial?.imap ?? null;
  const [imapHost, setImapHost] = createSignal(imap?.host ?? "");
  const [imapPort, setImapPort] = createSignal<number | null>(imap?.port ?? 993);
  const [imapSecure, setImapSecure] = createSignal(imap?.secure ?? true);
  const [imapUser, setImapUser] = createSignal(imap?.user ?? "");
  const [imapFolder, setImapFolder] = createSignal(imap?.folder ?? "INBOX");
  const [imapPassword, setImapPassword] = createSignal("");
  const [clearImapPassword, setClearImapPassword] = createSignal(false);
  // An empty IMAP host turns the bounce check off; the other IMAP fields then wait disabled.
  const imapOn = () => !!imapHost().trim();

  const keyValid = () => /^[a-z0-9][a-z0-9-]{0,62}$/.test(key());
  // A saved password never follows the profile to another server: a new host needs it again or without it.
  const passwordNeeded = () =>
    !!initial?.hasPassword && smtpHost().trim().toLowerCase() !== initial.smtpHost.toLowerCase() && !password() && !clearPassword();
  const imapPasswordNeeded = () =>
    !!imap?.hasPassword && imapHost().trim().toLowerCase() !== imap.host.toLowerCase() && !imapPassword() && !clearImapPassword();
  const complete = () =>
    keyValid() &&
    !!name().trim() &&
    !!fromAddress().trim() &&
    !!smtpHost().trim() &&
    !!smtpPort() &&
    !!pace() &&
    !!attachmentMb() &&
    !passwordNeeded() &&
    (!imapOn() || (!!imapPort() && !!imapUser().trim() && !!imapFolder().trim() && !imapPasswordNeeded()));
  const dirty = createMemo(() => {
    const before = {
      key: initial?.key ?? "",
      name: initial?.name ?? "",
      fromAddress: initial?.fromAddress ?? "",
      fromName: initial?.fromName ?? "",
      smtpHost: initial?.smtpHost ?? "",
      smtpPort: initial?.smtpPort ?? 587,
      smtpSecure: initial?.smtpSecure ?? false,
      smtpUser: initial?.smtpUser ?? "",
      pace: initial?.pacePerMinute ?? 60,
      dailyLimit: initial?.dailyRecipientLimit ?? null,
      attachmentMb: initial ? initial.maxAttachmentBytes / MB : 15,
      imapHost: imap?.host ?? "",
      imapPort: imap?.port ?? 993,
      imapSecure: imap?.secure ?? true,
      imapUser: imap?.user ?? "",
      imapFolder: imap?.folder ?? "INBOX",
    };
    return (
      before.key !== key() ||
      before.name !== name() ||
      before.fromAddress !== fromAddress() ||
      before.fromName !== fromName() ||
      before.smtpHost !== smtpHost() ||
      before.smtpPort !== smtpPort() ||
      before.smtpSecure !== smtpSecure() ||
      before.smtpUser !== smtpUser() ||
      before.pace !== pace() ||
      before.dailyLimit !== dailyLimit() ||
      before.attachmentMb !== attachmentMb() ||
      before.imapHost !== imapHost() ||
      before.imapPort !== imapPort() ||
      before.imapSecure !== imapSecure() ||
      before.imapUser !== imapUser() ||
      before.imapFolder !== imapFolder() ||
      !!password() ||
      clearPassword() ||
      !!imapPassword() ||
      clearImapPassword()
    );
  });

  const save = mutation.create({
    mutation: async (_: void, { abortSignal }) => {
      const user = smtpUser().trim();
      const json = {
        name: name().trim(),
        fromAddress: fromAddress().trim(),
        fromName: fromName().trim() || null,
        smtpHost: smtpHost().trim(),
        smtpPort: smtpPort() ?? 587,
        smtpSecure: smtpSecure(),
        smtpUser: user || null,
        ...(password() ? { smtpPassword: password() } : clearPassword() ? { smtpPassword: null } : {}),
        pacePerMinute: pace() ?? 60,
        dailyRecipientLimit: dailyLimit(),
        maxAttachmentBytes: Math.round((attachmentMb() ?? 15) * MB),
        // The profile is replaced as a whole: leaving IMAP out would turn the bounce check off.
        imap: imapOn()
          ? {
              host: imapHost().trim(),
              port: imapPort() ?? 993,
              secure: imapSecure(),
              user: imapUser().trim(),
              folder: imapFolder().trim(),
              ...(imapPassword() ? { password: imapPassword() } : clearImapPassword() ? { password: null } : {}),
            }
          : null,
        ...(initial ? { revision: initial.revision } : {}),
      };
      const response = await api.profiles[":key"].$put({ param: { key: key() }, json }, { init: { signal: abortSignal } });
      if (!response.ok) throw await failure(response, t().saveFailed, t());
    },
    onSuccess: () => {
      props.onSaved();
      props.close();
    },
  });
  onCleanup(() => save.abort());

  const requestClose = async () => {
    if (save.loading()) return;
    if (await confirmDiscardIfDirty(dirty)) props.close();
  };
  props.setDismissHandler(requestClose);

  return (
    <form
      class="contents"
      onSubmit={(event) => {
        event.preventDefault();
        if (complete() && !save.loading()) void save.mutate(undefined);
      }}
    >
      <PanelDialog>
        <PanelDialog.Header
          title={initial ? t().editProfile : t().newProfile}
          subtitle={initial ? initial.key : undefined}
          icon="ti ti-mail-cog"
          close={() => void requestClose()}
          closeDisabled={save.loading()}
        />
        <PanelDialog.Body scrollPreserveKey="outgoing-mail-profile">
          <PanelDialog.Section title={t().senderSection} subtitle={t().senderSectionDescription}>
            <Show when={!initial}>
              <TextInput
                label={t().key}
                description={t().keyHint}
                value={key()}
                onValueChange={(value) => setKey(value.trim().toLowerCase())}
                error={() => (key() && !keyValid() ? t().keyHint : undefined)}
                disabled={save.loading()}
                required
                maxLength={63}
                monospace
                autocomplete="off"
              />
            </Show>
            <TextInput label={t().name} value={name()} onValueChange={setName} disabled={save.loading()} required maxLength={120} />
            <TextInput
              label={t().fromAddress}
              type="email"
              value={fromAddress()}
              onValueChange={setFromAddress}
              disabled={save.loading()}
              required
              maxLength={320}
              placeholder="noreply@example.org"
            />
            <TextInput
              label={t().fromName}
              description={t().fromNameHint}
              value={fromName()}
              onValueChange={setFromName}
              disabled={save.loading()}
              maxLength={120}
            />
          </PanelDialog.Section>
          <PanelDialog.Section title={t().smtpSection} subtitle={t().smtpSectionDescription}>
            <div class="grid gap-3 sm:grid-cols-[1fr_8rem]">
              <TextInput
                label={t().host}
                value={smtpHost()}
                onValueChange={setSmtpHost}
                disabled={save.loading()}
                required
                maxLength={253}
                placeholder="smtp.example.org"
                autocomplete="off"
              />
              <NumberInput
                label={t().port}
                value={smtpPort()}
                onValueChange={(value) => {
                  setSmtpPort(value);
                  if (!initial && (value === 465 || value === 587 || value === 25)) setSmtpSecure(value === 465);
                }}
                min={1}
                max={65535}
                showSteppers={false}
                disabled={save.loading()}
                required
              />
            </div>
            <Switch
              label={t().secure}
              description={t().secureHint}
              value={smtpSecure()}
              onValueChange={setSmtpSecure}
              disabled={save.loading()}
            />
            <TextInput
              label={t().user}
              description={t().userHint}
              value={smtpUser()}
              onValueChange={setSmtpUser}
              disabled={save.loading()}
              maxLength={320}
              autocomplete="off"
            />
            <TextInput
              label={t().password}
              description={initial?.hasPassword ? t().passwordHostHint : undefined}
              password
              value={password()}
              onValueChange={(value) => {
                setPassword(value);
                if (value) setClearPassword(false);
              }}
              placeholder={passwordNeeded() ? t().passwordReenter : initial?.hasPassword ? t().passwordKeep : t().passwordNone}
              disabled={save.loading() || clearPassword()}
              maxLength={16384}
              autocomplete="new-password"
            />
            <Show when={initial?.hasPassword}>
              <Checkbox
                label={t().clearPassword}
                value={clearPassword()}
                onValueChange={(value) => {
                  setClearPassword(value);
                  if (value) setPassword("");
                }}
                disabled={save.loading()}
              />
            </Show>
          </PanelDialog.Section>
          <PanelDialog.Section title={t().bounceSection} subtitle={t().bounceSectionDescription}>
            <div class="grid gap-3 sm:grid-cols-[1fr_8rem]">
              <TextInput
                label={t().host}
                description={t().imapHostHint}
                value={imapHost()}
                onValueChange={setImapHost}
                disabled={save.loading()}
                maxLength={253}
                placeholder="imap.example.org"
                autocomplete="off"
              />
              <NumberInput
                label={t().port}
                value={imapPort()}
                onValueChange={(value) => {
                  setImapPort(value);
                  if (!imap && (value === 993 || value === 143)) setImapSecure(value === 993);
                }}
                min={1}
                max={65535}
                showSteppers={false}
                disabled={save.loading() || !imapOn()}
                required={imapOn()}
              />
            </div>
            <Switch
              label={t().secure}
              description={t().imapSecureHint}
              value={imapSecure()}
              onValueChange={setImapSecure}
              disabled={save.loading() || !imapOn()}
            />
            <TextInput
              label={t().user}
              description={t().imapUserHint}
              value={imapUser()}
              onValueChange={setImapUser}
              disabled={save.loading() || !imapOn()}
              required={imapOn()}
              maxLength={320}
              autocomplete="off"
            />
            <TextInput
              label={t().password}
              description={imap?.hasPassword ? t().passwordHostHint : undefined}
              password
              value={imapPassword()}
              onValueChange={(value) => {
                setImapPassword(value);
                if (value) setClearImapPassword(false);
              }}
              placeholder={imapPasswordNeeded() ? t().passwordReenter : imap?.hasPassword ? t().passwordKeep : t().passwordNone}
              disabled={save.loading() || !imapOn() || clearImapPassword()}
              maxLength={16384}
              autocomplete="new-password"
            />
            <Show when={imap?.hasPassword}>
              <Checkbox
                label={t().clearPassword}
                value={clearImapPassword()}
                onValueChange={(value) => {
                  setClearImapPassword(value);
                  if (value) setImapPassword("");
                }}
                disabled={save.loading() || !imapOn()}
              />
            </Show>
            <TextInput
              label={t().folder}
              description={t().folderHint}
              value={imapFolder()}
              onValueChange={setImapFolder}
              disabled={save.loading() || !imapOn()}
              required={imapOn()}
              maxLength={200}
              autocomplete="off"
            />
          </PanelDialog.Section>
          <PanelDialog.Section title={t().limitsSection} subtitle={t().limitsSectionDescription}>
            <NumberInput
              label={t().pace}
              description={t().paceHint}
              value={pace()}
              onValueChange={setPace}
              min={1}
              max={6000}
              disabled={save.loading()}
              required
            />
            <NumberInput
              label={t().dailyLimit}
              description={t().dailyLimitHint}
              value={dailyLimit()}
              onValueChange={setDailyLimit}
              min={1}
              clearable
              disabled={save.loading()}
            />
            <NumberInput
              label={t().maxAttachment}
              description={t().maxAttachmentHint}
              value={attachmentMb()}
              onValueChange={setAttachmentMb}
              min={0.1}
              max={25}
              step={0.1}
              disabled={save.loading()}
              required
            />
          </PanelDialog.Section>
          <Show when={save.error()}>{(error) => <NoticeCard tone="danger" title={t().saveFailed} detail={error().message} />}</Show>
        </PanelDialog.Body>
        <PanelDialog.Footer>
          <Button type="button" variant="secondary" size="sm" onClick={() => void requestClose()} disabled={save.loading()}>
            {t().cancel}
          </Button>
          <Button type="submit" size="sm" disabled={!complete() || save.loading() || (!!initial && !dirty())}>
            {initial ? t().save : t().create}
          </Button>
        </PanelDialog.Footer>
      </PanelDialog>
    </form>
  );
}

function TestDialog(props: { profile: AdminMailProfile; close: () => void }) {
  const t = messages();
  const [recipient, setRecipient] = createSignal("");
  const send = mutation.create({
    mutation: async (_: void, { abortSignal }) => {
      const response = await api.profiles[":key"].test.$post(
        { param: { key: props.profile.key }, json: { recipient: recipient().trim() } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw await failure(response, t().testFailed, t());
    },
    onSuccess: () => {
      toast.success(t().testSent({ recipient: recipient().trim() }));
      props.close();
    },
  });
  onCleanup(() => send.abort());
  return (
    <form
      class="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (recipient().trim() && !send.loading()) void send.mutate(undefined);
      }}
    >
      <p class="text-sm text-secondary">{t().testDescription({ name: props.profile.name })}</p>
      <TextInput
        label={t().recipient}
        type="email"
        value={recipient()}
        onValueChange={setRecipient}
        disabled={send.loading()}
        required
        autofocus
      />
      <Show when={send.error()}>{(error) => <NoticeCard tone="danger" title={t().testFailed} detail={error().message} />}</Show>
      <div class="flex justify-end gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={() => props.close()} disabled={send.loading()}>
          {t().cancel}
        </Button>
        <Button type="submit" size="sm" disabled={!recipient().trim() || send.loading()}>
          <i class="ti ti-send" aria-hidden="true" />
          {t().send}
        </Button>
      </div>
    </form>
  );
}

/** Exported for the layout test: the dialog keeps one height through every mode and selection. */
export function AccessDialog(props: { app: AdminMailApp; profiles: readonly AdminMailProfile[]; close: () => void; onSaved: () => void }) {
  const t = messages();
  const initialMode: AccessMode = props.app.mode === "default" ? "default" : props.app.profiles.length ? "selected" : "none";
  const [mode, setMode] = createSignal<AccessMode>(initialMode);
  const [selected, setSelected] = createSignal<string[]>(props.app.profiles);
  const defaultProfile = () => props.profiles.find((profile) => profile.isDefault);
  const valid = () => mode() !== "selected" || selected().length > 0;
  const save = mutation.create({
    mutation: async (_: void, { abortSignal }) => {
      const json =
        mode() === "default" ? { mode: "default" as const } : { mode: "selected" as const, profiles: mode() === "none" ? [] : selected() };
      const response = await api.apps[":appId"].$put({ param: { appId: props.app.appId }, json }, { init: { signal: abortSignal } });
      if (!response.ok) throw await failure(response, t().accessFailed, t());
    },
    onSuccess: () => {
      props.onSaved();
      props.close();
    },
  });
  onCleanup(() => save.abort());
  const toggle = (key: string, checked: boolean) =>
    setSelected((current) => (checked ? [...new Set([...current, key])] : current.filter((entry) => entry !== key)));
  // Every mode shows the same profile list, read-only outside "Selected profiles", so the centered
  // dialog never changes height while the administrator switches modes or toggles profiles.
  const usable = (profile: AdminMailProfile) =>
    mode() === "selected" ? selected().includes(profile.key) : mode() === "default" && profile.isDefault;
  const hints = (): { mode: AccessMode; text: string }[] => [
    {
      mode: "default",
      text: defaultProfile() ? t().accessDefaultHint({ name: defaultProfile()!.name }) : t().accessDefaultHintNone,
    },
    { mode: "selected", text: t().accessSelectedHint },
    { mode: "none", text: t().accessNoneHint },
  ];
  return (
    <form
      class="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid() && !save.loading()) void save.mutate(undefined);
      }}
    >
      <Show when={!props.app.declared}>
        <NoticeCard tone="warning" title={t().notDeclaredNotice} />
      </Show>
      <SegmentedControl<AccessMode>
        ariaLabel={t().access}
        value={mode}
        onValueChange={setMode}
        disabled={save.loading()}
        options={[
          { value: "default", label: t().accessDefault },
          { value: "selected", label: t().accessSelected },
          { value: "none", label: t().accessNone },
        ]}
      />
      {/* The hints share one grid cell: the longest one reserves the space for all of them. */}
      <div class="grid">
        <For each={hints()}>
          {(hint) => (
            <p class="text-sm text-secondary [grid-area:1/1]" classList={{ invisible: mode() !== hint.mode }} data-access-hint={hint.mode}>
              {hint.text}
            </p>
          )}
        </For>
      </div>
      <Show when={props.profiles.length}>
        <div class="flex flex-col gap-2" role="group" aria-label={t().profiles}>
          <For each={props.profiles}>
            {(profile) => (
              <CheckboxCard
                variant="input"
                label={profile.name}
                description={profile.fromAddress}
                value={usable(profile)}
                onValueChange={(checked) => toggle(profile.key, checked)}
                disabled={save.loading() || mode() !== "selected"}
              />
            )}
          </For>
        </div>
      </Show>
      <Show when={save.error()}>{(error) => <NoticeCard tone="danger" title={t().accessFailed} detail={error().message} />}</Show>
      <div class="flex justify-end gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={() => props.close()} disabled={save.loading()}>
          {t().cancel}
        </Button>
        <Button type="submit" size="sm" disabled={!valid() || save.loading()}>
          {t().save}
        </Button>
      </div>
    </form>
  );
}

/** Exported for the layout test: toggling apps never changes the dialog's height. */
export function LogAccessDialog(props: { app: AdminMailApp; apps: readonly AdminMailApp[]; close: () => void; onSaved: () => void }) {
  const t = messages();
  const [selected, setSelected] = createSignal<string[]>(props.app.logApps);
  // Core's system email is never readable by apps; grants for apps that went offline stay visible.
  const candidates = () =>
    [
      ...props.apps.filter((app) => app.appId !== props.app.appId && app.appId !== CORE_APP_ID),
      ...props.app.logApps
        .filter((id) => !props.apps.some((app) => app.appId === id))
        .map((id): Pick<AdminMailApp, "appId" | "name" | "registered"> => ({ appId: id, name: id, registered: false })),
    ].sort((a, b) => a.name.localeCompare(b.name) || a.appId.localeCompare(b.appId));
  const save = mutation.create({
    mutation: async (_: void, { abortSignal }) => {
      const response = await api.apps[":appId"]["log-access"].$put(
        { param: { appId: props.app.appId }, json: { apps: selected() } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw await failure(response, t().logAccessFailed, t());
    },
    onSuccess: () => {
      props.onSaved();
      props.close();
    },
  });
  onCleanup(() => save.abort());
  const toggle = (appId: string, checked: boolean) =>
    setSelected((current) => (checked ? [...new Set([...current, appId])] : current.filter((entry) => entry !== appId)));
  return (
    <form
      class="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!save.loading()) void save.mutate(undefined);
      }}
    >
      <Show when={!props.app.readDeclared}>
        <NoticeCard tone="warning" title={t().logAccessNotDeclared} />
      </Show>
      <p class="text-sm text-secondary">{t().logAccessHint}</p>
      <Show when={candidates().length} fallback={<p class="text-sm text-dimmed">{t().noOtherApps}</p>}>
        <div class="flex flex-col gap-2" role="group" aria-label={t().apps}>
          <For each={candidates()}>
            {(app) => (
              <CheckboxCard
                variant="input"
                label={app.name}
                description={app.registered ? app.appId : `${app.appId} · ${t().notRegistered}`}
                value={selected().includes(app.appId)}
                onValueChange={(checked) => toggle(app.appId, checked)}
                disabled={save.loading()}
              />
            )}
          </For>
        </div>
      </Show>
      <Show when={save.error()}>{(error) => <NoticeCard tone="danger" title={t().logAccessFailed} detail={error().message} />}</Show>
      <div class="flex justify-end gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={() => props.close()} disabled={save.loading()}>
          {t().cancel}
        </Button>
        <Button type="submit" size="sm" disabled={save.loading()}>
          {t().save}
        </Button>
      </div>
    </form>
  );
}

export default function OutgoingMail(props: Props) {
  const t = messages();
  const [revision, setRevision] = createSignal(0);
  const state = query.create({
    source: () => revision(),
    load: async (current, { abortSignal }): Promise<SendersState> => (current === 0 ? props.initial : loadState(abortSignal, t())),
  });
  const data = () => state.data() ?? props.initial;
  const refresh = () => setRevision((value) => value + 1);
  const busy = () => state.refreshing();

  const openEditor = (profile?: AdminMailProfile) =>
    void dialogCore.open<void>(
      (close, context) => (
        <ProfileDialog profile={profile} close={() => close()} onSaved={refresh} setDismissHandler={context.setDismissHandler} />
      ),
      panelDialogOptions,
    );
  const openTest = (profile: AdminMailProfile) =>
    void prompts.dialog<void>((close) => <TestDialog profile={profile} close={() => close()} />, {
      title: t().testTitle,
      icon: "ti ti-send",
    });
  const openAccess = (app: AdminMailApp) =>
    void prompts.dialog<void>((close) => <AccessDialog app={app} profiles={data().profiles} close={() => close()} onSaved={refresh} />, {
      title: `${t().accessTitle}: ${app.name}`,
      icon: "ti ti-mail-share",
    });
  const openLogAccess = (app: AdminMailApp) =>
    void prompts.dialog<void>((close) => <LogAccessDialog app={app} apps={data().apps.items} close={() => close()} onSaved={refresh} />, {
      title: `${t().logAccessTitle}: ${app.name}`,
      icon: "ti ti-list-search",
    });

  const makeDefault = async (profile: AdminMailProfile) => {
    const confirmed = await prompts.confirm(t().defaultConfirm({ name: profile.name }), {
      title: t().defaultTitle,
      icon: "ti ti-star",
      confirmText: t().makeDefault,
    });
    if (!confirmed) return;
    const response = await api.profiles[":key"].default.$post({ param: { key: profile.key } });
    if (!response.ok) return void toast.error((await failure(response, t().defaultFailed, t())).message);
    refresh();
  };
  const remove = async (profile: AdminMailProfile) => {
    const confirmed = await prompts.confirm(t().deleteConfirm({ name: profile.name }), {
      title: t().deleteTitle,
      icon: "ti ti-trash",
      variant: "danger",
      confirmText: t().delete,
    });
    if (!confirmed) return;
    const response = await api.profiles[":key"].$delete({ param: { key: profile.key } });
    if (!response.ok) return void toast.error((await failure(response, t().deleteFailed, t())).message);
    refresh();
  };

  const profileColumns = (): DataTableColumn<AdminMailProfile>[] => [
    { id: "profile", header: t().profile },
    // On a phone the first column carries the sender, so the actions stay on screen.
    { id: "sender", header: t().sender, class: "hidden md:table-cell" },
    { id: "server", header: t().server, class: "hidden lg:table-cell" },
    { id: "limits", header: t().limits, class: "hidden lg:table-cell" },
    { id: "actions", header: <span class="sr-only">{t().actions}</span>, headerClass: "w-px", cellClass: "text-right whitespace-nowrap" },
  ];
  const appColumns = (): DataTableColumn<AdminMailApp>[] => [
    { id: "app", header: t().app },
    { id: "access", header: t().access, class: "hidden md:table-cell" },
    { id: "log", header: t().logAccess, class: "hidden lg:table-cell" },
    { id: "actions", header: <span class="sr-only">{t().actions}</span>, headerClass: "w-px", cellClass: "text-right whitespace-nowrap" },
  ];
  const apps = () => [...data().apps.items].sort((a, b) => Number(b.declared) - Number(a.declared) || a.name.localeCompare(b.name));

  return (
    <div class="flex flex-col gap-8">
      <header class="min-w-0">
        <h1 class="text-base font-semibold text-primary">{t().title}</h1>
        <p class="mt-1 text-xs text-dimmed">{t().description}</p>
      </header>

      <Show when={state.error()}>
        {(error) => (
          <NoticeCard tone="danger" title={t().loadFailed} detail={error().message}>
            <Button size="sm" onClick={() => void state.refresh()} disabled={busy()}>
              {t().retry}
            </Button>
          </NoticeCard>
        )}
      </Show>

      <section class="flex flex-col gap-3" aria-labelledby="outgoing-mail-profiles">
        <div class="flex flex-wrap items-end justify-between gap-2">
          <div class="min-w-0 flex-1">
            <h2 id="outgoing-mail-profiles" class="text-sm font-semibold text-primary">
              {t().profiles}
            </h2>
            <p class="mt-1 text-xs text-dimmed">{t().profilesDescription}</p>
          </div>
          <Button type="button" variant="secondary" size="sm" onClick={() => openEditor()} disabled={busy()}>
            <i class="ti ti-plus" aria-hidden="true" />
            {t().addProfile}
          </Button>
        </div>
        <Show
          when={data().profiles.length}
          fallback={<Placeholder surface="paper" icon="ti ti-mail-off" title={t().noProfiles} description={t().noProfilesDescription} />}
        >
          <DataTable
            ariaLabel={t().profiles}
            rows={data().profiles}
            columns={profileColumns()}
            getRowId={(row) => row.key}
            hoverRows={false}
            highlightColumns={false}
            stickyHeader={false}
            surface="paper"
            verticalAlign="top"
            renderCell={({ row, col }) => {
              if (col.id === "profile")
                return (
                  <div class="min-w-0">
                    <div class="flex items-center gap-2">
                      <span class="truncate text-sm font-medium text-primary">{row.name}</span>
                      <Show when={row.isDefault}>
                        <StatusBadge tone="info" icon={null} label={t().defaultBadge} />
                      </Show>
                    </div>
                    <p class="mt-0.5 font-mono text-xs text-dimmed">{row.key}</p>
                    <p class="mt-0.5 truncate text-xs text-dimmed md:hidden">{row.fromAddress}</p>
                    {/* Below lg the server column is hidden, so the bounce check moves here. */}
                    <BounceStatus profile={row} t={t()} class="lg:hidden" />
                  </div>
                );
              if (col.id === "sender")
                return (
                  <div class="min-w-44">
                    <p class="text-sm text-secondary">{row.fromAddress}</p>
                    <p class="mt-0.5 text-xs text-dimmed">{row.fromName ?? t().fromAppName}</p>
                  </div>
                );
              if (col.id === "server")
                return (
                  <div class="min-w-40">
                    <p class="text-sm text-secondary">
                      {row.smtpHost}:{row.smtpPort}
                    </p>
                    <p class="mt-0.5 text-xs text-dimmed">
                      {row.smtpSecure ? t().encrypted : t().startTls}
                      {row.smtpUser ? ` · ${row.smtpUser}` : ""}
                    </p>
                    <BounceStatus profile={row} t={t()} />
                  </div>
                );
              if (col.id === "limits")
                return (
                  <div class="min-w-32">
                    <p class="text-sm tabular-nums text-secondary">{t().perMinute({ count: row.pacePerMinute })}</p>
                    <p class="mt-0.5 text-xs tabular-nums text-dimmed">
                      {row.dailyRecipientLimit ? t().perDay({ count: row.dailyRecipientLimit }) : t().unlimited}
                    </p>
                  </div>
                );
              if (col.id === "actions")
                return (
                  <div class="flex justify-end gap-1">
                    <Button type="button" variant="ghost" size="sm" onClick={() => openEditor(row)} disabled={busy()}>
                      {t().edit}
                    </Button>
                    <Dropdown.Root
                      align="end"
                      width="14rem"
                      items={[
                        {
                          items: [
                            { icon: "ti ti-send", label: t().sendTest, action: () => openTest(row) },
                            ...(row.isDefault
                              ? []
                              : [
                                  { icon: "ti ti-star", label: t().makeDefault, action: () => void makeDefault(row) },
                                  {
                                    icon: "ti ti-trash",
                                    label: t().delete,
                                    variant: "danger" as const,
                                    action: () => void remove(row),
                                  },
                                ]),
                          ],
                        },
                      ]}
                    >
                      <Dropdown.Trigger iconOnly label={t().profileActions({ name: row.name })} size="sm" disabled={busy()}>
                        <i class="ti ti-dots" aria-hidden="true" />
                      </Dropdown.Trigger>
                    </Dropdown.Root>
                  </div>
                );
              return "";
            }}
          />
        </Show>
      </section>

      <section class="flex flex-col gap-3" aria-labelledby="outgoing-mail-apps">
        <div class="min-w-0">
          <h2 id="outgoing-mail-apps" class="text-sm font-semibold text-primary">
            {t().apps}
          </h2>
          <p class="mt-1 text-xs text-dimmed">{t().appsDescription}</p>
        </div>
        <DataTable
          ariaLabel={t().apps}
          rows={apps()}
          columns={appColumns()}
          getRowId={(row) => row.appId}
          hoverRows={false}
          highlightColumns={false}
          stickyHeader={false}
          surface="paper"
          verticalAlign="top"
          empty={t().noApps}
          renderCell={({ row, col }) => {
            if (col.id === "app")
              return (
                <div class="min-w-0">
                  <p class="truncate text-sm font-medium text-primary">{row.name}</p>
                  <p class="mt-0.5 text-xs text-dimmed">
                    {row.appId === CORE_APP_ID
                      ? t().systemMail
                      : !row.registered
                        ? t().notRegistered
                        : row.declared
                          ? t().requested
                          : t().notRequested}
                  </p>
                  <p class="mt-0.5 text-xs text-secondary md:hidden">{accessLabel(row, data().profiles, t())}</p>
                  {/* Below lg the send log column is hidden; only apps that read more than their own mail mention it here. */}
                  <Show when={row.appId !== CORE_APP_ID && row.logApps.length}>
                    <p class="mt-0.5 text-xs text-secondary lg:hidden">
                      {t().logAccess}: {logLabel(row, data().apps.items, t())}
                    </p>
                  </Show>
                </div>
              );
            if (col.id === "access")
              return (
                <div class="min-w-40">
                  <p class={`text-sm ${row.declared ? "text-secondary" : "text-dimmed"}`}>{accessLabel(row, data().profiles, t())}</p>
                </div>
              );
            if (col.id === "log")
              return (
                <Show when={row.appId !== CORE_APP_ID}>
                  <div class="min-w-40">
                    <p class={`text-sm ${row.readDeclared ? "text-secondary" : "text-dimmed"}`}>{logLabel(row, data().apps.items, t())}</p>
                    <p class="mt-0.5 text-xs text-dimmed">{row.readDeclared ? t().logRequested : t().logNotRequested}</p>
                  </div>
                </Show>
              );
            if (col.id === "actions")
              return (
                <Show when={row.appId !== CORE_APP_ID}>
                  <div class="flex justify-end gap-1">
                    {/* On a phone the text button would push the menu out of view; the menu offers both. */}
                    <span class="hidden md:inline-flex">
                      <Button type="button" variant="ghost" size="sm" onClick={() => openAccess(row)} disabled={busy()}>
                        {t().changeAccess}
                      </Button>
                    </span>
                    <Dropdown.Root
                      align="end"
                      width="16rem"
                      items={[
                        {
                          items: [
                            { icon: "ti ti-mail-share", label: t().changeSenderAccess, action: () => openAccess(row) },
                            { icon: "ti ti-list-search", label: t().changeLogAccess, action: () => openLogAccess(row) },
                          ],
                        },
                      ]}
                    >
                      <Dropdown.Trigger iconOnly label={t().appActions({ name: row.name })} size="sm" disabled={busy()}>
                        <i class="ti ti-dots" aria-hidden="true" />
                      </Dropdown.Trigger>
                    </Dropdown.Root>
                  </div>
                </Show>
              );
            return "";
          }}
        />
      </section>

      <SendLog initial={props.initial.log} apps={data().apps.items} />
    </div>
  );
}
