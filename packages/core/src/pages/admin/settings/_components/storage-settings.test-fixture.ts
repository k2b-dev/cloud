import type { SettingFieldDef } from "./CoreSettingsForm.island";

const rows: [string, string, SettingFieldDef["kind"], string | number][] = [
  ["storage.endpoint", "Garage S3 endpoint", "url", "https://s3.example.test"],
  ["storage.region", "Signing region", "string", "garage"],
  ["storage.bucket", "Bucket", "string", "cloud-objects"],
  ["storage.access_key_id", "Access key ID", "secret", ""],
  ["storage.secret_access_key", "Secret access key", "secret", ""],
  ["storage.max_object_bytes", "Maximum object size (bytes)", "number", 33554432],
];
export const storageEntries: SettingFieldDef[] = rows.map(([key, label, kind, value]) => ({
  key,
  label,
  kind,
  value,
  description: "",
  default: value,
  resetValue: value,
  valueSource: "custom",
  resetValueSource: "default",
  isCustom: true,
  unreadable: false,
  group: "storage",
}));
