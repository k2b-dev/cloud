import { pwaDrafts } from "@k2b/cloud/browser/pwa-drafts";
import { reloadOnce } from "@k2b/cloud/browser/reload";
import { PWA_LIMITS } from "@k2b/cloud/contracts";
import type { CloudThemePreference } from "@k2b/cloud/shared";
import { createPreferenceController, THEME_CYCLE } from "@k2b/cloud/ssr/preference-controller";
import { useLocale } from "@k2b/ui";
import { Band, Bar, Button, Choice, Field, Input, List, Notice, Row, Section, Text, useToast } from "@k2b/ui/v2";
import { createSignal, onMount, Show } from "solid-js";
import { shellMessages } from "../../messages";
import { phoneAuth } from "../phone";
import { confirmWithBack } from "./confirm-with-back";
import { signOutOfApp } from "./sign-out";

export type PhoneSettingsProps = {
  /** The signed-in person, as the page read them. */
  account: { id: string; name: string; mail?: string; avatar?: string };
  theme: CloudThemePreference;
  /** This phone's name; empty when the request carries no device. */
  name: string;
  cloud: string;
  /** The release line beside Sign out. */
  version: string;
};

/** The app's Settings: the account, language, appearance, this phone's name, and signing out at the end. */
export default function PhoneSettings(props: PhoneSettingsProps) {
  const locale = useLocale();
  const t = () => shellMessages.resolve([locale()]).t;
  const toast = useToast();
  // The web's preference model: it writes the same cookies and announces theme changes, on which the app runtime
  // repaints the status bar.
  const preferences = createPreferenceController(props.theme, locale);
  const [name, setName] = createSignal(props.name);
  const [saved, setSaved] = createSignal(props.name);
  const [error, setError] = createSignal<string>();
  const [problem, setProblem] = createSignal<string>();
  const [draftLost, setDraftLost] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [ready, setReady] = createSignal(false);

  const field = "pwa.settings.device-name";
  let nameInput: HTMLInputElement | HTMLTextAreaElement | undefined;
  onMount(() => {
    if (nameInput) nameInput.defaultValue = props.name;
    const draft = pwaDrafts.read(props.account.id, field);
    if (draft === props.name) pwaDrafts.remove(props.account.id, field);
    setName(draft ?? props.name);
    setReady(true);
  });

  const rename = async () => {
    const submitted = name();
    const value = submitted.trim();
    if (!value || value.length > PWA_LIMITS.nameMaxLength) return setError(t().nameInvalid);
    setSaving(true);
    setProblem(undefined);
    const answer = await phoneAuth.rename(value);
    setSaving(false);
    if (answer.status === 204) {
      setSaved(value);
      if (nameInput) nameInput.defaultValue = value;
      // A person can keep typing while a save is in flight. Only the submitted text was saved; whatever differs from
      // it now stays a draft, also text that matches the name before the save.
      if (name() === submitted) setName(value);
      if (name() === value) pwaDrafts.remove(props.account.id, field);
      else pwaDrafts.write(props.account.id, field, name());
      toast(t().nameSaved, { status: "ok" });
    } else if (answer.status === 401) reloadOnce("pwa-auth");
    else if (answer.status === 400) setError(t().nameInvalid);
    else setProblem(answer.status === 0 ? t().offline : t().failed);
  };

  const signOut = async () => {
    const agreed = await confirmWithBack({
      title: t().signOut,
      description: t().signOutConfirm({ cloud: props.cloud }),
      confirm: t().signOut,
    });
    if (agreed) setProblem(await signOutOfApp(t()));
  };

  return (
    <>
      <List label={t().settings}>
        <Row avatar={{ name: props.account.name, image: props.account.avatar }} lines={[props.account.name, props.account.mail ?? ""]} />
      </List>
      <Show when={problem()}>{(text) => <Notice tone="bad">{text()}</Notice>}</Show>
      {/* each choice names itself once: its label is the heading of its options */}
      <Band>
        <Choice
          name="language"
          label={t().language}
          options={[
            { value: "en", label: "English" },
            { value: "de", label: "Deutsch" },
          ]}
          value={preferences.language()}
          onChange={(value) => {
            if (value !== preferences.language()) preferences.toggleLanguage();
          }}
        />
        <Choice
          name="appearance"
          label={t().appearance}
          options={THEME_CYCLE.map((mode) => ({ value: mode, label: preferences.themeOption(mode).label }))}
          value={preferences.theme()}
          onChange={(value) => {
            const next = THEME_CYCLE.find((mode) => mode === value);
            if (next) preferences.setTheme(next);
          }}
        />
      </Band>
      <Section icon="device-mobile" title={t().thisPhone}>
        <Field label={t().phoneName} error={error()}>
          <Input
            ref={(element) => {
              nameInput = element;
            }}
            value={name()}
            placeholder={t().phoneNamePlaceholder}
            maxLength={PWA_LIMITS.nameMaxLength}
            autocomplete="off"
            disabled={!ready()}
            onInput={(value) => {
              setName(value);
              if (value === saved()) pwaDrafts.remove(props.account.id, field);
              else if (!pwaDrafts.write(props.account.id, field, value)) setDraftLost(true);
              setError(undefined);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.isComposing && name().trim() !== saved()) {
                event.preventDefault();
                void rename();
              }
            }}
          />
        </Field>
        <Show when={draftLost()}>
          <Notice tone="warn">{t().draftUnavailable}</Notice>
        </Show>
        <Bar
          end={
            <Button busy={saving()} disabled={name().trim() === saved()} onClick={() => void rename()}>
              {t().save}
            </Button>
          }
        />
      </Section>
      <Bar
        start={<Text type="meta">{props.version}</Text>}
        end={
          <Button icon="logout" onClick={() => void signOut()}>
            {t().signOut}
          </Button>
        }
      />
    </>
  );
}
