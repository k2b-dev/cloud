import { reloadOnce } from "@k2b/cloud/browser/reload";
import { PWA_LIMITS } from "@k2b/cloud/contracts";
import { createPreferenceController } from "@k2b/cloud/ssr/preference-controller";
import { Avatar, Button, SegmentedControl, SettingsSection, TextInput, toast, useLocale } from "@k2b/ui";
import { createSignal } from "solid-js";
import { shellMessages } from "../../messages";
import { phoneAuth } from "../phone";
import SignOutButton from "./SignOutButton";

export type PhoneSettingsProps = {
  /** The signed-in person, as the page read them. */
  account: { name: string; mail?: string; avatar?: string };
  theme: "light" | "dark";
  /** This phone's name; empty when the request carries no device. */
  name: string;
  cloud: string;
  /** The release line under Sign out. */
  version: string;
};

/** The app's Settings: the account, language, appearance, this phone's name, and signing out at the end. */
export default function PhoneSettings(props: PhoneSettingsProps) {
  const locale = useLocale();
  const t = () => shellMessages.resolve([locale()]).t;
  // The web's preference model: it writes the same cookies and announces theme changes, on which the app runtime
  // repaints the status bar.
  const preferences = createPreferenceController(props.theme, locale);
  const [name, setName] = createSignal(props.name);
  const [saved, setSaved] = createSignal(props.name);
  const [error, setError] = createSignal<string>();
  const [saving, setSaving] = createSignal(false);

  const rename = async () => {
    const value = name().trim();
    if (!value || value.length > PWA_LIMITS.nameMaxLength) return setError(t().nameInvalid);
    setSaving(true);
    const answer = await phoneAuth.rename(value);
    setSaving(false);
    if (answer.status === 204) {
      setName(value);
      setSaved(value);
      toast.success(t().nameSaved);
    } else if (answer.status === 401) reloadOnce("pwa-auth");
    else if (answer.status === 400) setError(t().nameInvalid);
    else toast.error(answer.status === 0 ? t().offline : t().failed);
  };

  return (
    <div class="pwa-settings">
      <div class="pwa-settings__account">
        <Avatar name={props.account.name} src={props.account.avatar} size="lg" />
        <div>
          <p class="pwa-settings__name-line">{props.account.name}</p>
          {props.account.mail && <p class="pwa-settings__meta">{props.account.mail}</p>}
        </div>
      </div>
      <SettingsSection title={t().language}>
        <SegmentedControl
          ariaLabel={t().language}
          options={[
            { value: "en", label: "English" },
            { value: "de", label: "Deutsch" },
          ]}
          value={preferences.language}
          onValueChange={(value) => {
            if (value !== preferences.language()) preferences.toggleLanguage();
          }}
        />
      </SettingsSection>
      <SettingsSection title={t().appearance}>
        <SegmentedControl
          ariaLabel={t().appearance}
          options={[
            { value: "light", label: t().light, icon: "ti ti-sun-high" },
            { value: "dark", label: t().dark, icon: "ti ti-moon" },
          ]}
          value={preferences.theme}
          onValueChange={(value) => {
            if (value !== preferences.theme()) preferences.toggleTheme();
          }}
        />
      </SettingsSection>
      <SettingsSection title={t().thisPhone}>
        <form
          class="pwa-settings__name"
          onSubmit={(event) => {
            event.preventDefault();
            void rename();
          }}
        >
          <TextInput
            label={t().phoneName}
            value={name}
            onValueChange={(value) => {
              setName(value);
              setError(undefined);
            }}
            error={error()}
            maxLength={PWA_LIMITS.nameMaxLength}
            autocomplete="off"
          />
          <Button type="submit" variant="secondary" loading={saving()} disabled={name().trim() === saved()}>
            {t().save}
          </Button>
        </form>
      </SettingsSection>
      <div class="pwa-settings__end">
        <SignOutButton cloud={props.cloud} />
        <p class="pwa-settings__version">{props.version}</p>
      </div>
    </div>
  );
}
