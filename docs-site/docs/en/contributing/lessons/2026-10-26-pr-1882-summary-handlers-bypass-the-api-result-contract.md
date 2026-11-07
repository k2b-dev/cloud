### Summary handlers bypass the API result contract

- **What happened:** A small read-only endpoint can return the right payload while still violating the application response boundary. A runtime-only CSS property can also be invisible to static ownership checks.
- **Root cause:** The new summary routes returned JSON directly instead of using the shared API result responder; the shell inset also lacked a CSS-owned default.
- **Error class:** Summary handlers bypass the API result contract
- **Guard:** Existing `service-api-contracts` and `css` checks require Result-based responses and a CSS or documented runtime owner. The fix supplies the MobileShell CSS default; summary integration and mobile-shell browser tests retain payload and inset behavior.
