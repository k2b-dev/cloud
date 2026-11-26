import { i18n, password } from "@k2b/stdlib";
import { useLocale } from "@k2b/ui";
import { Button, Dialog, Facts, Field, Input, Progress, Text } from "@k2b/ui/v2";
import { type Accessor, createMemo, createSignal, type JSX } from "solid-js";

type PasswordSetupFieldsProps = {
  newPassword: Accessor<string>;
  confirmPassword: Accessor<string>;
  onNewPasswordChange: (value: string) => void;
  onConfirmPasswordChange: (value: string) => void;
  locale?: string;
};

export const passwordSetupMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      generatedPassword: "Generated password",
      generatedPasswordDescription:
        "The generated password was filled into both password fields. Copy it now if you want to store it in a password manager.",
      copied: "Copied",
      copyPassword: "Copy password",
      done: "Done",
      passwordGenerated: "Password generated",
      newPassword: "New password",
      newPasswordDescription: "Choose a strong password or generate one automatically.",
      generate: "Generate",
      noPassword: "No password yet",
      minimumLength: "Use at least 12 characters.",
      estimatedCrackTime: ({ time }: { time: string }) => `Estimated crack time: ${time}`,
      generatedFilled: 'Generated password filled into both password fields. Use "Show password" to review it before saving.',
      confirmPassword: "Confirm new password",
      confirmPasswordDescription: "Repeat the new password to avoid typos.",
      strength0: "very weak",
      strength1: "weak",
      strength2: "fair",
      strength3: "strong",
      strength4: "very strong",
      germanStrengthAdvice: "A longer, randomly generated password is harder to guess.",
      showPassword: "Show password",
      strength: ({ level }: { level: string }) => `Strength: ${level}`,
    },
    de: {
      generatedPassword: "Erzeugtes Passwort",
      generatedPasswordDescription:
        "Das erzeugte Passwort wurde in beide Passwortfelder eingetragen. Kopiere es jetzt, wenn du es in einem Passwortmanager speichern möchtest.",
      copied: "Kopiert",
      copyPassword: "Passwort kopieren",
      done: "Fertig",
      passwordGenerated: "Passwort erzeugt",
      newPassword: "Neues Passwort",
      newPasswordDescription: "Wähle ein starkes Passwort oder erzeuge automatisch eines.",
      generate: "Erzeugen",
      noPassword: "Noch kein Passwort",
      minimumLength: "Verwende mindestens 12 Zeichen.",
      estimatedCrackTime: ({ time }) => `Geschätzte Zeit zum Knacken: ${time}`,
      generatedFilled: "Das erzeugte Passwort wurde in beide Felder eingetragen. Prüfe es vor dem Speichern über „Passwort zeigen“.",
      confirmPassword: "Neues Passwort bestätigen",
      confirmPasswordDescription: "Wiederhole das neue Passwort, um Tippfehler zu vermeiden.",
      strength0: "sehr schwach",
      strength1: "schwach",
      strength2: "mittel",
      strength3: "stark",
      strength4: "sehr stark",
      germanStrengthAdvice: "Ein längeres, zufällig erzeugtes Passwort ist schwerer zu erraten.",
      showPassword: "Passwort zeigen",
      strength: ({ level }) => `Stärke: ${level}`,
    },
  },
});

/** A password field with a quiet "show" toggle at its end. */
export function PasswordInput(props: {
  value: string;
  onInput: (value: string) => void;
  autocomplete: "current-password" | "new-password" | "off";
  placeholder?: string;
  label: string;
  /** Enter in the field, such as sending its form. */
  onEnter?: () => void;
  /** One more quiet deed at the field's end, such as "Generate". */
  end?: JSX.Element;
}) {
  const [visible, setVisible] = createSignal(false);
  return (
    <Input
      type={visible() ? "text" : "password"}
      value={props.value}
      onInput={props.onInput}
      placeholder={props.placeholder}
      autocomplete={props.autocomplete}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.isComposing) props.onEnter?.();
      }}
      end={
        <>
          <Button
            variant="ghost"
            icon={visible() ? "eye-off" : "eye"}
            label={props.label}
            pressed={visible()}
            onClick={() => setVisible(!visible())}
          />
          {props.end}
        </>
      }
    />
  );
}

/** Reusable new-password fields for expired-password, reset-token and change-password flows. */
export function PasswordSetupFields(props: PasswordSetupFieldsProps) {
  const inheritedLocale = useLocale();
  const resolved = () => passwordSetupMessages.resolve([props.locale ?? inheritedLocale()]);
  const t = () => resolved().t;
  const [generatedPassword, setGeneratedPassword] = createSignal(false);
  const [shown, setShown] = createSignal<string | null>(null);
  const strength = createMemo(() => password.strength(props.newPassword()));
  const level = () => [t().strength0, t().strength1, t().strength2, t().strength3, t().strength4][strength().score] ?? "";

  const generatePassword = () => {
    const next = password.random({ length: 24, uppercase: true, numbers: true, symbols: false });
    props.onNewPasswordChange(next);
    props.onConfirmPasswordChange(next);
    setGeneratedPassword(true);
    setShown(next);
  };
  const updateNewPassword = (value: string) => {
    props.onNewPasswordChange(value);
    setGeneratedPassword(false);
  };
  const advice = () =>
    props.newPassword().length === 0
      ? t().minimumLength
      : generatedPassword()
        ? t().generatedFilled
        : resolved().locale === "de"
          ? t().germanStrengthAdvice
          : strength().feedback.length > 0
            ? `${strength().feedback.slice(0, 2).join(". ")}.`
            : t().estimatedCrackTime({ time: strength().crackTime });

  return (
    <>
      <Field name="newPassword" label={t().newPassword} hint={advice()} required>
        <PasswordInput
          value={props.newPassword()}
          onInput={updateNewPassword}
          autocomplete="new-password"
          placeholder={t().newPassword}
          label={t().showPassword}
          end={<Button variant="ghost" icon="sparkles" label={t().generate} onClick={generatePassword} />}
        />
      </Field>
      <Progress
        value={props.newPassword().length === 0 ? 0 : strength().score + 1}
        of={5}
        label={props.newPassword().length === 0 ? t().noPassword : t().strength({ level: level() })}
      />
      <Field name="confirmPassword" label={t().confirmPassword} hint={t().confirmPasswordDescription} required>
        <PasswordInput
          value={props.confirmPassword()}
          onInput={props.onConfirmPasswordChange}
          autocomplete="new-password"
          placeholder={t().confirmPassword}
          label={t().showPassword}
        />
      </Field>
      <Dialog
        title={t().passwordGenerated}
        open={shown() !== null}
        onOpenChange={(open) => {
          if (!open) setShown(null);
        }}
        foot={
          <Button variant="primary" onClick={() => setShown(null)}>
            {t().done}
          </Button>
        }
      >
        <Facts items={[{ label: t().generatedPassword, value: shown() ?? "", copy: shown() ?? "", mono: true }]} />
        <Text muted>{t().generatedPasswordDescription}</Text>
      </Dialog>
    </>
  );
}
