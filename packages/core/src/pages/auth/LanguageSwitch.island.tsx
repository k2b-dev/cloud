import { LOCALE_COOKIE } from "@k2b/cloud/shared";
import { cookies } from "@k2b/stdlib/browser";
import { Dropdown, useLocale } from "@k2b/ui";

export default function LanguageSwitch() {
  const locale = useLocale();
  const german = () => locale().toLowerCase().split("-")[0] === "de";
  const choose = (language: "de" | "en") => {
    if ((language === "de") === german()) return;
    cookies.writeCookie(LOCALE_COOKIE, language);
    window.location.reload();
  };
  return (
    <Dropdown.Root
      position="top-left"
      width="10rem"
      label={german() ? "Sprache" : "Language"}
      items={[
        { label: "Deutsch", choice: "radio", checked: german, action: () => choose("de") },
        { label: "English", choice: "radio", checked: () => !german(), action: () => choose("en") },
      ]}
    >
      {/* Below md the language code keeps the footer on one row on a phone; the full name stays the accessible label. */}
      <Dropdown.Trigger variant="ghost" size="sm" class="auth-language-trigger" label={german() ? "Sprache: Deutsch" : "Language: English"}>
        <i class="ti ti-language md:hidden" aria-hidden="true" />
        <span class="hidden md:inline">{german() ? "Deutsch" : "English"}</span>
        <span class="md:hidden">{german() ? "DE" : "EN"}</span>
        <i class="ti ti-chevron-down hidden md:inline" aria-hidden="true" />
      </Dropdown.Trigger>
    </Dropdown.Root>
  );
}
