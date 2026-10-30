import { createSignal } from "solid-js";
import type { AppLocale } from "./i18n";

export type ThemeChoice = "system" | "light" | "dark";

type Stored = { name?: string; theme?: ThemeChoice; locale?: AppLocale; firstShareSeen?: boolean; guestNameSeen?: boolean };

const KEY = "k2b-notes.preferences";

const GUEST_NAMES: Record<AppLocale, string[]> = {
  de: ["Otter", "Dachs", "Fuchs", "Eule", "Igel", "Luchs", "Biber", "Kranich", "Specht", "Möwe", "Hase", "Wal", "Elch", "Robbe", "Falke", "Lachs"],
  en: ["Otter", "Badger", "Fox", "Owl", "Hedgehog", "Lynx", "Beaver", "Crane", "Woodpecker", "Gull", "Hare", "Whale", "Moose", "Seal", "Falcon", "Salmon"],
};

const read = (): Stored => {
  let value: unknown;
  try {
    value = JSON.parse(localStorage.getItem(KEY) ?? "null");
  } catch {
    return {};
  }
  if (!value || typeof value !== "object") return {};
  const field = (key: string): unknown => (key in value ? Reflect.get(value, key) : undefined);
  const name = field("name");
  const theme = field("theme");
  const locale = field("locale");
  return {
    name: typeof name === "string" && name.trim() ? name.slice(0, 32) : undefined,
    theme: theme === "light" || theme === "dark" || theme === "system" ? theme : undefined,
    locale: locale === "de" || locale === "en" ? locale : undefined,
    firstShareSeen: field("firstShareSeen") === true,
    guestNameSeen: field("guestNameSeen") === true,
  };
};

const browserLocale = (): AppLocale => {
  for (const language of navigator.languages ?? [navigator.language]) {
    const base = language.toLowerCase().split("-")[0];
    if (base === "de" || base === "en") return base;
  }
  return "de";
};

const initial = read();
const [prefs, setPrefs] = createSignal<Stored>(initial);

const save = (patch: Partial<Stored>) => {
  const next = { ...prefs(), ...patch };
  setPrefs(next);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Preferences are a convenience; a full or blocked storage keeps them for this tab.
  }
};

window.addEventListener("storage", (event) => {
  if (event.key === KEY) setPrefs(read());
});

export const preferences = {
  locale: (): AppLocale => prefs().locale ?? browserLocale(),
  setLocale: (locale: AppLocale) => save({ locale }),
  theme: (): ThemeChoice => prefs().theme ?? "system",
  setTheme: (theme: ThemeChoice) => save({ theme }),
  /** A friendly animal per browser; the person can change it in the settings. */
  name: (): string => {
    const name = prefs().name;
    if (name) return name;
    const names = GUEST_NAMES[preferences.locale()];
    const picked = names[Math.floor(Math.random() * names.length)] ?? "Otter";
    save({ name: picked });
    return picked;
  },
  setName: (name: string) => save({ name: name.trim().slice(0, 32) || undefined }),
  firstShareSeen: () => prefs().firstShareSeen === true,
  markFirstShareSeen: () => save({ firstShareSeen: true }),
  guestNameSeen: () => prefs().guestNameSeen === true,
  markGuestNameSeen: () => save({ guestNameSeen: true }),
  clear: () => {
    try {
      localStorage.removeItem(KEY);
    } catch {}
    setPrefs({});
  },
};

const media = window.matchMedia("(prefers-color-scheme: dark)");
const [systemDark, setSystemDark] = createSignal(media.matches);
media.addEventListener("change", (event) => setSystemDark(event.matches));

export const isDark = () => preferences.theme() === "dark" || (preferences.theme() === "system" && systemDark());
