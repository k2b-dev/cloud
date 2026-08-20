import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const TABLER_ICON = /^ti-([a-z0-9]+(?:-[a-z0-9]+)*)$/;

export function tablerIconName(iconClass: string): string {
  const classes = iconClass.trim().split(/\s+/);
  const match = classes.length === 2 && classes[0] === "ti" ? TABLER_ICON.exec(classes[1] ?? "") : null;
  if (!match?.[1]) throw new Error(`App icon must be a Tabler class such as "ti ti-mail"; received ${JSON.stringify(iconClass)}`);
  return match[1];
}

export function renderAppFavicon(sourceSvg: string): string {
  const source = sourceSvg.match(/<svg\b[^>]*>([\s\S]*?)<\/svg>\s*$/i);
  if (!source?.[1]) throw new Error("Tabler icon did not contain an SVG body");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
  <defs>
    <linearGradient id="cloud-icon" x1="12" y1="2" x2="12" y2="22" gradientUnits="userSpaceOnUse">
      <stop stop-color="#f0f6ff" />
      <stop offset="1" stop-color="#1f8bff" />
    </linearGradient>
  </defs>
  <g fill="none" stroke="url(#cloud-icon)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
${source[1].trim()}
  </g>
</svg>\n`;
}

export async function writeAppFavicon(options: { publicDir: string; appId: string; icon: string }): Promise<string> {
  const iconName = tablerIconName(options.icon);
  let sourcePath: string;
  try {
    sourcePath = Bun.resolveSync(`@tabler/icons/outline/${iconName}.svg`, resolve(import.meta.dir, ".."));
  } catch {
    throw new Error(`Unknown Tabler app icon ${JSON.stringify(options.icon)}`);
  }

  const target = resolve(options.publicDir, options.appId, "favicon.svg");
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, renderAppFavicon(await readFile(sourcePath, "utf8")));
  return target;
}
