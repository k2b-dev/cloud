### Use the provider serializer in decision bridge fixtures

- **What happened:** The Code bridge quota regression received `invalid_app_response` instead of `quota_exhausted`.
- **Root cause:** The fixture put the HTTP status into the JSON error body. The dispatcher correctly rejected that extra field.
- **Error class:** A transport fixture diverges from the production wire contract.
- **Guard:** The bridge fixture uses the production capability serializer and mocks the real `AiQuotaError`. A focused unit test validates the serialized quota refusal against the strict wire schema and verifies zero Code reference cost; the integration test checks that the reservation is cleared.
