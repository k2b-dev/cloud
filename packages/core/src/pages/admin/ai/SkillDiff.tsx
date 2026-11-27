import { For, Show } from "solid-js";
import type { SkillFileDiff } from "../settings/_components/skill-diff";

/**
 * The line differences of a Skill against its app version, one block per file: lines only in this Skill (−), lines
 * from the app (+), unchanged runs folded. k2b-ui gap: v2 has no diff or code view, so this drawing stands in a
 * `Canvas`, the one place for own markup; the screen places it, and the drawing keeps the 20 px text edge itself.
 */
export default function SkillDiff(props: {
  files: readonly SkillFileDiff[];
  replaced: string;
  unchanged: (count: number) => string;
}) {
  return (
    <div class="flex flex-col gap-5 px-5">
      <For each={props.files}>
        {(file) => (
          <section class="flex min-w-0 flex-col gap-1" aria-label={file.path}>
            <h3 class="flex items-baseline gap-2 text-xs font-medium text-primary">
              <span class="truncate font-mono">{file.path}</span>
              <span class="shrink-0 tabular-nums text-green-700 dark:text-green-300">+{file.added}</span>
              <span class="shrink-0 tabular-nums text-red-700 dark:text-red-300">−{file.removed}</span>
            </h3>
            <Show when={!file.replaced} fallback={<p class="text-xs text-dimmed">{props.replaced}</p>}>
              <div class="overflow-x-auto rounded-md font-mono text-xs leading-5">
                <For each={file.rows}>
                  {(row) =>
                    row.kind === "gap" ? (
                      <div class="px-2 py-0.5 text-dimmed">{props.unchanged(row.count)}</div>
                    ) : (
                      <div
                        class={`grid grid-cols-[1.5rem_minmax(0,1fr)] ${
                          row.kind === "added"
                            ? "bg-green-50 text-green-800 dark:bg-green-950/40 dark:text-green-300"
                            : row.kind === "removed"
                              ? "bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-300"
                              : "text-secondary"
                        }`}
                      >
                        <span class="select-none text-center text-dimmed" aria-hidden="true">
                          {row.kind === "added" ? "+" : row.kind === "removed" ? "−" : " "}
                        </span>
                        <span class="whitespace-pre-wrap break-words pr-2">{row.value || " "}</span>
                      </div>
                    )
                  }
                </For>
              </div>
            </Show>
          </section>
        )}
      </For>
    </div>
  );
}
