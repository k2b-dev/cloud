import { Disclosure, TextInput, useLocale } from "@k2b/ui";
import { createSignal } from "solid-js";
import { apiClient } from "../../api/client";
import type { VenueTemplateSummary } from "../../contracts";
import { venueMessages } from "../../messages";
import { slugFromName, venueSlugError } from "../venue-slug";
import { DialogFrame } from "./venue-workspace/schedule";
import { readError } from "./venue-workspace/utils";

/** The browser's time zone for a new venue, so its times fit where it is set up; the server knows the default. */
const browserTimeZone = (): string | undefined => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
};

/**
 * Creates a blank venue or one from a template. It asks only for the name; the slug follows the name until
 * someone edits it under Advanced. A slug the server rejects shows at the field, and every input stays.
 */
export function CreateVenueDialog(props: {
  template?: VenueTemplateSummary;
  close: (venueId: string | null) => void;
  guardDismiss?: (handler: () => void) => void;
}) {
  const locale = useLocale();
  const t = () => venueMessages.resolve([locale()]).t;
  const [name, setName] = createSignal("");
  const [ownSlug, setOwnSlug] = createSignal<string | null>(null);
  const [advanced, setAdvanced] = createSignal(false);
  const [attempted, setAttempted] = createSignal(false);
  /** What the server said about a slug, kept while that slug is in the field. */
  const [slugProblem, setSlugProblem] = createSignal<{ slug: string; message: string } | null>(null);
  const [pending, setPending] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const slug = () => ownSlug() ?? slugFromName(name().trim() || props.template?.name || "");
  const nameError = () => (attempted() && !props.template && !name().trim() ? t().nameRequired : undefined);
  const slugError = () => {
    if (!attempted() && ownSlug() === null) return undefined;
    const problem = slugProblem();
    return venueSlugError(slug(), t()) ?? (problem?.slug === slug() ? problem.message : undefined);
  };
  props.guardDismiss?.(() => {
    if (!pending()) props.close(null);
  });

  const submit = async () => {
    setAttempted(true);
    if (nameError()) return;
    if (slugError()) {
      setAdvanced(true);
      return;
    }
    setPending(true);
    setError(null);
    try {
      const response = props.template
        ? await apiClient.templates[":templateId"].$post({
            param: { templateId: props.template.id },
            json: { name: name().trim() || undefined, slug: slug() },
          })
        : await apiClient.venues.$post({ json: { name: name().trim(), slug: slug(), timezone: browserTimeZone() } });
      if (response.ok) {
        props.close((await response.json()).id);
        return;
      }
      const message = await readError(response, props.template ? t().createFromTemplateFailed : t().createVenueFailed);
      // The server names the field: a taken slug answers 409, a malformed one 400 with `slug: …`.
      if (response.status === 409) setSlugProblem({ slug: slug(), message: t().slugTaken });
      else if (message.startsWith("slug:")) setSlugProblem({ slug: slug(), message: t().slugInvalid });
      else {
        setError(message);
        return;
      }
      setAdvanced(true);
    } catch {
      setError(props.template ? t().createFromTemplateFailed : t().createVenueFailed);
    } finally {
      setPending(false);
    }
  };

  return (
    <DialogFrame
      title={props.template ? props.template.name : t().createVenue}
      subtitle={props.template?.description}
      icon={props.template?.icon ?? "ti ti-building-carousel"}
      submitLabel={t().create}
      onCancel={() => props.close(null)}
      onSubmit={() => void submit()}
      pending={pending()}
      error={error()}
    >
      <TextInput
        label={t().name}
        description={props.template ? t().templateNameDescription : undefined}
        value={name}
        onValueChange={setName}
        placeholder={props.template?.name ?? t().venueNamePlaceholder}
        error={nameError}
        required={!props.template}
        data-create-venue-name=""
      />
      <Disclosure surface="plain" icon="ti ti-adjustments" summary={t().advanced} value={advanced} onValueChange={setAdvanced}>
        <TextInput
          label={t().slug}
          description={t().slugDescription}
          value={slug}
          onValueChange={(value) => setOwnSlug(value.trim().toLowerCase())}
          error={slugError}
          data-create-venue-slug=""
        />
      </Disclosure>
    </DialogFrame>
  );
}
