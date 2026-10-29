### Full personal keys must retain their user grants

- **What happened:** A full personal API key could not use an existing Grids grant.
- **Root cause:** Grids applied machine credential scope limits to a delegated personal key, whose supported full-access form has an empty scope list.
- **Error class:** Conflating a delegated user identity with an independent machine identity.
- **Guard:** Permission and workflow tests preserve delegated user access while retaining machine scope limits. The route regression creates the key through `createUserApiToken`, rather than inventing scopes in a fixture.
