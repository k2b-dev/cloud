import {
  Avatar,
  DateTimePicker,
  DescriptionList,
  DetailPanel,
  Discussion,
  FileGrid,
  FileTypeIcon,
  fileKindLabel,
  IconButton,
  MultiSelectInput,
  SegmentedControl,
  StatusBadge,
} from "@k2b/ui";
import { createSignal, For } from "solid-js";
import { DemoCard } from "../DemoCard";

// Fictional data only.
type DemoFile = { id: string; name: string; size: string; hue?: number; note?: string };
const preview = (hue: number) =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 55% 78%)"/><stop offset="1" stop-color="hsl(${(hue + 50) % 360} 50% 58%)"/></linearGradient></defs><rect width="40" height="30" fill="url(#g)"/></svg>`,
  )}`;
const few: DemoFile[] = [
  { id: "costing", name: "Costing-print.xlsx", size: "64 KB" },
  { id: "brochure-v3", name: "Brochure-v3.pdf", size: "4.2 MB", note: "in 2 messages" },
  { id: "page-4", name: "Page-4-new.jpg", size: "1.8 MB", hue: 28 },
  { id: "page-7", name: "Page-7-new.jpg", size: "2.0 MB", hue: 200 },
];
const many: DemoFile[] = [
  { id: "brochure-v2", name: "Brochure-v2.pdf", size: "3.9 MB" },
  { id: "costing", name: "Costing-print.xlsx", size: "64 KB", note: "from Lena Hoffmann" },
  { id: "profile", name: "Colour-profile.icc", size: "12 KB" },
  { id: "brochure-v3", name: "Brochure-v3.pdf", size: "4.2 MB", note: "in 2 messages" },
  { id: "print-data", name: "Print-data.zip", size: "48 MB", note: "in 2 messages" },
  { id: "costing-2", name: "Costing-print.xlsx", size: "64 KB", note: "from Northern Light Print" },
  ...Array.from({ length: 11 }, (_, index) => ({
    id: `photo-${index}`,
    name: index < 2 ? `Page-${index ? 7 : 4}-new.jpg` : `Setup-${String(index - 1).padStart(2, "0")}.jpg`,
    size: "2.4 MB",
    hue: (90 + index * 23) % 360,
  })),
];
const isImage = (file: DemoFile) => file.hue !== undefined;

export const DetailPanelOutlineDemo = () => {
  const [amount, setAmount] = createSignal("few");
  const [tags, setTags] = createSignal(["print", "customer"]);
  const [assignees, setAssignees] = createSignal(["lena"]);
  const [reminder, setReminder] = createSignal<string | null>("2026-10-29T09:00");
  const files = () => (amount() === "many" ? many : few);
  return (
    <DemoCard
      id="detail-panel-outline"
      chip={[
        { kind: "component", name: "DetailPanel", from: "@k2b/ui" },
        { kind: "component", name: "FileGrid", from: "@k2b/ui" },
        { kind: "component", name: "DescriptionList", from: "@k2b/ui" },
      ]}
      description="One outline for every details panel: header, properties as quiet rows, linked items, the first five attachments, notes, then collapsed context that says what it holds."
      code={`<DetailPanel.Section title="Attachments" count={files.length}>
  <FileGrid
    rows={files}
    getRowId={(file) => file.id}
    label="Attachments"
    layout="list"
    limit={5}
    actionVisibility="progressive"
    renderPreview={(file) => (isImage(file) ? <img src={file.thumbnail} alt="" /> : <FileTypeIcon name={file.name} />)}
    renderLabel={(file) => file.name}
    renderMeta={(file) => \`\${fileKindLabel(file, locale())} · \${file.size}\`}
    renderActions={(file) => <DownloadButton file={file} />}
    groups={(rows) => [
      { id: "files", label: "Files", rows: rows.filter((file) => !isImage(file)) },
      { id: "images", label: "Images", rows: rows.filter(isImage), layout: "tiles" },
    ]}
    onOpen={openPreview}
  />
</DetailPanel.Section>

<DetailPanel.Group title="More about this conversation">
  <DetailPanel.Section title="Activity" count={4} collapsible summary="Lena Hoffmann assigned herself">…</DetailPanel.Section>
  <DetailPanel.Section title="Technical details" collapsible summary="Sender, headers, original">…</DetailPanel.Section>
</DetailPanel.Group>`}
    >
      <div class="flex flex-col gap-3">
        <SegmentedControl
          label="Attachments"
          value={amount()}
          onValueChange={setAmount}
          options={[
            { value: "few", label: "4 attachments" },
            { value: "many", label: "17 attachments" },
          ]}
        />
        <div style={{ width: "min(25rem, 100%)", height: "52rem", display: "flex" }}>
          <DetailPanel surface="plain">
            <DetailPanel.Header
              kind={
                <>
                  Conversation <StatusBadge tone="warning" label="Open" />
                </>
              }
              title="Brochure approval"
              subtitle="Northern Light Print · 3 messages · today, 09:15"
              actions={
                <IconButton variant="ghost" size="xs" label="Close details">
                  <i class="ti ti-x" aria-hidden="true" />
                </IconButton>
              }
            />
            <DetailPanel.Body>
              <DetailPanel.Section title="Properties">
                <DescriptionList
                  layout="rows"
                  size="sm"
                  items={[
                    {
                      term: "Assigned",
                      description: (
                        <MultiSelectInput
                          aria-label="Assigned"
                          appearance="plain"
                          placeholder="Nobody"
                          value={assignees}
                          onValueChange={setAssignees}
                          options={[
                            { id: "lena", label: "Lena Hoffmann", icon: "ti ti-user" },
                            { id: "jonas", label: "Jonas Weber", icon: "ti ti-user" },
                          ]}
                        />
                      ),
                    },
                    {
                      term: "Tags",
                      description: (
                        <MultiSelectInput
                          aria-label="Tags"
                          appearance="plain"
                          placeholder="None"
                          value={tags}
                          onValueChange={setTags}
                          options={[
                            { id: "print", label: "Print", color: "#a16207" },
                            { id: "customer", label: "Customer", color: "#1d4ed8" },
                          ]}
                        />
                      ),
                    },
                    {
                      term: "Reminder",
                      description: (
                        <DateTimePicker
                          aria-label="Reminder"
                          appearance="plain"
                          placeholder="Not set"
                          clearable
                          value={reminder}
                          onValueChange={setReminder}
                        />
                      ),
                    },
                  ]}
                />
              </DetailPanel.Section>
              <DetailPanel.Section title="Linked" count={2}>
                <DetailPanel.Action
                  href="#detail-panel-outline"
                  leading={<i class="ti ti-layout-kanban" aria-hidden="true" />}
                  title="Approve brochure"
                  description="Spaces · Spring fair · In progress"
                />
                <DetailPanel.Action
                  href="#detail-panel-outline"
                  leading={<i class="ti ti-mail" aria-hidden="true" />}
                  title="Offer brochure 2026"
                  description="Mail · 14 Oct"
                />
              </DetailPanel.Section>
              <DetailPanel.Section title="Attachments" count={files().length}>
                <FileGrid
                  rows={files()}
                  getRowId={(file) => file.id}
                  label="Attachments"
                  layout="list"
                  limit={5}
                  actionVisibility="progressive"
                  moreMeta={amount() === "many" ? "4 duplicates merged" : undefined}
                  toolbar={`${files().length} files from 21 attachments`}
                  renderPreview={(file) =>
                    file.hue === undefined ? <FileTypeIcon name={file.name} /> : <img src={preview(file.hue)} alt="" />
                  }
                  renderLabel={(file) => file.name}
                  renderMeta={(file) => [fileKindLabel(file, "en"), file.size, file.note].filter(Boolean).join(" · ")}
                  renderActions={(file) => (
                    <>
                      <IconButton variant="ghost" size="sm" label={`Download ${file.name}`}>
                        <i class="ti ti-download" aria-hidden="true" />
                      </IconButton>
                      <IconButton variant="ghost" size="sm" label={`Save ${file.name} to Files`}>
                        <i class="ti ti-folder-down" aria-hidden="true" />
                      </IconButton>
                    </>
                  )}
                  groups={(rows) => [
                    { id: "files", label: "Files", rows: rows.filter((file) => !isImage(file)) },
                    { id: "images", label: "Images", rows: rows.filter(isImage), layout: "tiles" },
                  ]}
                  onOpen={() => {}}
                />
              </DetailPanel.Section>
              <Discussion label="Team notes" count={2}>
                <Discussion.List>
                  <For
                    each={[
                      ["Jonas Weber", "Page 7: image rights are cleared.", "2 h ago"],
                      ["Lena Hoffmann", "I will approve by noon.", "40 min ago"],
                    ]}
                  >
                    {([author, body, time]) => (
                      <Discussion.Item avatar={<Avatar name={author!} size="xs" />} author={author!} timestamp={time}>
                        {body}
                      </Discussion.Item>
                    )}
                  </For>
                </Discussion.List>
                <Discussion.Composer label="Note for the team" placeholder="Note for the team" submitLabel="Post" onSubmit={() => {}} />
              </Discussion>
              <DetailPanel.Group title="More about this conversation">
                <DetailPanel.Section title="People" count={2} collapsible summary="Kai Brandt · info@northern-light.example">
                  Kai Brandt, info@northern-light.example
                </DetailPanel.Section>
                <DetailPanel.Section title="Activity" count={4} collapsible summary="Lena Hoffmann assigned herself">
                  Assigned, tagged by a rule, received, replied
                </DetailPanel.Section>
                <DetailPanel.Section title="Technical details" collapsible summary="Sender, headers, original">
                  Message-ID, headers, original
                </DetailPanel.Section>
              </DetailPanel.Group>
            </DetailPanel.Body>
          </DetailPanel>
        </div>
      </div>
    </DemoCard>
  );
};
