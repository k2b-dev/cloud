import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import AppLoginForm from "./AppLoginForm.island";
import GuestLoginForm from "./GuestLoginForm.island";

const params = new URLSearchParams(location.search);
const redirectTo = params.get("redirectTo") ?? undefined;
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
render(
  () => (
    <LocaleProvider locale="en">
      {params.get("credential") === "app" ? (
        <AppLoginForm category="login" redirectTo={redirectTo} />
      ) : (
        <GuestLoginForm token={params.get("token") ?? "fixture-mail-token"} allowSelfRegistration={false} redirectTo={redirectTo} />
      )}
    </LocaleProvider>
  ),
  root,
);
