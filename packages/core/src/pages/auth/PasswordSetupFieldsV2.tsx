import { password } from "@k2b/stdlib";
import { useLocale } from "@k2b/ui";
import { Button, Chip, Dialog, Facts, Field, Input, Progress, Text } from "@k2b/ui/v2";
import { type Accessor, createMemo, createSignal, Show } from "solid-js";
import { passwordSetupMessages } from "./password-setup-messages";

/** How strong a password is, in colour, sign and word: never a colour alone. */
const strengthStatus = (score: number) => (score <= 1 ? "bad" : score === 2 ? "warn" : "ok");

/**
 * The new-password fields on a v2 page (reset and expired password): a new password with "Generate" at its end, its
 * strength as a meter and a word, and the repetition. A generated password fills both fields and shows once in a
 * dialog, with a copy button, for a password manager.
 */
export function PasswordSetupFieldsV2(props: {
  newPassword: Accessor<string>;
  confirmPassword: Accessor<string>;
  onNewPasswordChange: (value: string) => void;
  onConfirmPasswordChange: (value: string) => void;
  /** The new password is the form's first field and takes the focus. */
  autofocus?: boolean;
}) {
  const locale = useLocale();
  const resolved = () => passwordSetupMessages.resolve([locale()]);
  const t = () => resolved().t;
  const [generated, setGenerated] = createSignal<string>();
  const [filled, setFilled] = createSignal(false);
  const strength = createMemo(() => password.strength(props.newPassword()));
  const words = () => [t().strength0, t().strength1, t().strength2, t().strength3, t().strength4];

  const generate = () => {
    const next = password.random({ length: 24, uppercase: true, numbers: true, symbols: false });
    props.onNewPasswordChange(next);
    props.onConfirmPasswordChange(next);
    setFilled(true);
    setGenerated(next);
  };
  const advice = () =>
    props.newPassword().length === 0
      ? t().minimumLength
      : filled()
        ? t().generatedFilledBoth
        : resolved().locale === "de"
          ? t().germanStrengthAdvice
          : [t().estimatedCrackTime({ time: strength().crackTime }), ...strength().feedback.slice(0, 2)].join(". ");

  return (
    <>
      <Field label={t().newPassword} hint={t().newPasswordDescription}>
        <Input
          icon="lock-open"
          type="password"
          value={props.newPassword()}
          onInput={(value) => {
            props.onNewPasswordChange(value);
            setFilled(false);
          }}
          placeholder={t().newPassword}
          autocomplete="new-password"
          autofocus={props.autofocus}
          end={<Button variant="ghost" icon="sparkles" label={t().generate} onClick={generate} />}
        />
      </Field>
      <Facts
        items={[
          {
            label: t().strength,
            value: (
              <Show when={props.newPassword().length > 0} fallback={<Text muted>{t().noPassword}</Text>}>
                <Progress value={strength().score + 1} of={5} />
                <Chip status={strengthStatus(strength().score)}>{words()[strength().score]}</Chip>
              </Show>
            ),
            hint: advice(),
          },
        ]}
      />
      <Field label={t().confirmPassword} hint={t().confirmPasswordDescription}>
        <Input
          icon="lock-check"
          type="password"
          value={props.confirmPassword()}
          onInput={props.onConfirmPasswordChange}
          placeholder={t().confirmPassword}
          autocomplete="new-password"
        />
      </Field>
      <Dialog
        title={t().passwordGenerated}
        open={generated() !== undefined}
        onOpenChange={(open) => {
          if (!open) setGenerated(undefined);
        }}
        foot={
          <Button variant="primary" onClick={() => setGenerated(undefined)}>
            {t().done}
          </Button>
        }
      >
        <Facts items={[{ label: t().generatedPassword, value: generated() ?? "", mono: true, copy: generated() ?? "" }]} />
        <Text muted>{t().generatedPasswordDescription}</Text>
      </Dialog>
    </>
  );
}
