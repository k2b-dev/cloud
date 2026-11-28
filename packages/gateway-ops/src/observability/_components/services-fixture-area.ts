import type { NavProps } from "@k2b/ui/v2";

/** The admin bar as `observabilityAdminNav` builds it: the area's sections one level in under "Observability". */
export const fixtureNav: NavProps = {
  title: "Administration",
  icon: "settings",
  groups: [
    {
      items: [
        { label: "Übersicht", icon: "layout-dashboard", href: "/admin" },
        { label: "Basiseinstellungen", icon: "adjustments", href: "/admin/settings" },
      ],
    },
    {
      label: "Betrieb",
      items: [
        { label: "Apps", icon: "apps", href: "/admin/apps" },
        { label: "Observability", icon: "activity", href: "/admin/observability" },
        { label: "Übersicht", icon: "dashboard", href: "/admin/observability", nested: true, dot: "warn" },
        { label: "Protokolle", icon: "file-text", href: "/admin/observability/logs", nested: true },
        { label: "Workflows", icon: "binary-tree", href: "/admin/observability/workflows", nested: true },
        { label: "Telemetrie", icon: "activity", href: "/admin/observability/telemetry", nested: true },
        { label: "Metriken", icon: "chart-bar", href: "/admin/observability/metrics", nested: true },
        { label: "Infrastruktur", icon: "server-2", href: "/admin/observability/infrastructure", nested: true, current: true, dot: "bad" },
        { label: "Einstellungen", icon: "settings", href: "/admin/observability/settings", nested: true },
        { label: "Personen", icon: "users", href: "/app/accounts" },
      ],
    },
  ],
};

/** A long unbroken name, as a worst case for cells and heads. */
export const LONG = "kv_spaces_presence_cursor_shadow_workspace_7f3a9c2e41b8d6f0a5c3e9b1d7f2a8c4e6b0d9f3a1c5e7b2d4f6a8c0e";
