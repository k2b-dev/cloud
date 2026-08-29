import { useLocale } from "@k2b/ui";
import { createSignal, For, Show } from "solid-js";
import { getCurrentThemePreference, setThemePreference } from "../shared/theme";
import { platformMessages } from "./platform-messages";

type FooterProps = {
  isLoggedIn: boolean;
  appName?: string;
  /**
   * Legal/info links contributed by every running app via `defineApp.legalLinks`.
   * Computed server-side via `listLegalLinks()` and passed in by the host page
   * (Layout.tsx) so this island doesn't need direct registry access.
   */
  legalLinks?: Array<{ label: string; href: string; icon?: string }>;
};

export default function Footer(props: FooterProps) {
  const locale = useLocale();
  const t = () => platformMessages.resolve([locale()]).t;
  const [theme, setTheme] = createSignal(getCurrentThemePreference());

  const toggleTheme = () => {
    const newTheme = theme() === "dark" ? "light" : "dark";
    setTheme(setThemePreference(newTheme));
  };

  return (
    <footer class="shrink-0 flex items-center justify-center gap-4 py-2 px-3 text-xs text-dimmed ">
      <For each={props.legalLinks ?? []}>
        {(link) => (
          <a href={link.href} class="hover:text-primary transition-colors flex items-center gap-1">
            <Show when={link.icon}>
              <i class={`${link.icon} text-xs`} />
            </Show>
            {link.label}
          </a>
        )}
      </For>
      <button type="button" onClick={toggleTheme} class="hidden md:flex hover:text-primary transition-colors items-center gap-1">
        <i class={`ti ${theme() === "dark" ? "ti-sunset-2" : "ti-moon-stars"} text-xs`} />
        {theme() === "dark" ? t().light : t().dark}
      </button>
      {props.isLoggedIn ? (
        <a href="/me" class="hover:text-primary transition-colors flex items-center gap-1">
          <i class="ti ti-user text-xs" />
          {t().account}
        </a>
      ) : (
        <a href="/auth/login" class="hover:text-primary transition-colors flex items-center gap-1">
          <i class="ti ti-login text-xs" />
          {t().login}
        </a>
      )}
      {props.appName && (
        <span class="hidden md:inline text-zinc-400 dark:text-zinc-600">
          Copyright &copy; {new Date().getFullYear()} {props.appName}
        </span>
      )}
    </footer>
  );
}
