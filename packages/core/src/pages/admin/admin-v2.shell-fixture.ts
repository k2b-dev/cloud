import { resolve } from "node:path";
import type { CloudRuntime, RuntimeAppMeta } from "@k2b/cloud/contracts";
import { app as core } from "../../config";

/** An invented app of the installation, so the shell's rail shows icons as a real Cloud does. */
const sample = (id: string, name: string, icon: string, accent: string, from: string, to: string): RuntimeAppMeta =>
  ({
    package: id,
    id,
    name,
    icon,
    description: "",
    routes: [`/app/${id}`],
    nav: { href: `/app/${id}`, section: "primary" },
    appearance: { accent, background: { from, to, angle: 135 } },
  }) as RuntimeAppMeta;

/**
 * The shell as the admin pages have it in a running Cloud (look rules: an image without the real shell is no evidence):
 * Core's own meta, which tints the page in the administration's colour, and a handful of apps in the rail.
 */
export const adminShellRuntime = (): CloudRuntime => ({
  apps: [
    core.meta as RuntimeAppMeta,
    sample("mail", "Mail", "ti ti-mail", "#2563eb", "#3b82f6", "#60a5fa"),
    sample("files", "Dateien", "ti ti-folder", "#0d9488", "#14b8a6", "#5eead4"),
    sample("spaces", "Spaces", "ti ti-layout-grid", "#7c3aed", "#8b5cf6", "#c4b5fd"),
    sample("pulse", "Pulse", "ti ti-activity", "#db2777", "#ec4899", "#f9a8d4"),
  ],
});

/** Cloud's logo for the shell, as `/branding/logo` serves it; `undefined` for any other path. */
export const adminShellAsset = (pathname: string): Response | undefined =>
  pathname === "/branding/logo" ? new Response(Bun.file(resolve(import.meta.dir, "../../../../cloud/public/logo.svg"))) : undefined;
