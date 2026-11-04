### A queue wait budget must end at admission

- **What happened:** A runner could receive no work after Core had already claimed a run, leaving it waiting for lease recovery.
- **Root cause:** Lease preparation inherited the queue poll's abort signal. An owner read that outlasted the queue wait discarded the claimed lease even though its own budget remained available.
- **Error class:** A timeout crosses the boundary of the operation it limits.
- **Guard:** The scheduling integration regression holds an owner read beyond the queue wait and requires delivery of the original run and generation. Lease preparation uses the request signal and its existing five-second owner-read budget; no timeout is increased.
