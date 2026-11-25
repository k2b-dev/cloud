import type { ObservabilityAreaNav } from "./ObservabilityNav";

/** The area's sidebar as the pages build it, with invented attention marks. */
export const fixtureArea: ObservabilityAreaNav = {
  title: "Observability",
  markLabel: "Braucht Aufmerksamkeit",
  groups: [
    { items: [{ id: "home", label: "Übersicht", href: "/admin/observability", icon: "ti ti-dashboard", mark: "warning" }] },
    {
      title: "Ansehen",
      items: [
        { id: "logs", label: "Protokolle", href: "/admin/observability/logs", icon: "ti ti-file-text" },
        { id: "jobs", label: "Jobs", href: "/admin/observability/jobs", icon: "ti ti-hourglass" },
        { id: "workflows", label: "Workflows", href: "/admin/observability/workflows", icon: "ti ti-binary-tree" },
        { id: "telemetry", label: "Telemetrie", href: "/admin/observability/telemetry", icon: "ti ti-activity" },
        { id: "metrics", label: "Metriken", href: "/admin/observability/metrics", icon: "ti ti-chart-bar" },
      ],
    },
    {
      title: "Dienste",
      items: [
        { id: "postgres", label: "Postgres", href: "/admin/observability/postgres", icon: "ti ti-database" },
        { id: "valkey", label: "Valkey", href: "/admin/observability/valkey", icon: "ti ti-database" },
        { id: "nats", label: "NATS & Sync", href: "/admin/observability/nats", icon: "ti ti-topology-star-3", mark: "error" },
      ],
    },
  ],
};

/** A long unbroken name, as a worst case for cells and heads. */
export const LONG = "kv_spaces_presence_cursor_shadow_workspace_7f3a9c2e41b8d6f0a5c3e9b1d7f2a8c4e6b0d9f3a1c5e7b2d4f6a8c0e";
