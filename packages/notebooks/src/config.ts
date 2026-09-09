import { defineApp } from "@k2b/cloud";

export const app = defineApp({
  id: "notebooks",
  name: "Notebooks",
  icon: "ti ti-note",
  description: "Collaborative notebooks with structured notes and realtime sync.",
  presentation: {
    baseLocale: "en",
    translations: {
      de: {
        name: "Notizbücher",
        description: "Gemeinsam bearbeitete Notizbücher mit strukturierten Notizen und Echtzeitsynchronisierung.",
      },
    },
  },
  appearance: {
    accent: "#eab308",
    background: {
      from: "#ffd60a",
      to: "#ffcc00",
      angle: 145,
      strength: 24,
    },
  },
  basePath: "/app/notebooks",
  baseUrl: "http://app-notebooks:3000",
  adminHref: "/admin/notebooks",
  nav: {
    href: "/app/notebooks?recent=true",
    match: "/app/notebooks",
    section: "primary",
    requiresAuth: true,
  },
  widgets: [{ id: "recent", path: "/api/notebooks/widget/recent", presentation: { defaultSpan: "wide" } }],
  openapi: "/api/notebooks/openapi.json",
  routes: ["/api/notebooks", "/app/notebooks", "/admin/notebooks", "/public/notebooks"],
  settings: {
    "notebooks.reindex_cron": {
      kind: "cron",
      label: "Reindex Cron",
      default: "0 */12 * * *",
      description: "Five-field cron schedule for the periodic note-refs reindex job (links, tags, attachments) in app.timezone.",
      presentation: {
        translations: {
          de: {
            label: "Neuindizierungszeitplan",
            description:
              "Fünfteiliger Cron-Zeitplan für die regelmäßige Neuindizierung von Notizreferenzen (Links, Tags und Anhänge) in app.timezone.",
          },
        },
      },
    },
    "notebooks.snapshot_cron": {
      kind: "cron",
      label: "Snapshot Cron",
      default: "0 3 * * *",
      description: "Five-field cron schedule for automatic notebook S3 snapshots in app.timezone.",
      presentation: {
        translations: {
          de: {
            label: "Snapshot-Zeitplan",
            description: "Fünfteiliger Cron-Zeitplan für automatische S3-Snapshots von Notizbüchern in app.timezone.",
          },
        },
      },
    },
    "notebooks.max_attachment_size_mb": {
      kind: "number",
      label: "Max Attachment Size",
      default: 10,
      min: 1,
      max: 200,
      description:
        "Per-file upload limit for notebook attachments (megabytes). Oversize images are auto-resized client-side before the upload hits this gate; non-image files exceeding the limit are rejected with a clear error.",
      presentation: {
        translations: {
          de: {
            label: "Maximale Anhanggröße",
            description:
              "Uploadgrenze pro Notizbuch-Anhang in Megabyte. Zu große Bilder werden vor dem Upload im Browser verkleinert; andere Dateien oberhalb der Grenze werden mit einem klaren Fehler abgelehnt.",
          },
        },
      },
    },
    "notebooks.max_image_dimension_px": {
      kind: "number",
      label: "Max Image Side",
      default: 2048,
      min: 256,
      max: 8192,
      description:
        "Longest-side cap (pixels) applied when an oversize image is auto-resized before upload. Aspect ratio is preserved; PNG inputs stay PNG, everything else becomes WebP at quality 0.85.",
      presentation: {
        translations: {
          de: {
            label: "Maximale Bildkante",
            description:
              "Obergrenze der längsten Bildkante in Pixeln beim automatischen Verkleinern vor dem Upload. Das Seitenverhältnis bleibt erhalten; PNG bleibt PNG, alle anderen Formate werden mit Qualität 0.85 zu WebP.",
          },
        },
      },
    },
  },
});

export const { ssr, plugin } = app;
