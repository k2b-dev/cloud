// stdlib's qr module is no longer barrel-exported (v0.3.0+) because it
// depends on the optional peer `lean-qr`. Use the subpath import; this
// app declares lean-qr as a direct dep so it's installed in the container.
import { qr } from "@k2b/stdlib/qr";
import { Button, ColorInput, CopyButton, DateTimePicker, Select, Slider, TextInput, Switch as Toggle, useLocale } from "@k2b/ui";
import { createMemo, createSignal, Match, Show, Switch } from "solid-js";
import { qrMessages } from "./qr-messages";

type Mode = "text" | "wifi" | "email" | "tel" | "vcard" | "event";

export default function QrCodeGenerator() {
  const locale = useLocale();
  const t = () => qrMessages.resolve([locale()]).t;

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

  return (
    <div class="tools-qr-root flex flex-col gap-2">
      <div class="tools-qr-workbench">
        <section class="paper tools-qr-input flex flex-col gap-4 p-4">
          <header>
            <h2 class="text-sm font-semibold text-primary">{t().contentHeading}</h2>
            <p class="text-xs text-dimmed">{modeInfo()}</p>
          </header>

          <Select
            label={t().contentType}
            icon="ti ti-qrcode"
            value={mode}
            onValueChange={(value) => setMode(value as Mode)}
            options={[
              { id: "text", label: t().typeText, icon: "ti ti-link" },
              { id: "wifi", label: t().typeWifi, icon: "ti ti-wifi" },
              { id: "email", label: t().typeEmail, icon: "ti ti-mail" },
              { id: "tel", label: t().typeTel, icon: "ti ti-phone" },
              { id: "vcard", label: t().typeVcard, icon: "ti ti-address-book" },
              { id: "event", label: t().typeEvent, icon: "ti ti-calendar-event" },
            ]}
          />

          <div class="flex flex-col gap-3">
            <Switch>
              <Match when={mode() === "text"}>
                <TextInput
                  label={t().textLabel}
                  description={t().textDescription}
                  placeholder={t().textPlaceholder}
                  icon="ti ti-link"
                  multiline
                  lines={4}
                  value={text}
                  onValueChange={setText}
                />
              </Match>

              <Match when={mode() === "wifi"}>
                <TextInput
                  label={t().wifiSsidLabel}
                  description={t().wifiSsidDescription}
                  placeholder={t().wifiSsidPlaceholder}
                  icon="ti ti-wifi"
                  value={wifiSsid}
                  onValueChange={setWifiSsid}
                  required
                />
                <TextInput
                  label={t().wifiPasswordLabel}
                  description={t().wifiPasswordDescription}
                  placeholder={t().wifiPasswordPlaceholder}
                  icon="ti ti-lock"
                  value={wifiPassword}
                  onValueChange={setWifiPassword}
                  password
                />
                <div class="grid grid-cols-1 items-end gap-3 sm:grid-cols-2">
                  <Select
                    label={t().wifiEncryptionLabel}
                    icon="ti ti-shield-lock"
                    value={wifiEncryption}
                    onValueChange={setWifiEncryption}
                    options={[
                      { id: "WPA", label: "WPA / WPA2" },
                      { id: "WEP", label: "WEP" },
                      { id: "nopass", label: t().wifiEncryptionNone },
                    ]}
                  />
                  <div class="flex h-9.5 items-center">
                    <Toggle label={t().wifiHiddenLabel} value={wifiHidden} onValueChange={setWifiHidden} />
                  </div>
                </div>
              </Match>

              <Match when={mode() === "email"}>
                <TextInput
                  label={t().emailToLabel}
                  description={t().emailToDescription}
                  placeholder={t().emailToPlaceholder}
                  icon="ti ti-mail"
                  value={emailTo}
                  onValueChange={setEmailTo}
                  required
                />
                <TextInput
                  label={t().emailSubjectLabel}
                  placeholder={t().emailSubjectPlaceholder}
                  icon="ti ti-text-caption"
                  value={emailSubject}
                  onValueChange={setEmailSubject}
                />
                <TextInput
                  label={t().emailBodyLabel}
                  placeholder={t().emailBodyPlaceholder}
                  icon="ti ti-align-left"
                  multiline
                  value={emailBody}
                  onValueChange={setEmailBody}
                />
              </Match>

              <Match when={mode() === "tel"}>
                <TextInput
                  label={t().telLabel}
                  description={t().telDescription}
                  placeholder="+49 123 456 7890"
                  icon="ti ti-phone"
                  value={telNumber}
                  onValueChange={setTelNumber}
                  required
                />
              </Match>

              <Match when={mode() === "vcard"}>
                <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <TextInput
                    label={t().vcFirstNameLabel}
                    placeholder={t().vcFirstNamePlaceholder}
                    icon="ti ti-user"
                    value={vcFirstName}
                    onValueChange={setVcFirstName}
                    required
                  />
                  <TextInput label={t().vcLastNameLabel} placeholder={t().vcLastNamePlaceholder} value={vcLastName} onValueChange={setVcLastName} />
                </div>
                <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <TextInput label={t().vcOrgLabel} placeholder={t().vcOrgPlaceholder} icon="ti ti-building" value={vcOrg} onValueChange={setVcOrg} />
                  <TextInput
                    label={t().vcTitleLabel}
                    placeholder={t().vcTitlePlaceholder}
                    icon="ti ti-briefcase"
                    value={vcTitle}
                    onValueChange={setVcTitle}
                  />
                </div>
                <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <TextInput label={t().vcPhoneLabel} placeholder="+49 123 456 7890" icon="ti ti-phone" value={vcPhone} onValueChange={setVcPhone} />
                  <TextInput label={t().vcEmailLabel} placeholder={t().vcEmailPlaceholder} icon="ti ti-mail" value={vcEmail} onValueChange={setVcEmail} />
                </div>
                <TextInput
                  label={t().vcWebsiteLabel}
                  placeholder="https://example.com"
                  icon="ti ti-world"
                  value={vcWebsite}
                  onValueChange={setVcWebsite}
                />
                <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <TextInput label={t().vcStreetLabel} placeholder={t().vcStreetPlaceholder} icon="ti ti-map-pin" value={vcStreet} onValueChange={setVcStreet} />
                  <TextInput label={t().vcCityLabel} placeholder="Berlin" value={vcCity} onValueChange={setVcCity} />
                </div>
                <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <TextInput label={t().vcZipLabel} placeholder="10115" value={vcZip} onValueChange={setVcZip} />
                  <TextInput label={t().vcCountryLabel} placeholder={t().vcCountryPlaceholder} value={vcCountry} onValueChange={setVcCountry} />
                </div>
              </Match>

              <Match when={mode() === "event"}>
                <TextInput
                  label={t().evTitleLabel}
                  placeholder={t().evTitlePlaceholder}
                  icon="ti ti-calendar-event"
                  value={evTitle}
                  onValueChange={setEvTitle}
                  required
                />
                <TextInput
                  label={t().evLocationLabel}
                  description={t().evLocationDescription}
                  placeholder={t().evLocationPlaceholder}
                  icon="ti ti-map-pin"
                  value={evLocation}
                  onValueChange={setEvLocation}
                />
                <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <DateTimePicker
                    label={t().evStartLabel}
                    value={() => evStart() || null}
                    onValueChange={(value) => setEvStart(value ?? "")}
                    clearable
                  />
                  <DateTimePicker label={t().evEndLabel} value={() => evEnd() || null} onValueChange={(value) => setEvEnd(value ?? "")} clearable />
                </div>
                <TextInput
                  label={t().evDescriptionLabel}
                  placeholder={t().evDescriptionPlaceholder}
                  icon="ti ti-align-left"
                  multiline
                  value={evDescription}
                  onValueChange={setEvDescription}
                />
              </Match>
            </Switch>
          </div>
        </section>

        <section class="paper tools-qr-preview flex flex-col gap-4 p-4" aria-live="polite">
          <header class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <h2 class="text-sm font-semibold text-primary">{t().previewHeading}</h2>
              <p class="text-xs text-dimmed">{t().previewSubtitle}</p>
            </div>
            <span class="shrink-0 rounded-[var(--ui-radius-control)] bg-[var(--ui-surface)] px-2 py-1 text-xs tabular-nums text-dimmed">
              {size()} px
            </span>
          </header>

          <div class="tools-qr-preview-frame">
            <Show
              when={qrSvg()}
              fallback={
                <div class="max-w-64 text-center">
                  <div class="mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-[var(--ui-radius-control)] border border-[var(--ui-state-icon-border)] bg-[var(--ui-state-icon-surface)] text-dimmed">
                    <i class={`ti ${payload() ? "ti-alert-circle" : "ti-qrcode-off"} text-lg`} />
                  </div>
                  <p class="text-sm font-medium text-primary">{payload() ? t().previewUnavailable : t().previewEmpty}</p>
                  <p class="mt-0.5 text-xs text-dimmed">{payload() ? t().previewUnavailableHint : t().previewEmptyHint}</p>
                </div>
              }
            >
              <img src={svgDataUrl()} alt={t().qrAlt} class="tools-qr-image" />
            </Show>
          </div>

          <Show when={qrSvg()}>
            <div class="flex flex-wrap items-center justify-center gap-2">
              <Button size="sm" onClick={downloadSvg}>
                <i class="ti ti-download" />
                {t().downloadSvg}
              </Button>
              <Button variant="secondary" size="sm" onClick={downloadPng}>
                <i class="ti ti-photo-down" />
                PNG
              </Button>
              <CopyButton text={payload()} label={t().copyContent} variant="secondary" size="sm" />
            </div>
          </Show>
        </section>

        <details class="paper tools-qr-advanced group p-4" open>
          <summary class="focus-ui flex cursor-pointer list-none items-center justify-between gap-3 rounded-[var(--ui-radius-control)]">
            <span>
              <span class="block text-sm font-semibold text-primary">{t().advancedTitle}</span>
              <span class="block text-xs font-normal text-dimmed">{t().advancedSubtitle}</span>
            </span>
            <i class="ti ti-chevron-down shrink-0 text-sm text-dimmed transition-transform group-open:rotate-180" />
          </summary>

          <div class="mt-4 flex flex-col gap-3">
            <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Select
                label={t().ecLabel}
                description={t().ecDescription}
                icon="ti ti-shield-check"
                value={ecLevel}
                onValueChange={setEcLevel}
                options={[
                  { id: "L", label: t().ecLow },
                  { id: "M", label: t().ecMedium },
                  { id: "Q", label: t().ecQuartile },
                  { id: "H", label: t().ecHigh },
                ]}
              />
              <ColorInput label={t().fgLabel} description={t().fgDescription} value={fgColor} onValueChange={setFgColor} />
              <ColorInput
                label={t().bgLabel}
                description={t().bgDescription}
                value={bgColor}
                onValueChange={setBgColor}
                transparent
                transparentValue={transparentBg}
                onTransparentValueChange={setTransparentBg}
              />
            </div>
            <Slider
              label={t().sizeLabel}
              description={t().sizeDescription}
              value={size}
              onValueChange={setSize}
              min={100}
              max={1000}
              step={50}
              showValue
            />
          </div>
        </details>
      </div>

      <p class="tools-local-note">
        <i class="ti ti-device-laptop" />
        {t().localNote}
      </p>
    </div>
  );
}
