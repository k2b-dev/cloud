// stdlib's qr module is no longer barrel-exported (v0.3.0+) because it
// depends on the optional peer `lean-qr`. Use the subpath import; this
// app declares lean-qr as a direct dep so it's installed in the container.
import { qr } from "@k2b/stdlib/qr";
import { useLocale } from "@k2b/ui";
import { Band, Button, Canvas, Check, Empty, Facts, Field, Input, Pane, Section, Select, Text } from "@k2b/ui/v2";
import { createMemo, createSignal, Match, Show, Switch } from "solid-js";
import ToolsScreen from "../ToolsScreen";
import { toolsWorkspaceMessages } from "../tools-messages";
import { qrMessages } from "./qr-messages";

type Mode = "text" | "wifi" | "email" | "tel" | "vcard" | "event";

export default function QrCodeGenerator() {
  const locale = useLocale();
  const t = () => qrMessages.resolve([locale()]).t;
  const w = () => toolsWorkspaceMessages.resolve([locale()]).t;

  // === Mode ===
  const [mode, setMode] = createSignal<Mode>("text");

  const modeInfo = (): string => {
    const messages = t();
    switch (mode()) {
      case "wifi":
        return messages.hintWifi;
      case "email":
        return messages.hintEmail;
      case "tel":
        return messages.hintTel;
      case "vcard":
        return messages.hintVcard;
      case "event":
        return messages.hintEvent;
      default:
        return messages.hintText;
    }
  };

  // === Text/URL ===
  const [text, setText] = createSignal("https://example.com");

  // === WiFi ===
  const [wifiSsid, setWifiSsid] = createSignal("");
  const [wifiPassword, setWifiPassword] = createSignal("");
  const [wifiEncryption, setWifiEncryption] = createSignal("WPA");
  const [wifiHidden, setWifiHidden] = createSignal(false);

  // === Email ===
  const [emailTo, setEmailTo] = createSignal("");
  const [emailSubject, setEmailSubject] = createSignal("");
  const [emailBody, setEmailBody] = createSignal("");

  // === Phone ===
  const [telNumber, setTelNumber] = createSignal("");

  // === vCard ===
  const [vcFirstName, setVcFirstName] = createSignal("");
  const [vcLastName, setVcLastName] = createSignal("");
  const [vcOrg, setVcOrg] = createSignal("");
  const [vcTitle, setVcTitle] = createSignal("");
  const [vcPhone, setVcPhone] = createSignal("");
  const [vcEmail, setVcEmail] = createSignal("");
  const [vcWebsite, setVcWebsite] = createSignal("");
  const [vcStreet, setVcStreet] = createSignal("");
  const [vcCity, setVcCity] = createSignal("");
  const [vcZip, setVcZip] = createSignal("");
  const [vcCountry, setVcCountry] = createSignal("");

  // === Event ===
  const [evTitle, setEvTitle] = createSignal("");
  const [evLocation, setEvLocation] = createSignal("");
  const [evStart, setEvStart] = createSignal("");
  const [evEnd, setEvEnd] = createSignal("");
  const [evDescription, setEvDescription] = createSignal("");

  // === Display settings (shared) ===
  const [ecLevel, setEcLevel] = createSignal("M");
  const [size, setSize] = createSignal(300);
  const [fgColor, setFgColor] = createSignal("#000000");
  const [bgColor, setBgColor] = createSignal("#ffffff");
  const [transparentBg, setTransparentBg] = createSignal(false);

  // === Computed payload ===
  const payload = createMemo(() => {
    switch (mode()) {
      case "text":
        return text().trim();
      case "wifi":
        return wifiSsid().trim()
          ? qr.wifi({
              ssid: wifiSsid(),
              password: wifiPassword(),
              encryption: wifiEncryption() as "WPA" | "WEP" | "nopass",
              hidden: wifiHidden(),
            })
          : "";
      case "email":
        return emailTo().trim()
          ? qr.email({
              to: emailTo(),
              subject: emailSubject(),
              body: emailBody(),
            })
          : "";
      case "tel":
        return telNumber().trim() ? qr.tel({ number: telNumber() }) : "";
      case "vcard":
        return vcFirstName().trim()
          ? qr.vcard({
              firstName: vcFirstName(),
              lastName: vcLastName(),
              organization: vcOrg(),
              title: vcTitle(),
              phone: vcPhone(),
              email: vcEmail(),
              website: vcWebsite(),
              street: vcStreet(),
              city: vcCity(),
              zip: vcZip(),
              country: vcCountry(),
            })
          : "";
      case "event":
        return evTitle().trim()
          ? qr.event({
              title: evTitle(),
              location: evLocation(),
              start: evStart(),
              end: evEnd(),
              description: evDescription(),
            })
          : "";
      default:
        return "";
    }
  });

  // === QR rendering ===
  const qrSvg = createMemo(() => {
    const p = payload();
    if (!p) return "";
    try {
      return qr.toSvg(p, {
        on: fgColor(),
        off: transparentBg() ? "transparent" : bgColor(),
        correctionLevel: ecLevel() as "L" | "M" | "Q" | "H",
      });
    } catch {
      return "";
    }
  });

  const svgDataUrl = createMemo(() => {
    const svg = qrSvg();
    if (!svg) return "";
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });

  const downloadSvg = () => {
    const svg = qrSvg();
    if (!svg) return;
    const blob = new Blob([svg], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "qr-code.svg";
    a.click();
    URL.revokeObjectURL(url);
  };

  const downloadPng = () => {
    const url = svgDataUrl();
    if (!url) return;
    const im = new Image();
    im.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = size();
      canvas.height = size();
      const ctx = canvas.getContext("2d")!;
      if (!transparentBg()) {
        ctx.fillStyle = bgColor();
        ctx.fillRect(0, 0, size(), size());
      }
      ctx.drawImage(im, 0, 0, size(), size());
      canvas.toBlob((blob) => {
        if (!blob) return;
        const a = document.createElement("a");
        const downloadUrl = URL.createObjectURL(blob);
        a.href = downloadUrl;
        a.download = "qr-code.png";
        a.click();
        URL.revokeObjectURL(downloadUrl);
      }, "image/png");
    };
    im.src = url;
  };

  const field = (
    label: string,
    value: () => string,
    set: (value: string) => void,
    extra: {
      hint?: string;
      placeholder?: string;
      icon?: string;
      optional?: boolean;
      type?: "password" | "email" | "tel" | "url";
      multiline?: boolean;
    } = {},
  ) => (
    <Field label={label} hint={extra.hint} optional={extra.optional ? w().optional : undefined}>
      <Input
        type={extra.type}
        icon={extra.icon}
        multiline={extra.multiline}
        placeholder={extra.placeholder}
        value={value()}
        onInput={set}
      />
    </Field>
  );
  const download = { label: t().downloadSvg, icon: "download", onClick: downloadSvg, disabled: !qrSvg() };
  return (
    <ToolsScreen
      tool="qr"
      primary={download}
      end={
        <>
          <Button icon="photo-down" disabled={!qrSvg()} onClick={downloadPng}>
            PNG
          </Button>
          <Button variant="primary" icon="download" disabled={!qrSvg()} onClick={downloadSvg}>
            {t().downloadSvg}
          </Button>
        </>
      }
    >
      <Pane label={t().contentHeading} scrollKey="tools-qr">
        <Pane.Split>
          <Pane label={t().contentHeading} width={{ min: 360, default: 480 }}>
            <Band label={t().contentHeading}>
              <Field label={t().contentType} hint={modeInfo()}>
                <Select
                  value={mode()}
                  onChange={(value) => setMode(value as Mode)}
                  options={[
                    { value: "text", label: t().typeText },
                    { value: "wifi", label: t().typeWifi },
                    { value: "email", label: t().typeEmail },
                    { value: "tel", label: t().typeTel },
                    { value: "vcard", label: t().typeVcard },
                    { value: "event", label: t().typeEvent },
                  ]}
                />
              </Field>
              <Switch>
                <Match when={mode() === "text"}>
                  {field(t().textLabel, text, setText, { hint: t().textDescription, placeholder: t().textPlaceholder, multiline: true })}
                </Match>
                <Match when={mode() === "wifi"}>
                  {field(t().wifiSsidLabel, wifiSsid, setWifiSsid, {
                    hint: t().wifiSsidDescription,
                    placeholder: t().wifiSsidPlaceholder,
                    icon: "wifi",
                  })}
                  {field(t().wifiPasswordLabel, wifiPassword, setWifiPassword, {
                    hint: t().wifiPasswordDescription,
                    placeholder: t().wifiPasswordPlaceholder,
                    type: "password",
                    optional: true,
                  })}
                  <Field label={t().wifiEncryptionLabel}>
                    <Select
                      value={wifiEncryption()}
                      onChange={setWifiEncryption}
                      options={[
                        { value: "WPA", label: "WPA / WPA2" },
                        { value: "WEP", label: "WEP" },
                        { value: "nopass", label: t().wifiEncryptionNone },
                      ]}
                    />
                  </Field>
                  <Check switch label={t().wifiHiddenLabel} checked={wifiHidden()} onChange={setWifiHidden} />
                </Match>
                <Match when={mode() === "email"}>
                  {field(t().emailToLabel, emailTo, setEmailTo, {
                    hint: t().emailToDescription,
                    placeholder: t().emailToPlaceholder,
                    type: "email",
                    icon: "mail",
                  })}
                  {field(t().emailSubjectLabel, emailSubject, setEmailSubject, {
                    placeholder: t().emailSubjectPlaceholder,
                    optional: true,
                  })}
                  {field(t().emailBodyLabel, emailBody, setEmailBody, {
                    placeholder: t().emailBodyPlaceholder,
                    multiline: true,
                    optional: true,
                  })}
                </Match>
                <Match when={mode() === "tel"}>
                  {field(t().telLabel, telNumber, setTelNumber, {
                    hint: t().telDescription,
                    placeholder: "+49 123 456 7890",
                    type: "tel",
                    icon: "phone",
                  })}
                </Match>
                <Match when={mode() === "vcard"}>
                  <Field.Row>
                    {field(t().vcFirstNameLabel, vcFirstName, setVcFirstName, { placeholder: t().vcFirstNamePlaceholder })}
                    {field(t().vcLastNameLabel, vcLastName, setVcLastName, { placeholder: t().vcLastNamePlaceholder, optional: true })}
                  </Field.Row>
                  <Field.Row>
                    {field(t().vcOrgLabel, vcOrg, setVcOrg, { placeholder: t().vcOrgPlaceholder, optional: true })}
                    {field(t().vcTitleLabel, vcTitle, setVcTitle, { placeholder: t().vcTitlePlaceholder, optional: true })}
                  </Field.Row>
                  <Field.Row>
                    {field(t().vcPhoneLabel, vcPhone, setVcPhone, { placeholder: "+49 123 456 7890", type: "tel", optional: true })}
                    {field(t().vcEmailLabel, vcEmail, setVcEmail, { placeholder: t().vcEmailPlaceholder, type: "email", optional: true })}
                  </Field.Row>
                  {field(t().vcWebsiteLabel, vcWebsite, setVcWebsite, { placeholder: "https://example.com", type: "url", optional: true })}
                  <Field.Row>
                    {field(t().vcStreetLabel, vcStreet, setVcStreet, { placeholder: t().vcStreetPlaceholder, optional: true })}
                    {field(t().vcCityLabel, vcCity, setVcCity, { placeholder: "Berlin", optional: true })}
                  </Field.Row>
                  <Field.Row>
                    {field(t().vcZipLabel, vcZip, setVcZip, { placeholder: "10115", optional: true })}
                    {field(t().vcCountryLabel, vcCountry, setVcCountry, { placeholder: t().vcCountryPlaceholder, optional: true })}
                  </Field.Row>
                </Match>
                <Match when={mode() === "event"}>
                  {field(t().evTitleLabel, evTitle, setEvTitle, { placeholder: t().evTitlePlaceholder })}
                  {field(t().evLocationLabel, evLocation, setEvLocation, {
                    hint: t().evLocationDescription,
                    placeholder: t().evLocationPlaceholder,
                    optional: true,
                  })}
                  {/* k2b-ui gap: v2 has no date-and-time picker yet; start and end are typed as "2026-06-15 14:30". */}
                  <Field.Row>
                    {field(t().evStartLabel, evStart, (value) => setEvStart(value.trim().replace(" ", "T")), {
                      placeholder: "2026-06-15 14:30",
                      optional: true,
                    })}
                    {field(t().evEndLabel, evEnd, (value) => setEvEnd(value.trim().replace(" ", "T")), {
                      placeholder: "2026-06-15 16:00",
                      optional: true,
                    })}
                  </Field.Row>
                  {field(t().evDescriptionLabel, evDescription, setEvDescription, {
                    placeholder: t().evDescriptionPlaceholder,
                    multiline: true,
                    optional: true,
                  })}
                </Match>
              </Switch>
            </Band>
            <Section icon="adjustments" title={t().advancedTitle} summary={t().advancedSubtitle}>
              <Field label={t().ecLabel} hint={t().ecDescription}>
                <Select
                  value={ecLevel()}
                  onChange={setEcLevel}
                  options={[
                    { value: "L", label: t().ecLow },
                    { value: "M", label: t().ecMedium },
                    { value: "Q", label: t().ecQuartile },
                    { value: "H", label: t().ecHigh },
                  ]}
                />
              </Field>
              {/* k2b-ui gap: v2 has no colour picker; colours are typed as HEX values. */}
              <Field.Row>
                {field(t().fgLabel, fgColor, setFgColor, { hint: t().fgDescription, placeholder: "#000000" })}
                {field(t().bgLabel, bgColor, setBgColor, { hint: t().bgDescription, placeholder: "#ffffff" })}
              </Field.Row>
              <Check switch label={t().transparentLabel} checked={transparentBg()} onChange={setTransparentBg} />
              <Field label={t().sizeLabel} hint={t().sizeDescription} optional="100–1000 px">
                <Input
                  type="number"
                  min={100}
                  max={1000}
                  value={String(size())}
                  onInput={(value) => {
                    const next = Number.parseInt(value, 10);
                    if (Number.isFinite(next)) setSize(Math.min(1000, Math.max(100, next)));
                  }}
                />
              </Field>
            </Section>
          </Pane>
          <Pane label={t().previewHeading}>
            <Section icon="qrcode" title={t().previewHeading} count={`${size()} px`} summary={t().previewSubtitle}>
              <Canvas label={t().qrAlt} height={320}>
                <Show
                  when={qrSvg()}
                  fallback={
                    <Empty
                      icon={payload() ? "alert-circle" : "qrcode-off"}
                      text={
                        payload()
                          ? `${t().previewUnavailable}. ${t().previewUnavailableHint}`
                          : `${t().previewEmpty}. ${t().previewEmptyHint}`
                      }
                    />
                  }
                >
                  <img
                    src={svgDataUrl()}
                    alt={t().qrAlt}
                    style={{ display: "block", height: "100%", margin: "0 auto", "aspect-ratio": "1" }}
                  />
                </Show>
              </Canvas>
              <Show when={payload()}>
                <Facts items={[{ label: t().contentHeading, value: payload(), mono: true, copy: payload() }]} />
              </Show>
            </Section>
            <Band label={t().localNote}>
              <Text type="meta" muted>
                {t().localNote}
              </Text>
            </Band>
          </Pane>
        </Pane.Split>
      </Pane>
    </ToolsScreen>
  );
}
