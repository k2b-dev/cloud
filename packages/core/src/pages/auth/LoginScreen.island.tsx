import type { AccountCategory } from "@k2b/cloud/contracts";
import { Notice, Row, Section, Tabs, Text } from "@k2b/ui/v2";
import { Match, Show, Switch } from "solid-js";
import AppLoginForm from "./AppLoginForm";
import AuthFrame, { type LegalLinks } from "./AuthFrame";
import { AdminForm, EmailForm, FreeIpaForm, IdleSignOutFinish, useAuthMessages, usePasskeySignIn } from "./login-forms";

/** Everything the sign-in page decided on the server; the island only shows it and runs the chosen form. */
export type LoginScreenProps = {
  appName: string;
  legalLinks: LegalLinks;
  title: string;
  subtitle: string | null;
  /** The account kinds to switch between, each its own address; absent with only one. */
  categories: { value: AccountCategory; label: string; href: string; current: boolean }[] | null;
  form:
    | { kind: "admin"; requiresRecovery: boolean }
    | { kind: "app"; category: AccountCategory; fallback: { href: string; label: string }; setupHint: string }
    | { kind: "email"; token?: string; category?: "guest" | "login"; allowSelfRegistration: boolean }
    | { kind: "freeipa"; showBanner: boolean; defaultUsername?: string }
    | { kind: "none" };
  redirectTo?: string;
  /** A shared workstation remembers nothing about the sign-in. */
  forget: boolean;
  signedOutIdle: boolean;
  /** The other ways in, below the form; absent for the admin token and an email link's token. */
  others: { passkey: boolean; appInstead: string | null; supportHref: string; adminHref: string } | null;
};

/** `/auth/login` on v2. The endpoints, payloads, cookies and redirects are those of the forms before v2. */
export default function LoginScreen(props: LoginScreenProps) {
  const t = useAuthMessages();
  const passkey = usePasskeySignIn({ redirectTo: props.redirectTo, forget: props.forget });
  return (
    <AuthFrame
      appName={props.appName}
      title={props.title}
      legalLinks={props.legalLinks}
      tabs={
        props.categories ? (
          <Tabs
            label={t().fallbackMethod}
            items={props.categories.map((category) => ({ label: category.label, href: category.href, current: category.current }))}
          />
        ) : undefined
      }
    >
      <Show when={props.subtitle}>{(subtitle) => <Text muted>{subtitle()}</Text>}</Show>
      <Show when={props.signedOutIdle}>
        <IdleSignOutFinish />
        <Notice tone="note" icon="lock">
          {t().signedOutIdle}
        </Notice>
      </Show>
      <Switch>
        <Match when={props.form.kind === "admin" && props.form}>
          {(form) => <AdminForm redirectTo={props.redirectTo} requiresRecovery={form().requiresRecovery} />}
        </Match>
        <Match when={props.form.kind === "app" && props.form}>
          {(form) => (
            <AppLoginForm
              category={form().category}
              redirectTo={props.redirectTo}
              fallback={form().fallback}
              setupHint={form().setupHint}
              forget={props.forget}
            />
          )}
        </Match>
        <Match when={props.form.kind === "email" && props.form}>
          {(form) => (
            <EmailForm
              redirectTo={props.redirectTo}
              token={form().token}
              category={form().category}
              allowSelfRegistration={form().allowSelfRegistration}
              forget={props.forget}
            />
          )}
        </Match>
        <Match when={props.form.kind === "freeipa" && props.form}>
          {(form) => (
            <FreeIpaForm
              redirectTo={props.redirectTo}
              showBanner={form().showBanner}
              defaultUsername={form().defaultUsername}
              appName={props.appName}
              forget={props.forget}
            />
          )}
        </Match>
        <Match when={props.form.kind === "none"}>
          <Notice tone="note" icon="info-circle">
            {t().noLoginAvailable}
          </Notice>
        </Match>
      </Switch>
      <Show when={props.forget && !props.signedOutIdle}>
        <Text muted type="meta">
          {t().sharedWorkstationHint}
        </Text>
      </Show>
      <Show when={props.others}>
        {(others) => (
          <Section icon="route" title={t().otherWays}>
            <Show when={others().passkey}>
              <Row icon="key" lines={[t().continueWithPasskey]} action={{ label: t().continueWithPasskey, disabled: passkey.busy(), onClick: passkey.start }} />
              <Show when={passkey.error()}>{(message) => <Notice tone="bad">{message()}</Notice>}</Show>
            </Show>
            <Show when={others().appInstead}>{(href) => <Row icon="device-mobile" lines={[t().useAppInstead]} href={href()} />}</Show>
            <Row icon="lifebuoy" lines={[t().contactSupport]} href={others().supportHref} />
            <Row icon="shield" lines={[t().adminToken]} href={others().adminHref} />
          </Section>
        )}
      </Show>
    </AuthFrame>
  );
}
