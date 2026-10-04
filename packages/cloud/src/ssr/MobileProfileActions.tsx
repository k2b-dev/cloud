import { documentNavigate } from "@k2b/ssr/nav";
import { Button, ButtonLink } from "@k2b/ui";
import type { CloudTheme } from "../shared/theme";
import { createProfileActions } from "./profile-actions";

export function MobileProfileActions(props: {
  profile: { name: string; theme: CloudTheme; appHref?: string };
  beforeSelect: () => Promise<boolean>;
}) {
  const { preferences, signingOut, signOut } = createProfileActions(props.profile.theme, props.profile.appHref);
  const navigate = (href: string) => (event: MouseEvent) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    void props.beforeSelect().then((allowed) => {
      if (allowed) documentNavigate(href);
    });
  };
  return (
    <section class="cloud-mobile-profile" aria-label={preferences.messages().menuLabel}>
      <ButtonLink href="/me" variant="ghost" onClick={navigate("/me")}>
        <i class="ti ti-user-circle" aria-hidden="true" />
        {preferences.messages().profileSettings}
      </ButtonLink>
      {props.profile.appHref && (
        <ButtonLink href={props.profile.appHref} variant="ghost" onClick={navigate(props.profile.appHref)}>
          <i class="ti ti-device-mobile" aria-hidden="true" />
          {preferences.messages().app}
        </ButtonLink>
      )}
      <Button variant="ghost" onClick={preferences.toggleTheme}>
        <i class={`ti ${preferences.theme() === "light" ? "ti-moon" : "ti-sun-high"}`} aria-hidden="true" />
        {preferences.themeLabel()}
      </Button>
      <Button
        variant="ghost"
        onClick={async () => {
          if (await props.beforeSelect()) preferences.toggleLanguage();
        }}
      >
        <i class="ti ti-language" aria-hidden="true" />
        {preferences.languageLabel()}
      </Button>
      <Button
        variant="ghost"
        disabled={signingOut()}
        onClick={async () => {
          if (await props.beforeSelect()) await signOut();
        }}
      >
        <i class="ti ti-logout" aria-hidden="true" />
        {preferences.messages().signOut}
      </Button>
    </section>
  );
}
