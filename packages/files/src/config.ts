import { defineApp } from "@valentinkolb/cloud";

const envString = (key: string): string | undefined => {
  const v = process.env[key]?.trim();
  return v && v.length > 0 ? v : undefined;
};

export const app = defineApp({
  id: "files",
  name: "Files",
  icon: "ti ti-folders",
  description: "Browse, upload, move, and manage files across accessible bases.",
  presentation: {
    baseLocale: "en",
    translations: {
      de: {
        name: "Dateien",
        description: "Dateien in zugänglichen Ablagen durchsuchen, hochladen, verschieben und verwalten.",
      },
    },
  },
  appearance: { accent: "#1d4ed8", background: { from: "#2563eb", to: "#38bdf8", angle: 135 } },
  basePath: "/app/files",
  baseUrl: "http://app-files:3000",
  adminHref: "/admin/files",
  nav: {
    href: "/app/files",
    match: "/app/files",
    section: "primary",
    requiresAuth: true,
    requiresRoles: ["ipa"],
  },
  settings: {
    "files.filegate_url": {
      kind: "url",
      label: "Filegate URL",
      default: "http://localhost:4000",
      description: "Filegate proxy URL for file operations",
      placeholder: "e.g. http://filegate:4000",
      envFallback: () => envString("FILEGATE_URL"),
      envBootstrap: () => envString("FILEGATE_URL"),
    },
    "files.filegate_token": {
      kind: "secret",
      label: "Filegate Token",
      default: "",
      description: "Filegate authentication token",
      envFallback: () => envString("FILEGATE_TOKEN"),
      envBootstrap: () => envString("FILEGATE_TOKEN"),
    },
    "files.base_homes": {
      kind: "string",
      label: "Base Homes",
      default: "/data/homes",
      description: "Home directories base path",
      placeholder: "e.g. /data/homes",
    },
    "files.base_groups": {
      kind: "string",
      label: "Base Groups",
      default: "/data/groups",
      description: "Group directories base path",
      placeholder: "e.g. /data/groups",
    },
    "files.home_dir_mode": {
      kind: "string",
      label: "Home Dir Mode",
      default: "700",
      description: "Unix permissions for user home directories (octal, e.g. 700)",
      placeholder: "e.g. 700",
    },
    "files.home_file_mode": {
      kind: "string",
      label: "Home File Mode",
      default: "600",
      description: "Unix permissions for files in home directories (octal, e.g. 600)",
      placeholder: "e.g. 600",
    },
    "files.group_dir_mode": {
      kind: "string",
      label: "Group Dir Mode",
      default: "2770",
      description: "Unix permissions for group directories (octal, e.g. 2770 for sticky bit)",
      placeholder: "e.g. 2770",
    },
    "files.group_file_mode": {
      kind: "string",
      label: "Group File Mode",
      default: "660",
      description: "Unix permissions for files in group directories (octal, e.g. 660)",
      placeholder: "e.g. 660",
    },
  },
  openapi: "/api/files/openapi.json",
  routes: ["/api/files", "/app/files", "/admin/files", "/public/files"],
});

export const { ssr, plugin } = app;
