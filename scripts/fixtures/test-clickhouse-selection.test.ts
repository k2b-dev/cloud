import { expect, test } from "bun:test";
import { selectClickhouseTestNames } from "./test-clickhouse-selection";

const prefix = "pulsetest_1234abcd_";
test("cleanup selects only names inside the validated process prefix, including the prefix itself", () => {
  expect(selectClickhouseTestNames(prefix, ["pulse_x", "pulsetest_other_x", "default", prefix, prefix + "x", "x" + prefix])).toEqual([
    prefix,
    prefix + "x",
  ]);
});
test("cleanup refuses broad, malformed and production prefixes", () => {
  for (const invalid of ["", "pulse_", "pulsetest_", "pulsetest_1234ABCd_", "pulsetest_1234abcd", "pulsetest_1234abcd_*"])
    expect(() => selectClickhouseTestNames(invalid, [invalid + "x"])).toThrow("Refusing ClickHouse cleanup");
});
