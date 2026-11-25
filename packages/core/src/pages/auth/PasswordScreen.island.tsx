import { Button } from "@k2b/ui/v2";
import { Match, Switch } from "solid-js";
import AuthFrame, { type LegalLinks, useAuthMessages } from "./AuthFrame";
import { NewPasswordForm, PasswordResetCompleteForm, PasswordResetRequestForm } from "./password-forms";

/** `/auth/new-password` and `/auth/password-reset` on v2: which form the address asks for, and the way back. */
export default function PasswordScreen(props: {
  appName: string;
  legalLinks: LegalLinks;
  localeCookie: string;
  title: string;
  subtitle: string;
  form: { kind: "new"; defaultUsername: string } | { kind: "reset-request" } | { kind: "reset-complete"; token: string };
  redirectTo?: string;
  signOutFailed: boolean;
  loginHref: string;
}) {
  const t = useAuthMessages();
  // The way back stands at the start of the form's own bar, so one bar stands under the fields.
  const back = () => (
    <Button variant="text" icon="arrow-left" href={props.loginHref}>
      {t().backToSignIn}
    </Button>
  );
  return (
    <AuthFrame localeCookie={props.localeCookie} appName={props.appName} title={props.title} legalLinks={props.legalLinks}>
      <Switch>
        <Match when={props.form.kind === "new" && props.form}>
          {(form) => (
            <NewPasswordForm
              defaultUsername={form().defaultUsername}
              redirectTo={props.redirectTo}
              signOutFailed={props.signOutFailed}
              start={back()}
            />
          )}
        </Match>
        <Match when={props.form.kind === "reset-request"}>
          <PasswordResetRequestForm redirectTo={props.redirectTo} start={back()} lead={props.subtitle} />
        </Match>
        <Match when={props.form.kind === "reset-complete" && props.form}>
          {(form) => (
            <PasswordResetCompleteForm
              token={form().token}
              redirectTo={props.redirectTo}
              signOutFailed={props.signOutFailed}
              start={back()}
            />
          )}
        </Match>
      </Switch>
    </AuthFrame>
  );
}
