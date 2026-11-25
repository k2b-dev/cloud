import { Button, DateInput, Dialog, Facts, Field, Input, Lookup, type LookupLoad, Notice, Text } from "@k2b/ui/v2";
import { createSignal, For, Show } from "solid-js";
import { z } from "zod";
import type { User } from "@/contracts";
import { useAccountsMessages } from "../../messages";
import { useUserRecordMessages } from "./messages";
import { emailRules } from "./user-actions";
import { addMembership, editUser, notifyUser, setExpiry } from "./user-requests";

/** A dialog that changes something closes with `true`, so the page shows the change. */
type Close = (changed: boolean) => void;

/**
 * Editing a person's name and address: the same rules as the server, so the form, not a refusal, says when an address
 * must stay. Emptying an address that may go asks first, because it ends email sign-in and email notifications.
 */
export function EditUserDialog(props: { user: User; localEmailOptional: boolean; open: boolean; close: Close }) {
  const t = useAccountsMessages();
  const r = useUserRecordMessages();
  const [givenname, setGivenname] = createSignal(props.user.givenname);
  const [sn, setSn] = createSignal(props.user.sn);
  const [displayName, setDisplayName] = createSignal(props.user.displayName);
  const [mail, setMail] = createSignal(props.user.mail ?? "");
  const [phone, setPhone] = createSignal(props.user.ipa?.phone ?? "");
  const [tried, setTried] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const ipa = () => props.user.provider === "ipa";
  const emailRemovable = () => emailRules(props.user, props.localEmailOptional).removable;
  const mailRequired = () => emailRules(props.user, props.localEmailOptional).required;
  const missing = (value: string) => (tried() && !value.trim() ? r().required : undefined);
  const save = async () => {
    setTried(true);
    if (busy()) return;
    if (!givenname().trim() || !sn().trim() || !displayName().trim() || (mailRequired() && !mail().trim())) return;
    const address = mail().trim();
    // Removing an address ends email sign-in and email notifications for this person.
    if (!address && props.user.mail) {
      const agreed = await Dialog.confirm({
        title: t().removeEmailQuestion({ email: props.user.mail }),
        description: t().removeEmailDescription({ name: props.user.displayName || props.user.uid }),
        confirm: t().removeEmail,
        cancel: t().cancel,
      });
      if (!agreed) return;
    }
    setBusy(true);
    setError(null);
    try {
      await editUser(
        props.user,
        {
          givenname: givenname(),
          sn: sn(),
          displayName: displayName(),
          // An emptied field removes the address; the server still decides whether this account may lack one.
          mail: address || (props.user.mail ? null : undefined),
          ...(ipa() ? { ipa: { phone: phone() || undefined } } : {}),
        },
        t(),
      );
      props.close(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t().updateUserFailed);
    } finally {
      setBusy(false);
    }
  };
  const enter = (event: KeyboardEvent) => {
    if (event.key === "Enter" && !event.isComposing) void save();
  };
  return (
    <Dialog
      title={t().editUser}
      open={props.open}
      onOpenChange={(open) => {
        if (!open && !busy()) props.close(false);
      }}
      foot={
        <>
          <Button onClick={() => props.close(false)} disabled={busy()}>
            {t().cancel}
          </Button>
          <Button variant="primary" icon="check" busy={busy()} onClick={() => void save()}>
            {t().save}
          </Button>
        </>
      }
    >
      <Field.Row>
        <Field name="givenname" label={t().firstName} error={missing(givenname())} required>
          <Input value={givenname()} onInput={setGivenname} onKeyDown={enter} disabled={busy()} />
        </Field>
        <Field name="sn" label={t().lastName} error={missing(sn())} required>
          <Input value={sn()} onInput={setSn} onKeyDown={enter} disabled={busy()} />
        </Field>
      </Field.Row>
      <Field name="displayName" label={t().displayName} error={missing(displayName())} required>
        <Input value={displayName()} onInput={setDisplayName} onKeyDown={enter} disabled={busy()} />
      </Field>
      <Show when={ipa()}>
        <Notice tone="warn">{t().emailSyncWarning}</Notice>
      </Show>
      <Field
        name="mail"
        label={t().email}
        hint={emailRemovable() ? t().emailOptionalHelp : undefined}
        optional={mailRequired() ? undefined : r().emailOptional}
        error={mailRequired() ? missing(mail()) : undefined}
        required={mailRequired()}
      >
        <Input type="email" value={mail()} onInput={setMail} onKeyDown={enter} disabled={busy()} />
      </Field>
      <Show when={ipa()}>
        <Field name="phone" label={t().phone} hint={t().visibleToAccounts} optional={r().emailOptional}>
          <Input type="tel" value={phone()} placeholder={t().phonePlaceholder} onInput={setPhone} onKeyDown={enter} disabled={busy()} />
        </Field>
      </Show>
      <Show when={error()}>
        {(message) => (
          <Notice tone="bad" icon="alert-circle">
            {message()}
          </Notice>
        )}
      </Show>
    </Dialog>
  );
}

/** A message to the person through Cloud's notifications: a subject and plain text, sent as escaped paragraphs. */
export function NotifyDialog(props: { user: User; open: boolean; close: (sent: string | null) => void }) {
  const t = useAccountsMessages();
  const r = useUserRecordMessages();
  const [subject, setSubject] = createSignal("");
  const [content, setContent] = createSignal("");
  const [tried, setTried] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const missing = (value: string) => (tried() && !value.trim() ? r().required : undefined);
  const send = async () => {
    setTried(true);
    if (busy() || !subject().trim() || !content().trim()) return;
    setBusy(true);
    setError(null);
    try {
      props.close((await notifyUser(props.user, subject(), content(), t())) ?? r().notified);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t().notifyFailed);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={t().notifyUser({ name: props.user.displayName || props.user.uid })}
      open={props.open}
      onOpenChange={(open) => {
        if (!open && !busy()) props.close(null);
      }}
      foot={
        <>
          <Button onClick={() => props.close(null)} disabled={busy()}>
            {t().cancel}
          </Button>
          <Button variant="primary" icon="send" busy={busy()} onClick={() => void send()}>
            {t().send}
          </Button>
        </>
      }
    >
      <Field name="subject" label={t().subject} error={missing(subject())} required>
        <Input value={subject()} placeholder={t().notificationSubjectPlaceholder} onInput={setSubject} disabled={busy()} />
      </Field>
      <Field name="content" label={t().message} error={missing(content())} required>
        <Input multiline value={content()} placeholder={t().notificationMessagePlaceholder} onInput={setContent} disabled={busy()} />
      </Field>
      <Show when={error()}>
        {(message) => (
          <Notice tone="bad" icon="alert-circle">
            {message()}
          </Notice>
        )}
      </Show>
    </Dialog>
  );
}

/** A day as the expiry takes it ("2026-12-31"), from the field's text; also "31.12.2026". Null when it is no day. */
export const dayFromText = (text: string): string | null => {
  const value = text.trim();
  const german = value.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  const iso = german ? `${german[3]}-${german[2]!.padStart(2, "0")}-${german[1]!.padStart(2, "0")}` : value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const date = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(iso) ? iso : null;
};

/** When the account stops working: a day, or never (which asks once more). */
export function ExpiryDialog(props: { user: User; open: boolean; close: Close }) {
  const t = useAccountsMessages();
  const r = useUserRecordMessages();
  const [text, setText] = createSignal(props.user.accountExpires ? new Date(props.user.accountExpires).toISOString().slice(0, 10) : "");
  const [tried, setTried] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const day = () => dayFromText(text());
  const save = async (value: string | null) => {
    if (busy()) return;
    setBusy(true);
    setError(null);
    try {
      await setExpiry(props.user, value, t());
      props.close(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t().setExpiryFailed);
    } finally {
      setBusy(false);
    }
  };
  const never = async () => {
    const agreed = await Dialog.confirm({
      title: t().neverExpireQuestion,
      description: t().neverExpireDescription,
      confirm: r().neverExpireConfirm,
      cancel: t().cancel,
    });
    if (agreed) await save(null);
  };
  const set = () => {
    setTried(true);
    const value = day();
    if (value) void save(value);
  };
  return (
    <Dialog
      title={t().setAccountExpiry}
      open={props.open}
      onOpenChange={(open) => {
        if (!open && !busy()) props.close(false);
      }}
      foot={
        <>
          <Button onClick={() => void never()} disabled={busy()}>
            {t().neverExpire}
          </Button>
          <Button variant="primary" icon="calendar" busy={busy()} onClick={set}>
            {t().setExpiry}
          </Button>
        </>
      }
    >
      <Field
        name="expiry"
        label={t().expiryDate}
        hint={t().expiryDescription}
        error={tried() && !day() ? r().invalidDate : undefined}
        required
      >
        {/* k2b-ui gap: v2 DateInput has no picker yet; the field takes the day as text ("2026-12-31" or "31.12.2026"). */}
        <DateInput value={text()} placeholder={r().datePlaceholder} onInput={setText} />
      </Field>
      <Show when={error()}>
        {(message) => (
          <Notice tone="bad" icon="alert-circle">
            {message()}
          </Notice>
        )}
      </Show>
    </Dialog>
  );
}

/**
 * Values shown once, such as a temporary password or a sign-in token: each with a copy button. A stray press outside
 * or a swipe would lose them, so only "Done", × and Escape close it.
 */
export function CredentialDialog(props: {
  open: boolean;
  title: string;
  intro: readonly string[];
  fields: readonly { label: string; value: string }[];
  close: () => void;
}) {
  const t = useAccountsMessages();
  const r = useUserRecordMessages();
  return (
    <Dialog
      title={props.title}
      open={props.open}
      dismissible={false}
      onOpenChange={(open) => {
        if (!open) props.close();
      }}
      foot={
        <Button variant="primary" onClick={() => props.close()}>
          {t().done}
        </Button>
      }
    >
      <Notice tone="warn" icon="key">
        {r().tokenOnce}
      </Notice>
      <For each={props.intro}>{(line) => <Text>{line}</Text>}</For>
      <Facts items={props.fields.map((field) => ({ label: field.label, value: field.value, copy: field.value, mono: true }))} />
    </Dialog>
  );
}

const GroupsAnswer = z.object({
  groups: z.array(z.object({ id: z.string(), name: z.string(), provider: z.enum(["local", "ipa"]) })),
});

/**
 * Adding the person to groups: the lookup searches every group the person is not yet in (a local account only local
 * ones, as FreeIPA groups take FreeIPA accounts), and each chosen group is added in turn. One that fails says so; the
 * ones before it stay added and the page shows them after closing.
 */
export function AddToGroupsDialog(props: { user: Pick<User, "id" | "provider">; exclude: readonly string[]; open: boolean; close: Close }) {
  const t = useAccountsMessages();
  const r = useUserRecordMessages();
  const [chosen, setChosen] = createSignal<string[]>([]);
  const [tried, setTried] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [added, setAdded] = createSignal(0);
  const [error, setError] = createSignal<string | null>(null);
  const load: LookupLoad = async (query, context) => {
    const params = new URLSearchParams({ scope: "all", per_page: String(Math.min(100, context.limit + props.exclude.length)) });
    if (query.trim()) params.set("search", query.trim());
    if (props.user.provider === "local") params.set("provider", "local");
    const response = await fetch(`/api/accounts/groups?${params}`, { signal: context.signal });
    if (!response.ok) throw new Error(`groups ${response.status}`);
    const groups = GroupsAnswer.parse(await response.json()).groups.filter((group) => !props.exclude.includes(group.id));
    return { items: groups.slice(0, context.limit).map((group) => ({ value: group.id, label: group.name })) };
  };
  const add = async () => {
    setTried(true);
    const groups = chosen();
    if (busy() || groups.length === 0) return;
    setBusy(true);
    setError(null);
    let done = 0;
    try {
      for (const group of groups) {
        await addMembership(group, props.user.id, t());
        done++;
      }
      props.close(true);
    } catch (cause) {
      // what was added stays added: those leave the choice, the failed one and the rest remain to try again
      setAdded((count) => count + done);
      setChosen(groups.slice(done));
      const message = cause instanceof Error ? cause.message : t().addUserFailed;
      setError(done > 0 ? `${message} ${r().addedSome({ added: done, total: groups.length })}` : message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={r().addToGroups}
      open={props.open}
      onOpenChange={(open) => {
        if (!open && !busy()) props.close(added() > 0);
      }}
      foot={
        <>
          <Button onClick={() => props.close(added() > 0)} disabled={busy()}>
            {t().cancel}
          </Button>
          <Button variant="primary" icon="users-plus" busy={busy()} onClick={() => void add()}>
            {t().add}
          </Button>
        </>
      }
    >
      <Field
        name="groups"
        label={r().groupsLookup}
        hint={r().addToGroupsHint}
        error={tried() && chosen().length === 0 ? r().chooseGroup : undefined}
      >
        <Lookup label={r().groupsLookup} value={chosen()} onChange={setChosen} load={load} />
      </Field>
      <Show when={error()}>
        {(message) => (
          <Notice tone="bad" icon="alert-circle">
            {message()}
          </Notice>
        )}
      </Show>
    </Dialog>
  );
}
