import { Button, IconButtonLink, Dropdown, Paper, StatusBadge, useLocale, type DropdownItem } from "@k2b/ui";
import { Show } from "solid-js";
import type { ArtifactSummary } from "./service";
import { artifactMessages } from "./messages";
const studioPalette = [
  ["#4266a8", "#6ab5cd", "#9bbbf6"],
  ["#217f77", "#78b9a9", "#84d5c8"],
  ["#7660ab", "#bb9ad0", "#bfadf1"],
  ["#b37027", "#e5b979", "#efc189"],
  ["#ac586d", "#d39cad", "#efa9bc"],
  ["#397f98", "#8fc4d3", "#94d4ec"],
] as const;

function studioColor(id: string) {
  let hash = 2166136261;
  for (const character of id) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  const [accent, secondary, dark] = studioPalette[(hash >>> 0) % studioPalette.length]!;
  return { "--studio-accent-light": accent, "--studio-secondary": secondary, "--studio-accent-dark": dark };
}

export function StudioCard(props: { item: ArtifactSummary; menu: readonly DropdownItem[]; busy?: boolean; onStart: () => void; external?: boolean }) {
  const locale = useLocale(), t = () => artifactMessages.resolve([locale()]).t;
  return                   <Paper class="assistant-studio-card" style={studioColor(props.item.id)}>
                    <div class="assistant-studio-card__top" classList={{ "assistant-studio-card__top--title-only": !props.item.description?.trim() }}>
                      <div class="assistant-studio-card__icon" aria-hidden="true"><i class={props.item.icon ?? "ti ti-app-window"} /></div>
                      <div class="assistant-studio-card__copy">
                        <h2 class="assistant-studio-card__title">{props.item.title}</h2>
                        <Show when={props.item.description?.trim()}><p class="assistant-studio-card__description">{props.item.description}</p></Show>
                      </div>
                      <div class="assistant-studio-card__menu"><Dropdown.Root items={props.menu}>
                        <Dropdown.Trigger iconOnly variant="ghost" label={`${t().actions} · ${props.item.title}`} disabled={props.busy}><i class="ti ti-dots" /></Dropdown.Trigger>
                      </Dropdown.Root></div>
                    </div>
                    <div class="assistant-studio-card__footer">
                      <Show when={props.item.publishedRevision}><StatusBadge variant="dot" tone="running" label={t().published} /></Show>
                      <div class="flex items-center gap-1"><Button size="sm" variant="secondary" class="assistant-studio-card__start" onClick={props.onStart}><i class="ti ti-player-play" />{t().start}</Button><Show when={props.external}><IconButtonLink size="sm" variant="secondary" label={locale().startsWith("de") ? "In neuem Tab öffnen" : "Open in new tab"} href={`/app/assistant/apps/${props.item.id}`} target="_blank" rel="noopener noreferrer"><i class="ti ti-external-link" aria-hidden="true" /></IconButtonLink></Show></div>
                    </div>
                  </Paper>;
}
