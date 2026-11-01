### Discussion count fixtures need principal reader decisions

- **What happened:** Generic discussion feed tests passed their content checks but reported zero unread mentions in the sidebar.
- **Root cause:** The fixtures supplied interactive resource views but omitted the platform principal reader used by discussion counts.
- **Error class:** Incomplete integration fixture after an authorization boundary changed.
- **Guard:** The For you integration tests supply both reader contracts and retain count assertions for allowed and revoked principals.
