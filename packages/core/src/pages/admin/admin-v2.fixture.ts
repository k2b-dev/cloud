import type { NavProps } from "@k2b/ui/v2";

// Frozen sample data shared by the v2 admin screens' render and browser tests: the admin bar as `adminNavigation(c)`
// builds it for a German administrator, with one entry current.

const groups = (current: string, sections: NavProps["groups"][number]["items"] = []): NavProps["groups"] => {
  const item = (label: string, icon: string, href: string, extra: { count?: number } = {}) => {
    const open = href === current;
    return [
      { label, icon, href, ...(open && !sections.some((section) => section.current) ? { current: true } : {}), ...extra },
      ...(open ? sections : []),
    ];
  };
  return [
    { items: item("Übersicht", "dashboard", "/admin") },
    {
      label: "Einrichten",
      items: [
        ...item("Grundeinstellungen", "adjustments", "/admin/base"),
        ...item("Speicher", "database", "/admin/storage"),
        ...item("Anmeldung & Sicherheit", "shield-lock", "/admin/signin"),
        ...item("Ausgehende Mail", "mail", "/admin/outgoing-mail"),
        ...item("Ankündigungen", "speakerphone", "/admin/announcements"),
        ...item("KI", "sparkles", "/admin/ai"),
      ],
    },
    {
      label: "Betrieb",
      items: [
        ...item("Apps", "apps", "/admin/apps"),
        ...item("Code", "code", "/admin/code", { count: 2 }),
        ...item("Wartungsmodus", "barrier-block", "/admin/settings/maintenance"),
        ...item("Observability", "heart-rate-monitor", "/admin/observability"),
      ],
    },
    { label: "Einstellungen je App", items: [...item("Mail", "mail", "/admin/mail"), ...item("Spaces", "layout-grid", "/admin/spaces")] },
  ];
};

/** The admin bar with `current` open; an area adds its sections, one level in under its entry. */
export const adminNavFixture = (current: string, sections: NavProps["groups"][number]["items"] = []): NavProps => ({
  title: "Administration",
  icon: "settings",
  groups: groups(current, sections),
});
