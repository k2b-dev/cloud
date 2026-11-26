import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import { isSignOutOthersRetry } from "../sign-out-others";
import LoginForm from "./LoginForm.island";
import NewPasswordForm from "./new-password/NewPasswordForm.island";
import PasswordResetCompleteForm from "./password-reset/PasswordResetCompleteForm.island";

/** Renders the real sign-in page password forms for a browser test, which answers the APIs itself. */
const host = document.getElementById("root");
if (!host) throw new Error("Missing harness root");
// As the pages do: the address says where to go next and whether the form opens at its sign-out retry.
const params = new URLSearchParams(window.location.search);
const redirectTo = params.get("redirectTo") ?? undefined;
const signOutFailed = isSignOutOthersRetry(params);
render(
  () => (
    <LocaleProvider locale={document.documentElement.lang || "en"}>
      {window.location.pathname === "/auth/login-form" ? (
        <LoginForm defaultUsername="eva" redirectTo={redirectTo} />
      ) : window.location.pathname === "/auth/new-password" ? (
        <NewPasswordForm defaultUsername="eva" redirectTo={redirectTo} signOutFailed={signOutFailed} />
      ) : (
        <PasswordResetCompleteForm token={params.get("token") ?? ""} redirectTo={redirectTo} signOutFailed={signOutFailed} />
      )}
    </LocaleProvider>
  ),
  host,
);
