### Oversized corridor fixtures consume the test deadline

- **What happened:** Geo corridor correctness tests spent their deadline processing more points than the provider-limit case required.
- **Root cause:** The fixture size exceeded the number needed to cross the 2,000-point provider limit.
- **Error class:** Oversized fixtures consume behavioral test deadlines.
- **Guard:** Geo corridor service cases use 2,101 points to retain the 16 m simplification across the 2,000-point limit, with the original corridor, filtering, truncation and accounting assertions.
