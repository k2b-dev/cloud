// RFC 8032 Ed25519 test vectors. Public, deterministic test keys only.
export const APP_KEY_FIXTURES = [
  {
    seed: "nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A",
    publicKey: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo",
    fingerprint: "21fe31dfa154a261626bf854046fd227",
  },
  {
    seed: "TM0Imyj_ltqdtsNG7BFOD1uKMZ81q6Yk2oz27U-4pvs",
    publicKey: "PUAXw-hDiVqStwqnTRt-vJyYLM8uxJaMwM1V8Sr0Zgw",
    fingerprint: "39f713d0a644253f04529421b9f51b9b",
  },
  {
    seed: "xaqN9D-fg3vtt0QvMdy3sWbThTUHbwlLhc46LgtEWPc",
    publicKey: "_FHNjmIYoaONpH7QAjDwWAgW7RO6MwOsXeuRFUiQgCU",
    fingerprint: "dac073e0123bdea59dd9b3bda9cf6037",
  },
] as const;
export const INSTALLATION_ID = "11111111-1111-4111-8111-111111111111";
export const KEY_ID = "22222222-2222-4222-8222-222222222222";
