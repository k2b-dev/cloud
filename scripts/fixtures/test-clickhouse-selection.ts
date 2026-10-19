/** Cleanup is permitted only inside a process-owned ClickHouse namespace. */
export const assertClickhouseTestPrefix = (prefix: string): void => {
  if (!/^pulsetest_[0-9a-f]{8}_$/.test(prefix)) throw new Error("Refusing ClickHouse cleanup: invalid test prefix");
};
export const selectClickhouseTestNames = (prefix: string, names: readonly string[]): string[] => {
  assertClickhouseTestPrefix(prefix);
  return names.filter((name) => name.startsWith(prefix));
};
