export function richProps() {
  const shared = { label: "shared" };
  return {
    at: new Date("2026-10-01T12:34:56Z"),
    map: new Map([["k", shared]]),
    set: new Set(["a", "b"]),
    shared,
    missing: undefined,
    text: '</script>"&',
  };
}
