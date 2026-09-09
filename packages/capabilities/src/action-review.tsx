import type { CapabilityClientError, CapabilityReviewClientResult } from "@k2b/cloud/capabilities";
import type { CapabilityActionManifest, CapabilityActionReview, CapabilitySemanticLink } from "@k2b/cloud/contracts";
import { For, type JSX, Show } from "solid-js";
import { useLocale } from "@k2b/ui";
import { capabilityRuntimeMessages } from "./messages";
import { capabilityUiMessages } from "./frontend/messages";

export type ActionRunDecision = { kind: "approved" } | { kind: "cancelled" } | { kind: "failed"; error: CapabilityClientError };

type ConfirmActionRunInput = {
  appId: string;
  operation: CapabilityActionManifest;
  input: Record<string, unknown>;
  signal?: AbortSignal;
};

type ConfirmActionRunDependencies = {
  review: (input: {
    appId: string;
    capabilityId: string;
    input: Record<string, unknown>;
    signal?: AbortSignal;
  }) => Promise<CapabilityReviewClientResult>;
  confirmReview: (review: CapabilityActionReview, operation: CapabilityActionManifest) => Promise<boolean | undefined>;
  confirmDestructive: (operation: CapabilityActionManifest) => Promise<boolean | undefined>;
};

export const confirmActionRun = async (
  input: ConfirmActionRunInput,
  dependencies: ConfirmActionRunDependencies,
  locale = "en",
): Promise<ActionRunDecision> => {
  const t = capabilityRuntimeMessages.resolve([locale]).t;
  if (input.operation.review) {
    let reviewed: CapabilityReviewClientResult;
    try {
      reviewed = await dependencies.review({
        appId: input.appId,
        capabilityId: input.operation.localId,
        input: input.input,
        signal: input.signal,
      });
    } catch (cause) {
      return {
        kind: "failed",
        error:
          cause instanceof Error && cause.name === "AbortError"
            ? { code: "REQUEST_CANCELLED", message: t.reviewCancelled, status: 499 }
            : { code: "APP_UNAVAILABLE", message: t.reviewUnavailable, status: 503 },
      };
    }
    if (!reviewed.ok) return { kind: "failed", error: reviewed.error };
    return (await dependencies.confirmReview(reviewed.data, input.operation)) ? { kind: "approved" } : { kind: "cancelled" };
  }

  if (input.operation.destructive) {
    return (await dependencies.confirmDestructive(input.operation)) ? { kind: "approved" } : { kind: "cancelled" };
  }

  return { kind: "approved" };
};

const linkLabel = (link: CapabilitySemanticLink, locale: string): string => {
  const t = capabilityUiMessages.resolve([locale]).t;
  return (
  link.title ??
  (link.rel === "edit"
    ? t.edit
    : link.rel === "status"
      ? t.status
      : link.rel === "preview"
        ? t.preview
        : link.rel === "download"
          ? t.download
          : t.open)
  );
};

export function ActionReviewContent(props: { review: CapabilityActionReview }): JSX.Element {
  const locale = useLocale();
  return (
    <div class="flex flex-col gap-4">
      <p class="m-0 whitespace-pre-wrap">{props.review.message}</p>
      <Show when={props.review.details?.length}>
        <dl class="m-0 grid gap-2">
          <For each={props.review.details}>
            {(detail) => (
              <div>
                <dt class="text-xs font-medium text-dimmed">{detail.label}</dt>
                <dd class="m-0 whitespace-pre-wrap text-sm text-primary">{detail.value}</dd>
              </div>
            )}
          </For>
        </dl>
      </Show>
      <Show when={props.review.links?.length}>
        <div class="flex flex-wrap gap-2">
          <For each={props.review.links}>
            {(link) => (
              <a class="text-sm font-medium text-accent hover:underline" href={link.href}>
                {linkLabel(link, locale())}
              </a>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
