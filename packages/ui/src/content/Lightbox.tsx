import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { useUiMessages } from "../intl/messages";

export type LightboxImage = {
  src: string;
  alt?: string;
  downloadUrl?: string;
};

type LightboxProps = {
  images: LightboxImage[];
  initialIndex?: number;
  onClose: () => void;
};

/**
 * Minimal, accessible lightbox using native <dialog>.
 * Supports keyboard navigation, touch swipe gestures, and screen readers.
 */
export default function Lightbox(props: LightboxProps) {
  const messages = useUiMessages();
  const clampIndex = (value: number, images = props.images): number =>
    images.length === 0 ? 0 : Math.max(0, Math.min(value, images.length - 1));
  const [index, setIndex] = createSignal(clampIndex(props.initialIndex ?? 0));
  let dialogRef!: HTMLDialogElement;

  createEffect(
    (previous: { images: LightboxImage[]; initialIndex: number | undefined }) => {
      const images = props.images;
      const initialIndex = props.initialIndex;
      setIndex((currentIndex) => {
        if (initialIndex !== previous.initialIndex) return clampIndex(initialIndex ?? 0, images);
        const previousImage = previous.images[currentIndex];
        const retained = previousImage ? images.findIndex((image) => image === previousImage || image.src === previousImage.src) : -1;
        return retained >= 0 ? retained : clampIndex(currentIndex, images);
      });
      return { images, initialIndex };
    },
    { images: props.images, initialIndex: props.initialIndex },
  );

  // Touch gesture tracking
  let touchStartX = 0;
  let touchStartY = 0;
  const SWIPE_THRESHOLD = 50;

  const current = () => props.images[index()];
  const isMultiple = () => props.images.length > 1;
  const prev = () => {
    if (!isMultiple()) return;
    setIndex((i) => (i - 1 + props.images.length) % props.images.length);
  };
  const next = () => {
    if (!isMultiple()) return;
    setIndex((i) => (i + 1) % props.images.length);
  };

  const close = () => {
    dialogRef.close();
    props.onClose();
  };

  // Keyboard navigation
  const handleKeyDown = (e: KeyboardEvent) => {
    switch (e.key) {
      case "Escape":
        close();
        break;
      case "ArrowLeft":
        prev();
        break;
      case "ArrowRight":
        next();
        break;
    }
  };

  // Touch handlers for swipe gestures
  const handleTouchStart = (e: TouchEvent) => {
    const touch = e.touches[0];
    if (touch) {
      touchStartX = touch.clientX;
      touchStartY = touch.clientY;
    }
  };

  const handleTouchEnd = (e: TouchEvent) => {
    const touch = e.changedTouches[0];
    if (!touch) return;

    const deltaX = touch.clientX - touchStartX;
    const deltaY = touch.clientY - touchStartY;

    // Only trigger swipe if horizontal movement is dominant
    if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > SWIPE_THRESHOLD) {
      if (deltaX > 0) {
        prev();
      } else {
        next();
      }
    }
  };

  // Click on backdrop closes lightbox
  const handleBackdropClick = (e: MouseEvent) => {
    if (e.target === dialogRef) {
      close();
    }
  };

  // Registration and teardown both live in onMount: onCleanup also runs when an
  // SSR render is disposed, where `document` does not exist.
  onMount(() => {
    dialogRef.showModal();
    document.addEventListener("keydown", handleKeyDown);
    onCleanup(() => document.removeEventListener("keydown", handleKeyDown));
  });

  return (
    <dialog
      ref={dialogRef}
      class="k2b-content-lightbox"
      onMouseDown={handleBackdropClick}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      aria-label={messages().imageLightbox}
    >
      {/* Top bar */}
      <div class="k2b-content-lightbox__bar">
        <div class="k2b-content-lightbox__meta">
          <Show when={isMultiple()}>
            <span class="k2b-content-lightbox__counter" aria-live="polite">
              {index() + 1} / {props.images.length}
            </span>
          </Show>
          <Show when={current()?.alt}>
            <div class="k2b-content-lightbox__caption">
              <div class="k2b-content-lightbox__caption-text">{current()?.alt}</div>
            </div>
          </Show>
        </div>

        <div class="k2b-content-lightbox__actions">
          <Show when={current()?.downloadUrl}>
            <a href={current()!.downloadUrl} download="" class="k2b-content-lightbox__button" aria-label={messages().downloadImage}>
              <i class="ti ti-download" aria-hidden="true" />
              <span class="k2b-content-lightbox__button-label">{messages().download}</span>
            </a>
          </Show>
          <button type="button" onClick={close} class="k2b-content-lightbox__button" aria-label={messages().closeLightbox}>
            <i class="ti ti-x" aria-hidden="true" />
            <span class="k2b-content-lightbox__button-label">{messages().close}</span>
          </button>
        </div>
      </div>

      <div class="k2b-content-lightbox__stage">
        <Show when={current()}>
          {(image) => <img src={image().src} alt={image().alt ?? ""} class="k2b-content-lightbox__image" draggable={false} />}
        </Show>
      </div>

      <Show when={isMultiple()}>
        <button
          type="button"
          onClick={prev}
          class="k2b-content-lightbox__nav"
          data-direction="previous"
          aria-label={messages().previousImage}
        >
          <i class="ti ti-chevron-left" aria-hidden="true" />
        </button>
        <button type="button" onClick={next} class="k2b-content-lightbox__nav" data-direction="next" aria-label={messages().nextImage}>
          <i class="ti ti-chevron-right" aria-hidden="true" />
        </button>
      </Show>

      <Show when={isMultiple() && props.images.length <= 10}>
        <div class="k2b-content-lightbox__dots" role="group" aria-label={messages().imageNavigation}>
          <For each={props.images}>
            {(_, i) => (
              <button
                type="button"
                onClick={() => setIndex(i())}
                class="k2b-content-lightbox__dot"
                aria-current={index() === i() ? "true" : undefined}
                aria-label={messages().goToImage({ index: i() + 1 })}
              />
            )}
          </For>
        </div>
      </Show>
    </dialog>
  );
}
