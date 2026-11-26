/**
 * Runs a deed of a `Menu` entry after the menu has closed.
 *
 * k2b-ui gap: `confirm` asked from inside a `Menu` entry's `onClick` does not open its alert dialog (from a `Button` it
 * does); until the primitive handles it, the question waits one frame for the menu to close.
 */
export const afterMenu = (deed: () => unknown) => (): void => {
  requestAnimationFrame(() => void deed());
};
