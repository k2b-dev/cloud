export type TooltipPlacement = "top" | "bottom" | "left" | "right";

const VIEWPORT_PADDING = 8;
const TRIGGER_GAP = 6;

export const positionTooltipSurface = (tooltip: HTMLElement, target: HTMLElement, placement: TooltipPlacement = "top"): void => {
  const targetRect = target.getBoundingClientRect();
  if (placement === "left" || placement === "right") {
    const rect = tooltip.getBoundingClientRect();
    const right = targetRect.right + TRIGGER_GAP;
    const left = targetRect.left - rect.width - TRIGGER_GAP;
    const rightFits = right + rect.width <= window.innerWidth - VIEWPORT_PADDING;
    const leftFits = left >= VIEWPORT_PADDING;
    const useRight = placement === "right" ? rightFits || !leftFits : !leftFits && rightFits;
    const maxLeft = Math.max(VIEWPORT_PADDING, window.innerWidth - rect.width - VIEWPORT_PADDING);
    tooltip.style.left = `${Math.round(Math.max(VIEWPORT_PADDING, Math.min(useRight ? right : left, maxLeft)))}px`;
    const measured = tooltip.getBoundingClientRect();
    const maxTop = Math.max(VIEWPORT_PADDING, window.innerHeight - measured.height - VIEWPORT_PADDING);
    tooltip.style.top = `${Math.round(Math.max(VIEWPORT_PADDING, Math.min(targetRect.top + targetRect.height / 2 - measured.height / 2, maxTop)))}px`;
    tooltip.dataset.placement = useRight ? "right" : "left";
    return;
  }
  const initialTooltipRect = tooltip.getBoundingClientRect();
  const initialLeft = Math.max(
    VIEWPORT_PADDING,
    Math.min(
      targetRect.left + targetRect.width / 2 - initialTooltipRect.width / 2,
      window.innerWidth - initialTooltipRect.width - VIEWPORT_PADDING,
    ),
  );
  tooltip.style.left = `${Math.round(initialLeft)}px`;

  // Re-measure after fixing the available width so wrapped content stays
  // aligned with its target.
  const tooltipRect = tooltip.getBoundingClientRect();
  const topPosition = targetRect.top - tooltipRect.height - TRIGGER_GAP;
  const bottomPosition = targetRect.bottom + TRIGGER_GAP;
  const topFits = topPosition >= VIEWPORT_PADDING;
  const bottomFits = bottomPosition + tooltipRect.height <= window.innerHeight - VIEWPORT_PADDING;
  const useTop = placement === "top" ? topFits || !bottomFits : !bottomFits && topFits;
  const left = Math.max(
    VIEWPORT_PADDING,
    Math.min(targetRect.left + targetRect.width / 2 - tooltipRect.width / 2, window.innerWidth - tooltipRect.width - VIEWPORT_PADDING),
  );
  const desiredTop = useTop ? topPosition : bottomPosition;
  const maxTop = Math.max(VIEWPORT_PADDING, window.innerHeight - tooltipRect.height - VIEWPORT_PADDING);
  const top = Math.max(VIEWPORT_PADDING, Math.min(desiredTop, maxTop));

  tooltip.style.left = `${Math.round(left)}px`;
  tooltip.style.top = `${Math.round(top)}px`;
  tooltip.dataset.placement = useTop ? "top" : "bottom";
};
