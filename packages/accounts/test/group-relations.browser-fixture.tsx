import type { GroupRelations } from "@k2b/cloud/contracts";
import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import RelationDetails from "../src/frontend/groups/relations/RelationDetails";
import RelationLevels from "../src/frontend/groups/relations/RelationLevels";
import RelationsControls from "../src/frontend/groups/relations/RelationsControls.island";
import RelationsTree from "../src/frontend/groups/relations/RelationsTree.island";
import { relationsMessages } from "../src/frontend/groups/relations/relations-messages";
import type { RelationsUrlState } from "../src/frontend/groups/relations/relations-view";

declare global {
  interface Window {
    relationsFixture: { view: "graph" | "list"; relations: GroupRelations };
  }
}

const root = document.getElementById("root");
if (!root) throw new Error("Fixture root missing");
const { view, relations } = window.relationsFixture;
const state: RelationsUrlState = { focus: relations.focus ?? undefined, depth: 2, view, managers: false, expand: [] };
const { t } = relationsMessages.resolve(["en"]);
render(
  () => (
    <LocaleProvider locale="en">
      {view === "list" ? (
        <RelationsTree relations={relations} state={state} />
      ) : (
        <div class="flex flex-col gap-2">
          <RelationsControls
            state={state}
            groupCount={relations.groupCount}
            cycleCount={relations.cycles.count}
            firstCycleGroup={relations.cycles.first}
            cyclesComplete={relations.cyclesComplete}
          />
          <div class="flex flex-col gap-3 md:flex-row">
            <div
              class="min-h-[24rem] min-w-0 flex-1 overflow-auto rounded-[var(--ui-radius-surface)] bg-[var(--ui-surface-muted)]"
              data-stage
            >
              <RelationLevels relations={relations} state={state} t={t} />
            </div>
            <aside class="w-full shrink-0 md:w-[17.5rem]">
              <RelationDetails relations={relations} t={t} pick={(id, name) => <a href={`#${id}`}>{name}</a>} />
            </aside>
          </div>
        </div>
      )}
    </LocaleProvider>
  ),
  root,
);
