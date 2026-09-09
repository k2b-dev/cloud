import { cookies } from "@k2b/stdlib/browser";
import { Dropdown, useLocale } from "@k2b/ui";
import { LOCALE_COOKIE } from "@valentinkolb/cloud/shared";

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
      <Dropdown.Trigger variant="ghost" size="sm" class="auth-language-trigger">
        {german() ? "Deutsch" : "English"}
        <i class="ti ti-chevron-down" aria-hidden="true" />
      </Dropdown.Trigger>
    </Dropdown.Root>
  );
}
