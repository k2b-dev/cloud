import {
  DetailAccess,
  DetailLinks,
  DetailPanel,
  DetailPresence,
  DetailPresenceSlot,
  type DetailPresenceState,
  DetailProperties,
  DetailTags,
  SegmentedControl,
} from "@k2b/ui";
import { createSignal } from "solid-js";
import { DemoCard } from "../DemoCard";

// Fictional data only.
const people = [
  { id: "jana", name: "Jana Berger", shortName: "Jana", activity: "writing" as const, place: "Cold goods", onSelect: () => {} },
  { id: "paul", name: "Paul Wagner", shortName: "Paul", activity: "reading" as const },
  { id: "mira", name: "Mira Schulz", shortName: "Mira", activity: "writing" as const, place: "Counting", onSelect: () => {} },
  { id: "you", name: "Anna Becker", self: true },
];
const access = [
  { id: "team", name: "Warehouse team", kind: "group" as const, role: "Can edit" },
  { id: "jana", name: "Jana Berger", role: "Can manage" },
  { id: "you", name: "Anna Becker", role: "Can manage", self: true },
  { id: "paul", name: "Paul Wagner", role: "Can view" },
  { id: "bot", name: "Warehouse bot", kind: "service" as const, detail: "Service", role: "Can edit" },
  { id: "all", name: "Everyone signed in", kind: "everyone" as const, role: "Can view" },
];

export const DetailSectionsDemo = () => {
  const [state, setState] = createSignal<DetailPresenceState>("live");
  return (
    <DemoCard
      id="detail-panel-shared-sections"
      chip={[
        { kind: "component", name: "DetailPresence", from: "@k2b/ui" },
        { kind: "component", name: "DetailPresenceSlot", from: "@k2b/ui" },
        { kind: "component", name: "DetailTags", from: "@k2b/ui" },
        { kind: "component", name: "DetailLinks", from: "@k2b/ui" },
        { kind: "component", name: "DetailAccess", from: "@k2b/ui" },
        { kind: "component", name: "DetailProperties", from: "@k2b/ui" },
      ]}
      description="Shared sections in the order of use: who is here, tags, links, then access and properties under More about. Every section's content starts on its title's text edge, and Here now keeps its two lines in every state."
      code={`<DetailPresence people={people} state={state} note="Whoever opens the note appears here." onRetry={retry} />
<DetailTags tags={[{ id: "ramp", label: "ramp", href: "/tags/ramp" }]} />
<DetailLinks incoming={linkedFrom} outgoing={linksTo} />
<DetailPanel.Group title="More about this note">
  <DetailAccess entries={access} note="Applies to the whole notebook." />
  <DetailProperties items={facts} summary="412 words · created 3 days ago" />
</DetailPanel.Group>`}
    >
      <div class="flex flex-col gap-3">
        <SegmentedControl
          label="Presence state"
          value={state()}
          onValueChange={(value) => setState(value as DetailPresenceState)}
          options={[
            { value: "live", label: "Live" },
            { value: "loading", label: "Loading" },
            { value: "offline", label: "Offline" },
            { value: "unavailable", label: "Unavailable" },
          ]}
        />
        <div style={{ width: "min(25rem, 100%)", display: "flex" }}>
          <DetailPanel surface="plain">
            <DetailPanel.Body scrollFade={false}>
              <DetailPresence
                people={people}
                state={state()}
                note={state() === "offline" ? "Offline · as of 19:24, may have changed" : "Your changes are still being saved."}
                onRetry={() => setState("live")}
              />
              <DetailPanel.Section title="Contents" icon="ti ti-list-tree" count={2}>
                <DetailPanel.Action
                  href="#detail-panel-shared-sections"
                  title="Cold goods"
                  trailing={<DetailPresenceSlot people={[people[0]!]} />}
                />
                <DetailPanel.Action
                  href="#detail-panel-shared-sections"
                  title="Counting"
                  trailing={<DetailPresenceSlot people={[people[2]!]} />}
                />
              </DetailPanel.Section>
              <DetailTags
                tags={["inbound", "cold-chain", "ramp"].map((tag) => ({ id: tag, label: tag, href: "#detail-panel-shared-sections" }))}
              />
              <DetailLinks
                incoming={[
                  { id: "onboarding", title: "Onboarding", href: "#detail-panel-shared-sections" },
                  { id: "returns", title: "Returns", href: "#detail-panel-shared-sections", trailing: "Shipping handbook" },
                ]}
                outgoing={[{ id: "glossary", title: "Glossary", href: "#detail-panel-shared-sections" }]}
              />
              <DetailPanel.Group title="More about this note">
                <DetailAccess entries={access} defaultOpen note="Applies to the whole notebook." />
                <DetailProperties
                  defaultOpen
                  summary="412 words · created 3 days ago"
                  items={[
                    { id: "created", label: "Created", value: "Jana Berger · 12 March 2026" },
                    { id: "length", label: "Length", value: "412 words · about 2 min to read" },
                    { id: "history", label: "History", value: "Open version history", href: "#detail-panel-shared-sections" },
                  ]}
                />
              </DetailPanel.Group>
            </DetailPanel.Body>
          </DetailPanel>
        </div>
      </div>
    </DemoCard>
  );
};
