import { crypto, i18n } from "@k2b/stdlib";
import { Button, CopyButton, NoticeCard, SegmentedControl, Switch, TextInput, useLocale } from "@k2b/ui";
import { createSignal } from "solid-js";
import { ToolCodeBlock } from "./ToolOutput";

type Tab = "symmetric" | "asymmetric";

export const encryptionMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      tabSymmetric: "Symmetric",
      tabAsymmetric: "Asymmetric",
      errEncryptFailed: "Encryption failed",
      errDecryptFailedWrongKey: "Decryption failed — wrong key?",
      errKeyGenFailed: "Key generation failed",
      errDecryptFailed: "Decryption failed",
      symIntro: "Symmetric encryption uses a single shared key for both encryption and decryption.",
      symStretchedHint: "Use Stretched (PBKDF2) when your key is a password — it adds deliberate slowness to resist brute-force attacks.",
      symFastHint: "Use Fast (HKDF) for already high-entropy keys like API tokens.",
      payloadLabel: "Payload",
      symPayloadDescription: "Enter text to encrypt, or paste ciphertext to decrypt.",
      symPayloadPlaceholder: "Text or ciphertext...",
      keyLabel: "Key / Password",
      keyDescription: "The shared secret used for both encryption and decryption.",
      keyPlaceholder: "Encryption key or password...",
      stretchedLabel: "Stretched (PBKDF2)",
      stretchedNote: "Slow, safe for passwords",
      fastNote: "Fast, for high-entropy keys",
      encrypt: "Encrypt",
      decrypt: "Decrypt",
      asymIntro: "Asymmetric encryption uses a key pair: a public key (shared freely) and a private key (kept secret).",
      exampleLabel: "Example:",
      exampleAlice: "Alice wants to send Bob a secret message.",
      exampleKeyPair: "Bob generates a key pair and shares his public key with Alice.",
      exampleEncrypt: "Alice encrypts her message using Bob's public key and sends the ciphertext — even publicly.",
      exampleDecrypt: "Only Bob can decrypt it with his private key.",
      exampleNobody: "Nobody else, not even Alice, can read it once encrypted.",
      keyPair: "Key Pair",
      generateKeys: "Generate Keys",
      publicKeyLabel: "Public Key",
      publicKeyDescription: "Share this key with others so they can encrypt messages for you or verify your signatures.",
      publicKeyPlaceholder: "Public key...",
      privateKeyLabel: "Private Key",
      privateKeyDescription: "Keep this secret! Used to decrypt messages and sign data.",
      privateKeyPlaceholder: "Private key...",
      encryptDecrypt: "Encrypt / Decrypt",
      asymHint: "Encrypt with the recipient's public key. Only their private key can decrypt it.",
      asymPayloadPlaceholder: "Text to encrypt or ciphertext to decrypt...",
      encryptPublicKey: "Encrypt (Public Key)",
      decryptPrivateKey: "Decrypt (Private Key)",
      output: "Output",
    },
    de: {
      tabSymmetric: "Symmetrisch",
      tabAsymmetric: "Asymmetrisch",
      errEncryptFailed: "Verschlüsselung fehlgeschlagen",
      errDecryptFailedWrongKey: "Entschlüsselung fehlgeschlagen. Prüfe Schlüssel und Eingabe.",
      errKeyGenFailed: "Schlüsselgenerierung fehlgeschlagen",
      errDecryptFailed: "Entschlüsselung fehlgeschlagen",
      symIntro: "Symmetrische Verschlüsselung verwendet einen einzigen gemeinsamen Schlüssel zum Ver- und Entschlüsseln.",
      symStretchedHint: "Wähle „Passwort (PBKDF2)“ für Passwörter. Die absichtliche Verzögerung erschwert Brute-Force-Angriffe.",
      symFastHint: "Wähle „Schnell (HKDF)“ für zufällig erzeugte Schlüssel mit hoher Entropie, etwa API-Tokens.",
      payloadLabel: "Inhalt",
      symPayloadDescription: "Gib Text zum Verschlüsseln ein oder füge Geheimtext zum Entschlüsseln ein.",
      symPayloadPlaceholder: "Text oder Geheimtext...",
      keyLabel: "Schlüssel / Passwort",
      keyDescription: "Das gemeinsame Geheimnis für Ver- und Entschlüsselung.",
      keyPlaceholder: "Schlüssel oder Passwort...",
      stretchedLabel: "Passwort (PBKDF2)",
      stretchedNote: "Für Passwörter",
      fastNote: "Für zufällig erzeugte Schlüssel",
      encrypt: "Verschlüsseln",
      decrypt: "Entschlüsseln",
      asymIntro:
        "Asymmetrische Verschlüsselung verwendet ein Schlüsselpaar. Der öffentliche Schlüssel darf geteilt werden, der private Schlüssel bleibt geheim.",
      exampleLabel: "Beispiel:",
      exampleAlice: "Alice möchte Bob eine geheime Nachricht senden.",
      exampleKeyPair: "Bob generiert ein Schlüsselpaar und teilt seinen öffentlichen Schlüssel mit Alice.",
      exampleEncrypt:
        "Alice verschlüsselt ihre Nachricht mit Bobs öffentlichem Schlüssel und kann den Geheimtext anschließend öffentlich senden.",
      exampleDecrypt: "Nur Bob kann sie mit seinem privaten Schlüssel entschlüsseln.",
      exampleNobody: "Niemand sonst, nicht einmal Alice, kann die Nachricht nach der Verschlüsselung lesen.",
      keyPair: "Schlüsselpaar",
      generateKeys: "Schlüssel generieren",
      publicKeyLabel: "Öffentlicher Schlüssel",
      publicKeyDescription:
        "Gib diesen Schlüssel weiter. Andere können damit Nachrichten für dich verschlüsseln oder deine Signaturen prüfen.",
      publicKeyPlaceholder: "Öffentlicher Schlüssel...",
      privateKeyLabel: "Privater Schlüssel",
      privateKeyDescription: "Bewahre diesen Schlüssel geheim auf. Er entschlüsselt Nachrichten und signiert Daten.",
      privateKeyPlaceholder: "Privater Schlüssel...",
      encryptDecrypt: "Verschlüsseln / Entschlüsseln",
      asymHint:
        "Verschlüssle mit dem öffentlichen Schlüssel der empfangenden Person. Zum Entschlüsseln ist der zugehörige private Schlüssel erforderlich.",
      asymPayloadPlaceholder: "Text zum Verschlüsseln oder Geheimtext zum Entschlüsseln...",
      encryptPublicKey: "Verschlüsseln (öffentlicher Schlüssel)",
      decryptPrivateKey: "Entschlüsseln (privater Schlüssel)",
      output: "Ausgabe",
    },
  },
});

const getErrorMessage = (error: unknown, fallback: string): string => {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
};
export default function EncryptionTool() {
  const locale = useLocale();
  const t = () => encryptionMessages.resolve([locale()]).t;
  const [tab, setTab] = createSignal<Tab>("symmetric");
  const [symPayload, setSymPayload] = createSignal("");
  const [symKey, setSymKey] = createSignal("");
  const [symStretched, setSymStretched] = createSignal(true);
  const [symOutput, setSymOutput] = createSignal("");
  const [symError, setSymError] = createSignal("");
  const [symLoading, setSymLoading] = createSignal(false);
  const [asymPubKey, setAsymPubKey] = createSignal("");
  const [asymPrivKey, setAsymPrivKey] = createSignal("");
  const [asymPayload, setAsymPayload] = createSignal("");
  const [asymOutput, setAsymOutput] = createSignal("");
  const [asymError, setAsymError] = createSignal("");
  const [asymLoading, setAsymLoading] = createSignal(false);
  const symEncrypt = async () => {
    setSymError("");
    setSymOutput("");
    setSymLoading(true);
    try {
      const result = await crypto.symmetric.encrypt({ payload: symPayload(), key: symKey(), stretched: symStretched() });
      setSymOutput(result);
    } catch (error) {
      setSymError(getErrorMessage(error, t().errEncryptFailed));
    } finally {
      setSymLoading(false);
    }
  };
  const symDecrypt = async () => {
    setSymError("");
    setSymOutput("");
    setSymLoading(true);
    try {
      const result = await crypto.symmetric.decrypt({ payload: symPayload(), key: symKey() });
      setSymOutput(result);
    } catch (error) {
      setSymError(getErrorMessage(error, t().errDecryptFailedWrongKey));
    } finally {
      setSymLoading(false);
    }
  };
  const generateKeys = async () => {
    setAsymError("");
    setAsymLoading(true);
    try {
      const keys = await crypto.asymmetric.generate();
      setAsymPubKey(keys.publicKey);
      setAsymPrivKey(keys.privateKey);
    } catch (error) {
      setAsymError(getErrorMessage(error, t().errKeyGenFailed));
    } finally {
      setAsymLoading(false);
    }
  };
  const asymEncrypt = async () => {
    setAsymError("");
    setAsymOutput("");
    setAsymLoading(true);
    try {
      const result = await crypto.asymmetric.encrypt({ payload: asymPayload(), publicKey: asymPubKey() });
      setAsymOutput(result);
    } catch (error) {
      setAsymError(getErrorMessage(error, t().errEncryptFailed));
    } finally {
      setAsymLoading(false);
    }
  };
  const asymDecrypt = async () => {
    setAsymError("");
    setAsymOutput("");
    setAsymLoading(true);
    try {
      const result = await crypto.asymmetric.decrypt({ payload: asymPayload(), privateKey: asymPrivKey() });
      setAsymOutput(result);
    } catch (error) {
      setAsymError(getErrorMessage(error, t().errDecryptFailed));
    } finally {
      setAsymLoading(false);
    }
  };
  const CopyBtn = (props: { value: string }) => <CopyButton text={props.value} class="shrink-0" />;
  const OutputBlock = (props: { label: string; value: string }) => (
    <div class="flex flex-col gap-1">
      {" "}
      <p class="text-xs font-medium text-dimmed">{props.label}</p>{" "}
      <div class="flex items-start gap-2">
        {" "}
        <ToolCodeBlock class="max-h-40 flex-1 overflow-y-auto">{props.value}</ToolCodeBlock> <CopyBtn value={props.value} />{" "}
      </div>{" "}
    </div>
  );
  return (
    <div class="flex flex-col gap-4">
      {" "}
      <SegmentedControl
        options={[
          { value: "symmetric" as Tab, label: t().tabSymmetric, icon: "ti ti-key" },
          { value: "asymmetric" as Tab, label: t().tabAsymmetric, icon: "ti ti-keys" },
        ]}
        value={tab}
        onValueChange={setTab}
      />{" "}
      {/* Symmetric */}{" "}
      {tab() === "symmetric" && (
        <div class="flex flex-col gap-4">
          {" "}
          <NoticeCard tone="info" icon={false} bodyClass="flex items-start gap-2">
            {" "}
            <i class="ti ti-info-circle shrink-0 mt-0.5" />{" "}
            <div class="text-sm">
              {" "}
              <strong>{t().symIntro}</strong> {t().symStretchedHint} {t().symFastHint}{" "}
            </div>{" "}
          </NoticeCard>{" "}
          <div class="paper p-4 flex flex-col gap-3">
            {" "}
            <TextInput
              label={t().payloadLabel}
              description={t().symPayloadDescription}
              placeholder={t().symPayloadPlaceholder}
              multiline
              value={symPayload}
              onValueChange={setSymPayload}
            />{" "}
            <TextInput
              label={t().keyLabel}
              description={t().keyDescription}
              placeholder={t().keyPlaceholder}
              password
              icon="ti ti-key"
              value={symKey}
              onValueChange={setSymKey}
            />{" "}
            <div class="flex items-center gap-3">
              {" "}
              <Switch label={t().stretchedLabel} value={symStretched} onValueChange={setSymStretched} />{" "}
              <span class="text-xs text-dimmed">{symStretched() ? t().stretchedNote : t().fastNote}</span>{" "}
            </div>{" "}
            <div class="flex items-center gap-2">
              {" "}
              <Button size="sm" onClick={symEncrypt} disabled={symLoading() || !symPayload() || !symKey()}>
                {" "}
                <i class="ti ti-lock" /> {t().encrypt}{" "}
              </Button>{" "}
              <Button variant="secondary" size="sm" onClick={symDecrypt} disabled={symLoading() || !symPayload() || !symKey()}>
                {" "}
                <i class="ti ti-lock-open" /> {t().decrypt}{" "}
              </Button>{" "}
            </div>{" "}
          </div>{" "}
          {symError() && (
            <NoticeCard tone="danger" icon={false} bodyClass="flex items-center gap-2">
              {" "}
              <i class="ti ti-alert-circle" /> {symError()}{" "}
            </NoticeCard>
          )}{" "}
          {symOutput() && (
            <div class="paper p-4">
              {" "}
              <OutputBlock label={t().output} value={symOutput()} />{" "}
            </div>
          )}{" "}
        </div>
      )}{" "}
      {/* Asymmetric */}{" "}
      {tab() === "asymmetric" && (
        <div class="flex flex-col gap-4">
          {" "}
          <NoticeCard tone="info" icon={false} bodyClass="flex items-start gap-2">
            {" "}
            <i class="ti ti-info-circle shrink-0 mt-0.5" />{" "}
            <div class="text-sm flex flex-col gap-2">
              {" "}
              <div>
                {" "}
                <strong>{t().asymIntro}</strong>{" "}
              </div>{" "}
              <div>
                {" "}
                <strong>{t().exampleLabel}</strong> {t().exampleAlice} {t().exampleKeyPair} {t().exampleEncrypt} {t().exampleDecrypt}{" "}
                {t().exampleNobody}{" "}
              </div>{" "}
            </div>{" "}
          </NoticeCard>{" "}
          <div class="paper p-4 flex flex-col gap-3">
            {" "}
            <div class="flex items-center justify-between">
              {" "}
              <p class="text-xs font-medium text-dimmed">{t().keyPair}</p>{" "}
              <Button size="sm" onClick={generateKeys} disabled={asymLoading()}>
                {" "}
                <i class="ti ti-refresh" /> {t().generateKeys}{" "}
              </Button>{" "}
            </div>{" "}
            <TextInput
              label={t().publicKeyLabel}
              description={t().publicKeyDescription}
              placeholder={t().publicKeyPlaceholder}
              multiline
              value={asymPubKey}
              onValueChange={setAsymPubKey}
            />{" "}
            <TextInput
              label={t().privateKeyLabel}
              description={t().privateKeyDescription}
              placeholder={t().privateKeyPlaceholder}
              multiline
              value={asymPrivKey}
              onValueChange={setAsymPrivKey}
            />{" "}
          </div>{" "}
          {/* Encrypt/Decrypt */}{" "}
          <div class="paper p-4 flex flex-col gap-3">
            {" "}
            <span class="section-label mb-1">{t().encryptDecrypt}</span> <p class="text-xs text-dimmed">{t().asymHint}</p>{" "}
            <TextInput
              label={t().payloadLabel}
              placeholder={t().asymPayloadPlaceholder}
              multiline
              value={asymPayload}
              onValueChange={setAsymPayload}
            />{" "}
            <div class="flex items-center gap-2">
              {" "}
              <Button size="sm" onClick={asymEncrypt} disabled={asymLoading() || !asymPayload() || !asymPubKey()}>
                {" "}
                <i class="ti ti-lock" /> {t().encryptPublicKey}{" "}
              </Button>{" "}
              <Button variant="secondary" size="sm" onClick={asymDecrypt} disabled={asymLoading() || !asymPayload() || !asymPrivKey()}>
                {" "}
                <i class="ti ti-lock-open" /> {t().decryptPrivateKey}{" "}
              </Button>{" "}
            </div>{" "}
          </div>{" "}
          {asymError() && (
            <NoticeCard tone="danger" icon={false} bodyClass="flex items-center gap-2">
              {" "}
              <i class="ti ti-alert-circle" /> {asymError()}{" "}
            </NoticeCard>
          )}{" "}
          {asymOutput() && (
            <div class="paper p-4">
              {" "}
              <OutputBlock label={t().output} value={asymOutput()} />{" "}
            </div>
          )}{" "}
        </div>
      )}{" "}
    </div>
  );
}
