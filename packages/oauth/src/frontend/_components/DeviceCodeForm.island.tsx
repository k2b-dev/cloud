import { useLocale } from "@k2b/ui";
import { Band, Bar, Button, Field, Input } from "@k2b/ui/v2";
import { createSignal } from "solid-js";
import { oauthMessages } from "../messages";

const CODE_SYMBOLS = /[^ABCDEFGHJKLMNPQRSTUVWXYZ23456789]/g;

/** Uppercase, drop separators and impossible symbols, and show the code as XXXX-XXXX. */
const formatDeviceCodeInput = (value: string): string => {
  const symbols = value.toUpperCase().replace(CODE_SYMBOLS, "").slice(0, 8);
  return symbols.length > 4 ? `${symbols.slice(0, 4)}-${symbols.slice(4)}` : symbols;
};

/** The `id` of the code form; its field and button stand in the pane and send it by this name. */
const CODE_FORM = "oauth-device-code";

/** Code entry for the device approval page. Without JavaScript it is a plain GET form. */
const DeviceCodeForm = (props: { code?: string; error?: string }) => {
  const locale = useLocale();
  const t = () => oauthMessages.resolve([locale()]).t;
  const [code, setCode] = createSignal(formatDeviceCodeInput(props.code ?? ""));

  return (
    <>
      <form id={CODE_FORM} method="get" action="/oauth/device" hidden />
      <Band>
        <Field label={t().deviceCodeLabel} error={props.error} required>
          <Input
            name="user_code"
            form={CODE_FORM}
            placeholder="XXXX-XXXX"
            value={code()}
            onInput={(value) => setCode(formatDeviceCodeInput(value))}
            maxLength={16}
            autocomplete="one-time-code"
            autocapitalize="characters"
            spellcheck={false}
            autofocus
          />
        </Field>
      </Band>
      <Bar
        end={
          <Button variant="primary" icon="arrow-right" type="submit" form={CODE_FORM}>
            {t().deviceContinue}
          </Button>
        }
      />
    </>
  );
};

export default DeviceCodeForm;
