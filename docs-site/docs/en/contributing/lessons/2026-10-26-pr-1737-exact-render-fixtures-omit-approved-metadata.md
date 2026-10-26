### Exact render fixtures omit approved metadata

- **What happened:** The shell or sign-in form requires supported identity metadata while render fixtures still supply or expect the previous shape.
- **Root cause:** Render fixtures did not supply or expect identity metadata required by the updated shell and consent form.
- **Error class:** Exact render fixtures omit approved metadata
- **Guard:** Cloud `Layout.unchanged.render.test.tsx` keeps all five exact render cases; update only the three authenticated profile objects for the approved field and retain every other snapshot byte.
