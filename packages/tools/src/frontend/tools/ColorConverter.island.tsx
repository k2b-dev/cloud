import { i18n } from "@k2b/stdlib";
import { ColorInput, CopyButton, NoticeCard, TextInput, useLocale } from "@k2b/ui";
import { batch, createSignal } from "solid-js";

export const colorMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      hint: "Edit any field and the other formats update automatically.",
      colorPicker: "Color Picker",
      hexDescription: "6-digit hex color code",
      rgbDescription: "Red, Green, Blue — each 0–255",
      hslDescription: "Hue 0–360, Saturation 0–100%, Lightness 0–100%",
      invalidHex: "Invalid HEX format",
      invalidRgb: "Invalid RGB format",
      invalidHsl: "Invalid HSL format",
    },
    de: {
      hint: "Ändere ein Feld und die anderen Formate werden automatisch aktualisiert.",
      colorPicker: "Farbauswahl",
      hexDescription: "6-stelliger Hex-Farbcode",
      rgbDescription: "Rot, Grün und Blau, jeweils 0 bis 255",
      hslDescription: "Farbton 0 bis 360, Sättigung und Helligkeit 0 bis 100 %",
      invalidHex: "Gib einen gültigen HEX-Wert an.",
      invalidRgb: "Gib einen gültigen RGB-Wert an.",
      invalidHsl: "Gib einen gültigen HSL-Wert an.",
    },
  },
});

// Conversion helpers

const hexToRgb = (hex: string): [number, number, number] | null => {
  const m = hex.replace("#", "").match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return null;
  return [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)];
};

const rgbToHex = (r: number, g: number, b: number): string =>
  "#" +
  [r, g, b]
    .map((v) =>
      Math.max(0, Math.min(255, Math.round(v)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("");

const rgbToHsl = (r: number, g: number, b: number): [number, number, number] => {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, Math.round(l * 100)];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [Math.round(h * 360), Math.round(s * 100), Math.round(l * 100)];
};

const hslToRgb = (h: number, s: number, l: number): [number, number, number] => {
  h /= 360;
  s /= 100;
  l /= 100;
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [Math.round(hue2rgb(p, q, h + 1 / 3) * 255), Math.round(hue2rgb(p, q, h) * 255), Math.round(hue2rgb(p, q, h - 1 / 3) * 255)];
};

const parseRgb = (s: string): [number, number, number] | null => {
  const m = s.match(/(\d{1,3})\s*[,\s]\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})/);
  if (!m) return null;
  const [r, g, b] = [parseInt(m[1]!), parseInt(m[2]!), parseInt(m[3]!)];
  if (r > 255 || g > 255 || b > 255) return null;
  return [r, g, b];
};

const parseHsl = (s: string): [number, number, number] | null => {
  const m = s.match(/(\d{1,3})\s*[,\s]\s*(\d{1,3})%?\s*[,\s]\s*(\d{1,3})%?/);
  if (!m) return null;
  const [h, sat, l] = [parseInt(m[1]!), parseInt(m[2]!), parseInt(m[3]!)];
  if (h > 360 || sat > 100 || l > 100) return null;
  return [h, sat, l];
};

type Source = "hex" | "rgb" | "hsl" | "picker";

export default function ColorConverter() {
  const locale = useLocale();
  const t = () => colorMessages.resolve([locale()]).t;
  const [hex, setHex] = createSignal("#3b82f6");
  const [rgb, setRgb] = createSignal("59, 130, 246");
  const [hsl, setHsl] = createSignal("217, 91%, 60%");
  const [pickerColor, setPickerColor] = createSignal("#3b82f6");
  const [hexError, setHexError] = createSignal<string | undefined>();
  const [rgbError, setRgbError] = createSignal<string | undefined>();
  const [hslError, setHslError] = createSignal<string | undefined>();

  let isUpdating = false;

  const syncFrom = (source: Source) => {
    if (isUpdating) return;
    isUpdating = true;
    batch(() => {
      // Clear errors for the source field
      if (source === "hex") setHexError(undefined);
      if (source === "rgb") setRgbError(undefined);
      if (source === "hsl") setHslError(undefined);

      if (source === "picker") {
        const val = pickerColor();
        setHex(val);
        setHexError(undefined);
        const c = hexToRgb(val);
        if (c) {
          setRgb(`${c[0]}, ${c[1]}, ${c[2]}`);
          setRgbError(undefined);
          const [h, s, l] = rgbToHsl(...c);
          setHsl(`${h}, ${s}%, ${l}%`);
          setHslError(undefined);
        }
      } else if (source === "hex") {
        const val = hex().startsWith("#") ? hex() : `#${hex()}`;
        const c = hexToRgb(val);
        if (c) {
          setHex(val);
          setPickerColor(val);
          setRgb(`${c[0]}, ${c[1]}, ${c[2]}`);
          setRgbError(undefined);
          const [h, s, l] = rgbToHsl(...c);
          setHsl(`${h}, ${s}%, ${l}%`);
          setHslError(undefined);
        } else if (hex().replace("#", "").length >= 6) {
          setHexError(t().invalidHex);
        }
      } else if (source === "rgb") {
        const c = parseRgb(rgb());
        if (c) {
          const h = rgbToHex(...c);
          setHex(h);
          setPickerColor(h);
          setHexError(undefined);
          const [hh, s, l] = rgbToHsl(...c);
          setHsl(`${hh}, ${s}%, ${l}%`);
          setHslError(undefined);
        } else if (rgb().trim().length > 0) {
          setRgbError(t().invalidRgb);
        }
      } else if (source === "hsl") {
        const c = parseHsl(hsl());
        if (c) {
          const [r, g, b] = hslToRgb(...c);
          const h = rgbToHex(r, g, b);
          setHex(h);
          setPickerColor(h);
          setHexError(undefined);
          setRgb(`${r}, ${g}, ${b}`);
          setRgbError(undefined);
        } else if (hsl().trim().length > 0) {
          setHslError(t().invalidHsl);
        }
      }
    });
    isUpdating = false;
  };

  const CopyBtn = (props: { value: string }) => <CopyButton text={props.value} class="shrink-0" />;

  return (
    <div class="flex flex-col gap-4">
      <NoticeCard tone="info" icon={false} bodyClass="flex items-start gap-2">
        <i class="ti ti-info-circle shrink-0 mt-0.5" />
        <span>{t().hint}</span>
      </NoticeCard>

      <div class="paper p-4 flex flex-col gap-4">
        {/* Color preview */}
        <div class="flex items-center gap-4">
          <div
            class="w-20 h-20 thumbnail border border-zinc-200 dark:border-zinc-700 shrink-0"
            style={{ "background-color": pickerColor() }}
          />
          <div class="flex-1">
            <ColorInput
              label={t().colorPicker}
              value={pickerColor}
              onValueChange={(v) => {
                setPickerColor(v);
                syncFrom("picker");
              }}
            />
          </div>
        </div>

        {/* HEX */}
        <div class="flex items-end gap-2">
          <div class="flex-1">
            <TextInput
              label="HEX"
              description={t().hexDescription}
              placeholder="#000000"
              icon="ti ti-hash"
              value={hex}
              onValueChange={(v) => {
                setHex(v);
                syncFrom("hex");
              }}
              error={hexError}
            />
          </div>
          <CopyBtn value={hex()} />
        </div>

        {/* RGB */}
        <div class="flex items-end gap-2">
          <div class="flex-1">
            <TextInput
              label="RGB"
              description={t().rgbDescription}
              placeholder="255, 255, 255"
              icon="ti ti-palette"
              value={rgb}
              onValueChange={(v) => {
                setRgb(v);
                syncFrom("rgb");
              }}
              error={rgbError}
            />
          </div>
          <CopyBtn value={`rgb(${rgb()})`} />
        </div>

        {/* HSL */}
        <div class="flex items-end gap-2">
          <div class="flex-1">
            <TextInput
              label="HSL"
              description={t().hslDescription}
              placeholder="0, 100%, 50%"
              icon="ti ti-color-swatch"
              value={hsl}
              onValueChange={(v) => {
                setHsl(v);
                syncFrom("hsl");
              }}
              error={hslError}
            />
          </div>
          <CopyBtn value={`hsl(${hsl()})`} />
        </div>
      </div>
    </div>
  );
}
