import type { AccountCategory, AccountCategoryPolicy } from "@k2b/cloud/contracts";
import { dates } from "@k2b/stdlib";
import { useLocale } from "@k2b/ui";
import {
  Band,
  Bar,
  Button,
  Check,
  Choice,
  Dialog,
  Facts,
  Field,
  Input,
  Notice,
  Pane,
  Path,
  Prose,
  Section,
  Text,
  Workspace,
} from "@k2b/ui/v2";
import { createSignal, onCleanup, Show } from "solid-js";
import { apiClient } from "@/api/client";
import { type CreateUserResponse, CreateUserResponseSchema, ErrorResponseSchema } from "@/contracts";
import AccountsNav from "../../AccountsNav";
import { usePageSwap } from "../../lib/page-swap";
import { useAccountsMessages } from "../../messages";
import {
  type AccountRequestView,
  allowedCategories,
  type CreateUserForm,
  type CreateUserPayload,
  createUserPayload,
  emailOptional,
  missingFields,
} from "./create-user";
import DenyRequestDialog from "./DenyRequestDialog";
import { useNewUserMessages } from "./messages";

export type NewUserScreenProps = {
  categoryPolicy: AccountCategoryPolicy;
  freeIpaEnabled: boolean;
  /** Mirrors `user.local_email_optional`; the server enforces it. */
  localEmailOptional: boolean;
  /** The open account request this account completes (`?request=`), or null. */
  request: AccountRequestView | null;
  pendingRequests: number;
};

const USERS_PATH = "/app/accounts/users";

/**
 * A new account on v2, a page of its own: the account type, the person's name and address, administration and the
 * welcome mail, and what creating does. From an open request (`?request=`) the request stands above the form, fills it
 * and can be denied. After creating, the page shows the result with the way to the new account.
 */
export default function NewUserScreen(props: NewUserScreenProps) {
  const locale = useLocale();
  const t = useAccountsMessages();
  const words = useNewUserMessages();
  const { openPage, showChanges } = usePageSwap();
  const request = props.request;
  const categories = allowedCategories(props.categoryPolicy, props.freeIpaEnabled, request !== null);
  const [form, setForm] = createSignal<CreateUserForm>({
    // with one type to choose (always so for a request) it is chosen
    category: categories.length === 1 ? categories[0] : undefined,
    givenname: request?.firstName ?? "",
    sn: request?.lastName ?? "",
    email: request?.email ?? "",
    displayName: request?.displayName ?? [request?.firstName, request?.lastName].filter(Boolean).join(" "),
    admin: false,
    welcome: true,
  });
  const [displayNameTouched, setDisplayNameTouched] = createSignal(Boolean(request?.displayName));
  const [dirty, setDirty] = createSignal(false);
  const [tried, setTried] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [created, setCreated] = createSignal<{ payload: CreateUserPayload; data: CreateUserResponse } | null>(null);
  const [denying, setDenying] = createSignal(false);
  let controller: AbortController | undefined;
  onCleanup(() => controller?.abort());

  const optionalEmail = () => emailOptional(form(), props.localEmailOptional, request !== null);
  const withoutEmail = () => optionalEmail() && !form().email.trim();
  const missing = () => (tried() ? missingFields(form(), optionalEmail()) : null);
  const update = (patch: Partial<CreateUserForm>) => {
    setDirty(true);
    setForm((before) => {
      const next = { ...before, ...patch };
      // the display name follows first and last name until someone writes it
      if (!displayNameTouched() && ("givenname" in patch || "sn" in patch))
        next.displayName = [next.givenname, next.sn].filter((part) => part.trim()).join(" ");
      // administration exists only for full Login accounts
      if (next.category !== "login") next.admin = false;
      return next;
    });
  };
  const categoryLabel = (category: AccountCategory) =>
    category === "freeipa" ? "FreeIPA" : category === "guest" ? t().guest : props.categoryPolicy.login.label;
  const categoryHint = (category: AccountCategory | undefined) =>
    category === "freeipa"
      ? t().freeIpaTypeDescription
      : category === "guest"
        ? t().guestTypeDescription
        : category === "login"
          ? t().loginTypeDescription
          : t().accountTypeHelp;

  const create = async () => {
    setTried(true);
    const current = form();
    const category = current.category;
    if (busy() || !category || Object.values(missingFields(current, optionalEmail())).some(Boolean)) return;
    const payload = createUserPayload({ ...current, category }, request?.id);
    controller?.abort();
    const abort = new AbortController();
    controller = abort;
    setBusy(true);
    setError(null);
    try {
      const response = await apiClient.users.$post({ json: payload }, { init: { signal: abort.signal } });
      if (!response.ok) {
        const refused = ErrorResponseSchema.safeParse(await response.json().catch(() => null));
        setError(refused.success ? refused.data.message : t().createAccountFailed);
        return;
      }
      setCreated({ payload, data: CreateUserResponseSchema.parse(await response.json()) });
      setDirty(false);
    } catch {
      if (!abort.signal.aborted) setError(t().createAccountFailed);
    } finally {
      if (controller === abort) setBusy(false);
    }
  };
  const cancel = async () => {
    if (busy()) return;
    if (
      dirty() &&
      !(await Dialog.confirm({ title: words().discardTitle, description: words().discardDescription, confirm: words().discard }))
    )
      return;
    void openPage(USERS_PATH);
  };
  const submitOnEnter = (event: KeyboardEvent) => {
    if (event.key === "Enter" && !event.isComposing) void create();
  };

  const outcome = () => {
    const current = form();
    if (current.category === "freeipa")
      return [t().ipaAccessAfterCreation, t().ipaPasswordHelp, current.welcome ? t().ipaDeliveryHelp : t().ipaNoDeliveryHelp];
    if (withoutEmail()) return [t().localWithoutEmailHelp];
    return [
      t().localLoginHelp({ loginLabel: props.categoryPolicy.login.label }),
      current.welcome ? t().localDeliveryHelp : t().localNoDeliveryHelp,
    ];
  };

  return (
    <Workspace
      sidebar={<AccountsNav active="users" pendingRequests={props.pendingRequests} />}
      head={
        <Bar
          start={
            <Path
              label={t().users}
              items={[{ label: t().users, href: USERS_PATH }, { label: created() ? t().accountCreated : t().newUser }]}
            />
          }
        />
      }
    >
      <Pane label={t().newUser} scrollKey="accounts-user-new">
        <Show
          when={created()}
          fallback={
            <>
              <Show when={request}>
                {(open) => (
                  <Section
                    title={t().freeIpaAccessRequest}
                    icon="user-plus"
                    summary={t().requestCompletesOnCreate}
                    actions={[{ label: t().denyRequest, icon: "x", onClick: () => setDenying(true), disabled: busy() }]}
                  >
                    <Facts
                      items={[
                        { label: t().name, value: open().displayName || `${open().firstName} ${open().lastName}` },
                        { label: t().email, value: open().email },
                        ...(open().phone ? [{ label: t().phone, value: open().phone ?? "" }] : []),
                        ...(open().comment ? [{ label: t().requesterNote, value: open().comment ?? "" }] : []),
                      ]}
                    />
                  </Section>
                )}
              </Show>
              <Show when={categories.length === 0}>
                <Notice tone="warn">{t().noAllowedAccountTypes}</Notice>
              </Show>
              <Band>
                <Show when={categories.length > 0}>
                  <Field
                    name="category"
                    label={t().accountType}
                    hint={categoryHint(form().category)}
                    error={missing()?.category ? t().chooseAccountType : undefined}
                    required
                  >
                    <Choice
                      name="category"
                      value={form().category}
                      disabled={busy()}
                      options={categories.map((category) => ({ value: category, label: categoryLabel(category) }))}
                      onChange={(value) => {
                        if (value === "freeipa" || value === "login" || value === "guest") update({ category: value });
                      }}
                    />
                  </Field>
                </Show>
                <Field.Row>
                  <Field name="givenname" label={t().firstName} error={missing()?.givenname ? t().firstNameRequired : undefined} required>
                    {/* k2b-ui gap: Input has no maxLength or autocomplete; the server holds the limits. */}
                    <Input
                      value={form().givenname}
                      disabled={busy()}
                      onInput={(value) => update({ givenname: value })}
                      onKeyDown={submitOnEnter}
                    />
                  </Field>
                  <Field name="sn" label={t().lastName} error={missing()?.sn ? t().lastNameRequired : undefined} required>
                    <Input value={form().sn} disabled={busy()} onInput={(value) => update({ sn: value })} onKeyDown={submitOnEnter} />
                  </Field>
                </Field.Row>
                <Field
                  name="email"
                  label={t().email}
                  optional={optionalEmail() ? words().optional : undefined}
                  hint={optionalEmail() ? t().emailOptionalHelp : undefined}
                  error={missing()?.email ? t().emailRequired : undefined}
                  required={!optionalEmail()}
                >
                  <Input
                    type="email"
                    value={form().email}
                    placeholder="name@example.com"
                    disabled={busy()}
                    onInput={(value) => update({ email: value })}
                    onKeyDown={submitOnEnter}
                  />
                </Field>
                <Field name="displayName" label={t().displayName} optional={words().optional} hint={t().displayNameHelp}>
                  <Input
                    value={form().displayName}
                    disabled={busy()}
                    onInput={(value) => {
                      setDisplayNameTouched(true);
                      update({ displayName: value });
                    }}
                    onKeyDown={submitOnEnter}
                  />
                </Field>
              </Band>
              <Band>
                <Show when={form().category === "login"}>
                  <Check
                    name="admin"
                    label={t().grantAdminAccess}
                    checked={form().admin}
                    disabled={busy()}
                    onChange={(value) => update({ admin: value })}
                  />
                  <Text type="meta">{t().adminAccessDescription}</Text>
                </Show>
                <Check
                  name="welcome"
                  label={t().sendWelcomeAutomatically}
                  checked={form().welcome && !withoutEmail()}
                  disabled={busy() || withoutEmail()}
                  onChange={(value) => update({ welcome: value })}
                />
                <Show when={form().category}>
                  <Text type="meta">{form().category === "freeipa" ? t().ipaWelcomeDescription : t().localWelcomeDescription}</Text>
                </Show>
              </Band>
              <Show when={form().category}>
                <Notice tone="note" icon="info-circle" title={t().creationOutcome}>
                  {outcome().join(" ")}
                </Notice>
              </Show>
              <Show when={error()}>{(message) => <Notice tone="bad">{message()}</Notice>}</Show>
              <Bar
                end={
                  <>
                    <Button onClick={() => void cancel()} disabled={busy()}>
                      {t().cancel}
                    </Button>
                    <Button
                      variant="primary"
                      icon="user-plus"
                      busy={busy()}
                      disabled={categories.length === 0}
                      onClick={() => void create()}
                    >
                      {t().createAccount}
                    </Button>
                  </>
                }
              />
            </>
          }
        >
          {(result) => {
            const { payload, data } = result();
            const ipa = payload.provider === "ipa";
            const sentence = data.notificationSent
              ? ipa
                ? t().ipaWelcomeSent
                : t().localWelcomeSent
              : !ipa && !payload.email
                ? t().createdWithoutEmail
                : t().welcomeNotSent;
            return (
              <>
                <Section title={ipa ? t().ipaAccountCreated : t().localAccountCreated} icon="user-check" summary={sentence}>
                  <Facts
                    items={[
                      { label: "UID", value: data.uid, mono: true, copy: data.uid },
                      { label: t().accountType, value: categoryLabel(ipa ? "freeipa" : payload.profile === "guest" ? "guest" : "login") },
                      ...(data.accountExpires
                        ? [{ label: t().accountExpires, value: dates.formatDate(data.accountExpires, { locale: locale() }) }]
                        : []),
                    ]}
                  />
                </Section>
                <Show when={data.creationNotice?.markdown}>
                  {(markdown) => (
                    <Notice tone="note">
                      <Prose markdown={markdown()} />
                    </Notice>
                  )}
                </Show>
                <Show when={data.creationNotice?.failed}>
                  <Notice tone="warn">{t().creationNoticeFailed}</Notice>
                </Show>
                <Bar
                  end={
                    <>
                      <Button href={USERS_PATH}>{t().close}</Button>
                      <Button variant="primary" icon="user" href={`${USERS_PATH}/${data.id}`}>
                        {t().viewAccount}
                      </Button>
                    </>
                  }
                />
              </>
            );
          }}
        </Show>
      </Pane>
      <Show when={denying() && request}>
        {(open) => (
          <DenyRequestDialog
            request={open()}
            close={(denied) => {
              setDenying(false);
              if (denied) void showChanges();
            }}
          />
        )}
      </Show>
    </Workspace>
  );
}
