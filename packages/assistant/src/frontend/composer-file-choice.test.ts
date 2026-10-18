import { expect, mock, test } from "bun:test";
import { releaseWhenPageReturns } from "./composer-file-choice";

test("focus keeps the hold while a page dialog is open, then releases once when none is open", async () => {
  const target = new EventTarget();
  const choosing = Promise.withResolvers<void>();
  const release = mock(() => {});
  let open = true;
  const dialogOpen = mock(() => open);
  releaseWhenPageReturns(choosing.promise, release, { target, dialogOpen });

  target.dispatchEvent(new Event("focus"));
  target.dispatchEvent(new Event("focus"));
  expect(release).not.toHaveBeenCalled();

  open = false;
  target.dispatchEvent(new Event("focus"));
  expect(release).toHaveBeenCalledTimes(1);
  expect(dialogOpen).toHaveBeenCalledTimes(3);

  target.dispatchEvent(new Event("focus"));
  choosing.resolve();
  await choosing.promise;
  target.dispatchEvent(new Event("focus"));
  expect(release).toHaveBeenCalledTimes(1);
  expect(dialogOpen).toHaveBeenCalledTimes(3);
});

for (const outcome of ["resolve", "reject"] as const) {
  test(`choice ${outcome} releases the hold and removes the focus listener even with a page dialog open`, async () => {
    const target = new EventTarget();
    const choosing = Promise.withResolvers<void>();
    const release = mock(() => {});
    const dialogOpen = mock(() => true);
    releaseWhenPageReturns(choosing.promise, release, { target, dialogOpen });

    if (outcome === "resolve") choosing.resolve();
    else choosing.reject(new Error("choice failed"));
    await choosing.promise.catch(() => {});
    expect(release).toHaveBeenCalledTimes(1);

    target.dispatchEvent(new Event("focus"));
    target.dispatchEvent(new Event("focus"));
    expect(release).toHaveBeenCalledTimes(1);
    expect(dialogOpen).not.toHaveBeenCalled();
  });
}
