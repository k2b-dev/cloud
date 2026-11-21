import type { ThemeMode } from "@k2b/fibel";
import { createSignal } from "solid-js";

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
        d="M12 3v2.2m0 13.6V21m6.36-15.36-1.55 1.55M7.19 16.81l-1.55 1.55M21 12h-2.2M5.2 12H3m15.36 6.36-1.55-1.55M7.19 7.19 5.64 5.64M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z"
      />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
        d="M21 13.2A7.5 7.5 0 0 1 10.8 3 8.5 8.5 0 1 0 21 13.2Z"
      />
    </svg>
  );
}

type HomeHeaderProps = {
  initialTheme: ThemeMode;
  themeCookieName: string;
};

export default function HomeHeader(props: HomeHeaderProps) {
  const [theme, setTheme] = createSignal(props.initialTheme);

  const toggleTheme = () => {
    const next = theme() === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.classList.toggle("dark", next === "dark");
    document.documentElement.dataset.theme = next;
    document.documentElement.style.colorScheme = next;
    document.cookie = `${props.themeCookieName}=${next}; Path=/; Max-Age=31536000; SameSite=Lax`;
  };

  return (
    <header class="cloud-site-header">
      <div class="cloud-header-inner">
        <a class="cloud-header-brand" href="/en" aria-label="Cloud home">
          <img src="/assets/logo.svg" alt="" />
          <span>Cloud</span>
        </a>
        <nav class="cloud-header-nav" aria-label="Primary navigation">
          <a href="/en/apps">Apps</a>
          <a href="/en/code">feat/code</a>
          <a href="/en/docs">Docs</a>
          <a href="/en/ui">UI</a>
        </nav>
        <button class="cloud-theme-toggle" type="button" onClick={toggleTheme} aria-label="Toggle theme">
          {theme() === "dark" ? <SunIcon /> : <MoonIcon />}
        </button>
      </div>
    </header>
  );
}
