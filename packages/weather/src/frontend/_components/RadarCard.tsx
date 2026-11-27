import { useLocale } from "@k2b/ui";
import { weatherMessages } from "../../messages";

// DWD Germany-wide radar GIF
const DWD_RADAR_URL = "https://www.dwd.de/DWD/wetter/radar/radfilm_brd_akt.gif";

/**
 * The DWD radar's own colours for the intensity of precipitation, from light to extreme, as the picture draws them. The
 * legend repeats them in the same order so the picture can be read; they are the provider's colours, not Cloud's.
 */
const RADAR_SCALE = ["#22d3ee", "#16a34a", "#4ade80", "#facc15", "#f97316", "#ef4444", "#9333ea", "#1e3a8a"];

type RadarCardProps = {
  /** Show legend (default: true) */
  showLegend?: boolean;
  /** Size variant */
  size?: "sm" | "md" | "lg";
  /** Custom max height class (e.g., "max-h-64") */
  maxHeight?: string;
  /** The locale of the words; the screen around it passes its own, else the page's. */
  locale?: string;
};

/** The legend's sizes in px: its words, and the height of its colour bar. */
const legendSizes = {
  sm: { text: 8, bar: 6 },
  md: { text: 10, bar: 8 },
  lg: { text: 12, bar: 10 },
};

export default function RadarCard(props: RadarCardProps) {
  const pageLocale = useLocale();
  const t = () => weatherMessages.resolve([props.locale ?? pageLocale()]).t;
  const s = legendSizes[props.size ?? "md"];
  const words = { "font-size": `${s.text}px`, "line-height": 1.4, color: "var(--k2-subtle, currentColor)" } as const;

  return (
    <div class="flex h-full min-h-0 flex-col">
      <div class={`thumbnail aspect-[540/500] w-full shrink-0 overflow-hidden bg-zinc-100 dark:bg-zinc-800 ${props.maxHeight ?? ""}`}>
        <img src={DWD_RADAR_URL} alt={t().radarAlt} class="h-full w-full object-cover" loading="lazy" />
      </div>

      {(props.showLegend ?? true) && (
        <>
          {/* the picture's colours from light to extreme, drawn with fixed values so the legend never depends on a
              stylesheet, and its four words under them */}
          <div role="img" aria-label={t().precipitationLegend} style={{ "margin-top": "8px" }}>
            <div style={{ display: "flex", height: `${s.bar}px`, "border-radius": "4px", overflow: "hidden" }}>
              {RADAR_SCALE.map((color) => (
                <div style={{ flex: "1", background: color }} />
              ))}
            </div>
            <div style={{ display: "flex", "justify-content": "space-between", "margin-top": "4px", ...words }}>
              <span>{t().light}</span>
              <span>{t().moderate}</span>
              <span>{t().heavy}</span>
              <span>{t().extreme}</span>
            </div>
          </div>
          <p style={{ "margin-top": "4px", "text-align": "center", ...words }}>{t().germany} · DWD</p>
        </>
      )}
    </div>
  );
}
