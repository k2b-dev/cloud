/**
 * Old browsers may never settle a dismissed native file dialog, so returning focus releases the save hold.
 * An in-page chooser settles on close; focus while it is open must keep the hold and keep listening.
 */
export const releaseWhenPageReturns = (
  choosing: Promise<unknown>,
  release: () => void,
  { target, dialogOpen }: { target: EventTarget; dialogOpen: () => boolean },
): void => {
  let released = false;
  const finish = () => {
    if (released) return;
    released = true;
    target.removeEventListener("focus", onFocus);
    release();
  };
  const onFocus = () => {
    if (!dialogOpen()) finish();
  };
  target.addEventListener("focus", onFocus);
  void choosing.then(finish, finish);
};
