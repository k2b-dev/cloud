import { expect, test } from "bun:test";
import { publicUploadClientBucket } from "./public-upload-rate-limit";

test.each([
  ["192.0.2.1", "ip:192.0.2.1"],
  ["2001:db8:1:2::1", "ip6:2001:db8:1:2::/64"],
  ["2001:0DB8:0001:0002:0000:0000:0000:0001", "ip6:2001:db8:1:2::/64"],
  ["2001:db8:1:2:ffff::9", "ip6:2001:db8:1:2::/64"],
  ["2001:db8:1:3::1", "ip6:2001:db8:1:3::/64"],
  ["2001:db8::1", "ip6:2001:db8:0:0::/64"],
  ["::", "ip6:0:0:0:0::/64"],
  ["::1", "ip6:0:0:0:0::/64"],
  ["fe80::1%eth0", "ip6:fe80:0:0:0::/64"],
  ["2001:db8:1:2::192.0.2.1", "ip6:2001:db8:1:2::/64"],
  ["::ffff:192.0.2.1", "ip:192.0.2.1"],
  ["::ffff:c000:201", "ip:192.0.2.1"],
  ["0000:0000:0000:0000:0000:FFFF:C000:0201", "ip:192.0.2.1"],
  ["::ffff:0:192.0.2.1", "ip6:0:0:0:0::/64"],
  ["unknown", "ip:unknown"],
  ["garbage", "ip:garbage"],
  ["2001:db8:::1", "ip:2001:db8:::1"],
  ["", "ip:"],
])("client address %s uses bucket %s", (ip, bucket) => {
  expect(publicUploadClientBucket(ip)).toBe(bucket);
});
