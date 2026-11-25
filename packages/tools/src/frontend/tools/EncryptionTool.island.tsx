import { crypto, i18n } from "@k2b/stdlib";
import { useLocale } from "@k2b/ui";
import { Band, Bar, Button, Check, Empty, Facts, Field, Input, Notice, Pane, Section, Tabs, Text } from "@k2b/ui/v2";
import { createSignal, Show } from "solid-js";
import ToolsScreen from "../ToolsScreen";
import { toolsWorkspaceMessages } from "../tools-messages";

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

/**
 * Encryption on v2: symmetric and asymmetric are two views of the tool (tabs as the pane's head). Each view has its
 * fields in one band, its two deeds in the bar right after them (busy while they run), an error as a notice at the top,
 * and the result as a value to copy.
 */
export default function EncryptionTool() {
  const locale = useLocale();
  const t = () => encryptionMessages.resolve([locale()]).t;
  const w = () => toolsWorkspaceMessages.resolve([locale()]).t;
  const [tab, setTab] = createSignal<Tab>("symmetric");
  const [symPayload, setSymPayload] = createSignal("");
  const [symKey, setSymKey] = createSignal("");
  const [symStretched, setSymStretched] = createSignal(true);
  const [asymPubKey, setAsymPubKey] = createSignal("");
  const [asymPrivKey, setAsymPrivKey] = createSignal("");
  const [asymPayload, setAsymPayload] = createSignal("");
  const [output, setOutput] = createSignal("");
  const [error, setError] = createSignal("");
  const [running, setRunning] = createSignal<"encrypt" | "decrypt" | "keys">();
  const run = async (deed: "encrypt" | "decrypt" | "keys", work: () => Promise<unknown>, fallback: string) => {
    setError("");
    if (deed !== "keys") setOutput("");
    setRunning(deed);
    try {
      await work();
    } catch (failure) {
      setError(getErrorMessage(failure, fallback));
    } finally {
      setRunning(undefined);
    }
  };
  const switchTo = (next: Tab) => {
    setTab(next);
    setOutput("");
    setError("");
  };
  const symReady = () => !!symPayload() && !!symKey() && !running();
  return (
    <ToolsScreen tool="encryption">
      <Pane
        label={w().result}
        scrollKey="tools-encryption"
        head={
          <Tabs
            label={w().kind}
            items={[
              { label: t().tabSymmetric, icon: "key", current: tab() === "symmetric", onClick: () => switchTo("symmetric") },
              { label: t().tabAsymmetric, icon: "keys", current: tab() === "asymmetric", onClick: () => switchTo("asymmetric") },
            ]}
          />
        }
      >
        <Show when={error()}>
          <Notice tone="bad" title={t().errEncryptFailed}>
            {error()}
          </Notice>
        </Show>
        <Show when={tab() === "symmetric"}>
          <Band label={t().tabSymmetric}>
            <Text type="body">{t().symIntro}</Text>
            <Field label={t().payloadLabel} hint={t().symPayloadDescription}>
              <Input multiline placeholder={t().symPayloadPlaceholder} value={symPayload()} onInput={setSymPayload} />
            </Field>
            <Field label={t().keyLabel} hint={t().keyDescription}>
              <Input type="password" icon="key" placeholder={t().keyPlaceholder} value={symKey()} onInput={setSymKey} />
            </Field>
            <Check
              switch
              label={`${t().stretchedLabel} · ${symStretched() ? t().stretchedNote : t().fastNote}`}
              checked={symStretched()}
              onChange={setSymStretched}
            />
            <Text type="meta" muted>
              {`${t().symStretchedHint} ${t().symFastHint}`}
            </Text>
          </Band>
          <Bar
            end={
              <>
                <Button
                  icon="lock-open"
                  busy={running() === "decrypt"}
                  disabled={!symReady()}
                  onClick={() =>
                    void run(
                      "decrypt",
                      async () => setOutput(await crypto.symmetric.decrypt({ payload: symPayload(), key: symKey() })),
                      t().errDecryptFailedWrongKey,
                    )
                  }
                >
                  {t().decrypt}
                </Button>
                <Button
                  variant="primary"
                  icon="lock"
                  busy={running() === "encrypt"}
                  disabled={!symReady()}
                  onClick={() =>
                    void run(
                      "encrypt",
                      async () =>
                        setOutput(await crypto.symmetric.encrypt({ payload: symPayload(), key: symKey(), stretched: symStretched() })),
                      t().errEncryptFailed,
                    )
                  }
                >
                  {t().encrypt}
                </Button>
              </>
            }
          />
        </Show>
        <Show when={tab() === "asymmetric"}>
          <Band label={t().keyPair}>
            <Text type="body">{t().asymIntro}</Text>
            <Text type="meta" muted>
              {`${t().exampleLabel} ${t().exampleAlice} ${t().exampleKeyPair} ${t().exampleEncrypt} ${t().exampleDecrypt} ${t().exampleNobody}`}
            </Text>
            <Field label={t().publicKeyLabel} hint={t().publicKeyDescription}>
              <Input multiline placeholder={t().publicKeyPlaceholder} value={asymPubKey()} onInput={setAsymPubKey} />
            </Field>
            <Field label={t().privateKeyLabel} hint={t().privateKeyDescription}>
              <Input multiline placeholder={t().privateKeyPlaceholder} value={asymPrivKey()} onInput={setAsymPrivKey} />
            </Field>
          </Band>
          <Bar
            end={
              <Button
                icon="key"
                busy={running() === "keys"}
                disabled={!!running()}
                onClick={() =>
                  void run(
                    "keys",
                    async () => {
                      const keys = await crypto.asymmetric.generate();
                      setAsymPubKey(keys.publicKey);
                      setAsymPrivKey(keys.privateKey);
                    },
                    t().errKeyGenFailed,
                  )
                }
              >
                {t().generateKeys}
              </Button>
            }
          />
          <Band label={t().encryptDecrypt}>
            <Field label={t().payloadLabel} hint={t().asymHint}>
              <Input multiline placeholder={t().asymPayloadPlaceholder} value={asymPayload()} onInput={setAsymPayload} />
            </Field>
          </Band>
          <Bar
            end={
              <>
                <Button
                  icon="lock-open"
                  busy={running() === "decrypt"}
                  disabled={!asymPayload() || !asymPrivKey() || !!running()}
                  onClick={() =>
                    void run(
                      "decrypt",
                      async () => setOutput(await crypto.asymmetric.decrypt({ payload: asymPayload(), privateKey: asymPrivKey() })),
                      t().errDecryptFailed,
                    )
                  }
                >
                  {t().decryptPrivateKey}
                </Button>
                <Button
                  variant="primary"
                  icon="lock"
                  busy={running() === "encrypt"}
                  disabled={!asymPayload() || !asymPubKey() || !!running()}
                  onClick={() =>
                    void run(
                      "encrypt",
                      async () => setOutput(await crypto.asymmetric.encrypt({ payload: asymPayload(), publicKey: asymPubKey() })),
                      t().errEncryptFailed,
                    )
                  }
                >
                  {t().encryptPublicKey}
                </Button>
              </>
            }
          />
        </Show>
        <Section icon="file-code" title={t().output}>
          <Show when={output()} fallback={<Empty icon="lock" text={w().nothingYet} />}>
            <Facts items={[{ label: t().output, value: output(), mono: true, copy: output() }]} />
          </Show>
        </Section>
      </Pane>
    </ToolsScreen>
  );
}
