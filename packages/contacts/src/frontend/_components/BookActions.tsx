import { mutation as mutations } from "@k2b/stdlib/solid";
import { Button, ButtonLink, CheckboxCard, prompts, useLocale } from "@k2b/ui";
import { createSignal, For, onCleanup, Show } from "solid-js";
import { apiClient } from "@/api/client";
import type { CreateContactInput } from "../../service";
import { resolveContactName } from "../../shared";
import { readErrorMessage } from "./api";
import { bookMessages } from "./book-messages";

type Props = {
  bookId: string;
  /** Show the Import button. Read-only users see only Export. */
  canWrite: boolean;
  onImported?: () => void;
};

type ImportCandidate = {
  candidate: CreateContactInput;
  match: { existingId: string; existingName: string } | null;
};

const MAX_IMPORT_FILE_BYTES = 10_000_000;

/** Inline preview + commit for a vCard import. Lives inside a prompts.dialog. */
function ImportDialog(props: { bookId: string; close: (created: number) => void }) {
  const locale = useLocale();
  const t = () => bookMessages.resolve([locale()]).t;
  const [stage, setStage] = createSignal<"upload" | "preview" | "committing">("upload");
  const [filename, setFilename] = createSignal<string>("");
  const [candidates, setCandidates] = createSignal<ImportCandidate[]>([]);
  const [selected, setSelected] = createSignal<Set<number>>(new Set());
  let fileReader: FileReader | undefined;
  let disposed = false;

  const previewMutation = mutations.create<ImportCandidate[], { bookId: string; content: string }>({
    mutation: async ({ bookId, content }, { abortSignal }) => {
      const res = await apiClient.books[":bookId"].import.preview.$post(
        {
          param: { bookId },
          json: { format: "vcard", content },
        },
        { init: { signal: abortSignal } },
      );
      if (!res.ok) throw new Error(await readErrorMessage(res, t().parseVcardFailed));
      const data = await res.json();
      return data.candidates;
    },
    onSuccess: (parsed) => {
      setCandidates(parsed);
      // Default selection: every candidate that does NOT already match a known
      // contact. The user can flip the checkbox to import duplicates anyway.
      setSelected(new Set<number>(parsed.flatMap((c, i) => (c.match ? [] : [i]))));
      setStage("preview");
    },
    onError: (error) => prompts.error(error.message),
  });

  const commitMutation = mutations.create<{ created: number; failures: string[] }, { bookId: string; contacts: CreateContactInput[] }>({
    mutation: async ({ bookId, contacts }, { abortSignal }) => {
      const res = await apiClient.books[":bookId"].import.commit.$post(
        {
          param: { bookId },
          json: { contacts },
        },
        { init: { signal: abortSignal } },
      );
      if (!res.ok) throw new Error(await readErrorMessage(res, t().importContactsFailed));
      return await res.json();
    },
    onSuccess: (result) => {
      if (result.failures.length > 0) {
        prompts.error(t().importPartialFailure({ created: result.created, failed: result.failures.length, first: result.failures[0] ?? "" }));
      }
      props.close(result.created);
    },
    onError: (error) => {
      prompts.error(error.message);
      setStage("preview");
    },
  });

  onCleanup(() => {
    disposed = true;
    fileReader?.abort();
    previewMutation.abort();
    commitMutation.abort();
  });

  const handleFileChange = (event: Event) => {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > MAX_IMPORT_FILE_BYTES) {
      prompts.error(t().vcardTooLarge);
      input.value = "";
      return;
    }
    setFilename(file.name);
    const bookId = props.bookId;
    fileReader?.abort();
    const reader = new FileReader();
    fileReader = reader;
    reader.onload = () => {
      if (disposed) return;
      const content = String(reader.result ?? "");
      previewMutation.mutate({ bookId, content });
    };
    reader.readAsText(file);
  };

  const toggleIndex = (index: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const selectAll = () => setSelected(new Set<number>(candidates().map((_, i) => i)));
  const selectNone = () => setSelected(new Set<number>());

  const submit = () => {
    const chosen = candidates().filter((_, i) => selected().has(i));
    if (chosen.length === 0) {
      prompts.error(t().pickAtLeastOne);
      return;
    }
    setStage("committing");
    commitMutation.mutate({ bookId: props.bookId, contacts: chosen.map((item) => item.candidate) });
  };

  return (
    <div class="flex flex-col gap-3">
      <Show when={stage() === "upload"}>
        <p class="text-xs text-dimmed">{t().uploadHint}</p>
        <label class="paper flex cursor-pointer flex-col items-center gap-2 px-6 py-8 text-sm text-dimmed transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
          <i class="ti ti-upload text-2xl" />
          <span>{previewMutation.loading() ? t().reading : t().chooseVcfFile}</span>
          <input type="file" accept=".vcf,text/vcard" class="hidden" onChange={handleFileChange} />
        </label>
      </Show>

      <Show when={stage() === "preview"}>
        <div class="flex items-center justify-between gap-2">
          <span class="text-xs text-dimmed">{t().previewSummary({ filename: filename(), count: candidates().length })}</span>
          <div class="flex items-center gap-1">
            <Button variant="ghost" size="xs" class="text-xs text-dimmed hover:text-primary" onClick={selectAll}>
              {t().selectAll}
            </Button>
            <Button variant="ghost" size="xs" class="text-xs text-dimmed hover:text-primary" onClick={selectNone}>
              {t().selectNone}
            </Button>
          </div>
        </div>
        <ul class="flex max-h-96 flex-col gap-1 overflow-y-auto">
          <For each={candidates()}>
            {(item, index) => (
              <li>
                <CheckboxCard
                  label={resolveContactName(item.candidate as Parameters<typeof resolveContactName>[0], t().unnamedContact)}
                  description={
                    [
                      item.candidate.companyName,
                      item.candidate.emails?.[0]?.email,
                      item.candidate.phones?.[0]?.phone,
                      item.match ? t().existsAs({ name: item.match.existingName }) : null,
                    ]
                      .filter(Boolean)
                      .join(" · ") || t().newContact
                  }
                  icon={item.match ? "ti ti-alert-circle" : "ti ti-user-plus"}
                  value={() => selected().has(index())}
                  onValueChange={() => toggleIndex(index())}
                />
              </li>
            )}
          </For>
        </ul>
        <div class="flex items-center justify-end gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setStage("upload");
              setCandidates([]);
              setSelected(new Set<number>());
            }}
          >
            {t().back}
          </Button>
          <Button size="sm" onClick={submit} disabled={selected().size === 0} loading={commitMutation.loading()}>
            <i class="ti ti-check" />
            {t().importCount({ count: selected().size })}
          </Button>
        </div>
      </Show>

      <Show when={stage() === "committing"}>
        <div class="flex items-center justify-center gap-2 py-8 text-sm text-dimmed">
          <i class="ti ti-loader-2 animate-spin" /> {t().importing}
        </div>
      </Show>
    </div>
  );
}

export default function BookActions(props: Props) {
  const locale = useLocale();
  const t = () => bookMessages.resolve([locale()]).t;
  const openImport = async () => {
    const created = await prompts.dialog<number>((close) => <ImportDialog bookId={props.bookId} close={close} />, {
      title: t().importContactsTitle,
      icon: "ti ti-upload",
      size: "large",
    });
    if (created && created > 0) {
      props.onImported?.();
    }
  };

  return (
    <div class="flex flex-wrap items-center gap-2">
      <Show when={props.canWrite}>
        <Button variant="secondary" size="sm" onClick={openImport} title={t().importTooltip}>
          <i class="ti ti-upload" /> {t().importVcard}
        </Button>
      </Show>
      <ButtonLink href={`/api/contacts/books/${props.bookId}/export.vcf`} variant="secondary" size="sm" title={t().exportAsVcard}>
        <i class="ti ti-address-book" /> {t().exportVcard}
      </ButtonLink>
      <ButtonLink href={`/api/contacts/books/${props.bookId}/export.csv`} variant="secondary" size="sm" title={t().exportAsCsv}>
        <i class="ti ti-file-type-csv" /> {t().exportCsv}
      </ButtonLink>
    </div>
  );
}
