import type { AdminMailProfile } from "@k2b/cloud/contracts";
import { navigateTo } from "@k2b/ssr/nav";
import { useLocale } from "@k2b/ui";
import { Bar, Button, Check, Dialog, Field, Input, Notice, Section } from "@k2b/ui/v2";
import { createMemo, createSignal, type JSX, Show } from "solid-js";
import { outgoingMailMessages } from "./messages";
import { api, failure, MB } from "./shared";

const number = (value: string): number | null => {
  if (!value.trim()) return null;
  const parsed = Number(value.replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
};
const text = (value: number | null) => (value === null ? "" : String(value));

/**
 * One sender profile as a form on v2: sender, SMTP server, bounce mailbox (IMAP) and limits. Saving replaces the whole
 * profile, its IMAP mailbox included; a saved password stays unless it is replaced or cleared, and never follows the
 * profile to another server. `start` holds deeds of the open profile, such as "Send test".
 */
export default function ProfileForm(props: { profile?: AdminMailProfile; onSaved: () => void; cancelHref: string; start?: JSX.Element }) {
  const locale = useLocale();
  const t = () => outgoingMailMessages.resolve([locale()]).t;
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
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
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
  const dirty = createMemo(
    () =>
      (initial?.key ?? "") !== key() ||
      (initial?.name ?? "") !== name() ||
      (initial?.fromAddress ?? "") !== fromAddress() ||
      (initial?.fromName ?? "") !== fromName() ||
      (initial?.smtpHost ?? "") !== smtpHost() ||
      (initial?.smtpPort ?? 587) !== smtpPort() ||
      (initial?.smtpSecure ?? false) !== smtpSecure() ||
      (initial?.smtpUser ?? "") !== smtpUser() ||
      (initial?.pacePerMinute ?? 60) !== pace() ||
      (initial?.dailyRecipientLimit ?? null) !== dailyLimit() ||
      (initial ? initial.maxAttachmentBytes / MB : 15) !== attachmentMb() ||
      (imap?.host ?? "") !== imapHost() ||
      (imap?.port ?? 993) !== imapPort() ||
      (imap?.secure ?? true) !== imapSecure() ||
      (imap?.user ?? "") !== imapUser() ||
      (imap?.folder ?? "INBOX") !== imapFolder() ||
      !!password() ||
      clearPassword() ||
      !!imapPassword() ||
      clearImapPassword(),
  );

  const save = async () => {
    if (!complete() || saving()) return;
    setSaving(true);
    setError(null);
    try {
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
      const response = await api.profiles[":key"].$put({ param: { key: key() }, json });
      if (!response.ok) throw await failure(response, t().saveFailed, t());
      props.onSaved();
    } catch (failed) {
      setError(failed instanceof Error ? failed.message : t().saveFailed);
    } finally {
      setSaving(false);
    }
  };

  /** Back to the list; a changed draft asks first, as the dialog did. */
  const leave = async () => {
    if (dirty() && !(await Dialog.confirm({ title: t().discardQuestion, confirm: t().discard }))) return;
    navigateTo(props.cancelHref);
  };

  const passwordFields = (options: {
    has: boolean;
    needed: () => boolean;
    value: () => string;
    set: (value: string) => void;
    clear: () => boolean;
    setClear: (value: boolean) => void;
    off?: () => boolean;
    name: string;
  }) => (
    <>
      <Field name={options.name} label={t().password} hint={options.has ? t().passwordHostHint : undefined} optional={t().optional}>
        <Input
          type="password"
          value={options.value()}
          placeholder={options.needed() ? t().passwordReenter : options.has ? t().passwordKeep : t().passwordNone}
          disabled={saving() || options.clear() || options.off?.() === true}
          onInput={(value) => {
            options.set(value);
            if (value) options.setClear(false);
          }}
        />
      </Field>
      <Show when={options.has}>
        <Check
          label={t().clearPassword}
          checked={options.clear()}
          disabled={saving() || options.off?.() === true}
          onChange={(value) => {
            options.setClear(value);
            if (value) options.set("");
          }}
        />
      </Show>
    </>
  );

  return (
    <>
      <Show when={error()}>
        {(message) => (
          <Notice tone="bad" title={t().saveFailed}>
            {message()}
          </Notice>
        )}
      </Show>
      <Section icon="mail" title={t().senderSection} summary={t().senderSectionDescription}>
        <Show when={!initial}>
          <Field name="key" label={t().key} hint={t().keyHint} error={key() && !keyValid() ? t().keyHint : undefined} required>
            <Input value={key()} disabled={saving()} onInput={(value) => setKey(value.trim().toLowerCase())} />
          </Field>
        </Show>
        <Field name="name" label={t().name} required>
          <Input value={name()} disabled={saving()} onInput={setName} />
        </Field>
        <Field name="fromAddress" label={t().fromAddress} required>
          <Input type="email" value={fromAddress()} placeholder="noreply@example.org" disabled={saving()} onInput={setFromAddress} />
        </Field>
        <Field name="fromName" label={t().fromName} hint={t().fromNameHint} optional={t().optional}>
          <Input value={fromName()} disabled={saving()} onInput={setFromName} />
        </Field>
      </Section>
      <Section icon="server" title={t().smtpSection} summary={t().smtpSectionDescription}>
        <Field.Row>
          <Field name="smtpHost" label={t().host} required>
            <Input value={smtpHost()} placeholder="smtp.example.org" disabled={saving()} onInput={setSmtpHost} />
          </Field>
          <Field name="smtpPort" label={t().port} required>
            <Input
              type="number"
              min={1}
              max={65535}
              value={text(smtpPort())}
              disabled={saving()}
              onInput={(value) => {
                const port = number(value);
                setSmtpPort(port);
                if (!initial && (port === 465 || port === 587 || port === 25)) setSmtpSecure(port === 465);
              }}
            />
          </Field>
        </Field.Row>
        <Check switch label={t().secure} checked={smtpSecure()} disabled={saving()} onChange={setSmtpSecure} />
        <Field name="smtpUser" label={t().user} hint={t().userHint} optional={t().optional}>
          <Input value={smtpUser()} disabled={saving()} onInput={setSmtpUser} />
        </Field>
        {passwordFields({
          name: "smtpPassword",
          has: !!initial?.hasPassword,
          needed: passwordNeeded,
          value: password,
          set: setPassword,
          clear: clearPassword,
          setClear: setClearPassword,
        })}
      </Section>
      <Section icon="mail-exclamation" title={t().bounceSection} summary={t().bounceSectionDescription}>
        <Field.Row>
          <Field name="imapHost" label={t().host} hint={t().imapHostHint} optional={t().optional}>
            <Input value={imapHost()} placeholder="imap.example.org" disabled={saving()} onInput={setImapHost} />
          </Field>
          <Field name="imapPort" label={t().port}>
            <Input
              type="number"
              min={1}
              max={65535}
              value={text(imapPort())}
              disabled={saving() || !imapOn()}
              onInput={(value) => {
                const port = number(value);
                setImapPort(port);
                if (!imap && (port === 993 || port === 143)) setImapSecure(port === 993);
              }}
            />
          </Field>
        </Field.Row>
        <Check switch label={t().secure} checked={imapSecure()} disabled={saving() || !imapOn()} onChange={setImapSecure} />
        <Field name="imapUser" label={t().user} hint={t().imapUserHint}>
          <Input value={imapUser()} disabled={saving() || !imapOn()} onInput={setImapUser} />
        </Field>
        {passwordFields({
          name: "imapPassword",
          has: !!imap?.hasPassword,
          needed: imapPasswordNeeded,
          value: imapPassword,
          set: setImapPassword,
          clear: clearImapPassword,
          setClear: setClearImapPassword,
          off: () => !imapOn(),
        })}
        <Field name="imapFolder" label={t().folder} hint={t().folderHint}>
          <Input value={imapFolder()} disabled={saving() || !imapOn()} onInput={setImapFolder} />
        </Field>
      </Section>
      <Section icon="gauge" title={t().limitsSection} summary={t().limitsSectionDescription}>
        <Field.Row>
          <Field name="pace" label={t().pace} hint={t().paceHint} required>
            <Input type="number" min={1} max={6000} value={text(pace())} disabled={saving()} onInput={(value) => setPace(number(value))} />
          </Field>
          <Field name="dailyLimit" label={t().dailyLimit} hint={t().dailyLimitHint} optional={t().optional}>
            <Input type="number" min={1} value={text(dailyLimit())} disabled={saving()} onInput={(value) => setDailyLimit(number(value))} />
          </Field>
        </Field.Row>
        <Field name="maxAttachment" label={t().maxAttachment} hint={t().maxAttachmentHint} required>
          <Input
            type="number"
            min={0.1}
            max={25}
            value={text(attachmentMb())}
            disabled={saving()}
            onInput={(value) => setAttachmentMb(number(value))}
          />
        </Field>
      </Section>
      <Bar
        start={props.start}
        end={
          <>
            <Button disabled={saving()} onClick={() => void leave()}>
              {t().cancel}
            </Button>
            <Button busy={saving()} disabled={!complete() || (!!initial && !dirty())} onClick={() => void save()}>
              {initial ? t().save : t().create}
            </Button>
          </>
        }
      />
    </>
  );
}
