/**
 * The flag of a conversation: a star, filled when flagged and open when not, in neutral ink (K8: orange means a draft).
 * The icon font ships outlines only, so the star is drawn here; `data-filled` fills it.
 */
export default function MailStar(props: { filled?: boolean }) {
  return (
    <svg class="mail-star" data-filled={props.filled ? "" : undefined} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 17.75l-6.172 3.245l1.179 -6.873l-5 -4.867l6.9 -1l3.086 -6.253l3.086 6.253l6.9 1l-5 4.867l1.179 6.873z" />
    </svg>
  );
}
