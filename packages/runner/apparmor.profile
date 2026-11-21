# Load once per Docker host: sudo apparmor_parser -r packages/runner/apparmor.profile
#include <tunables/global>
profile cloud-code-runner flags=(attach_disconnected,mediate_deleted) {
  #include <abstractions/base>
  file,
  network,
  capability,
  signal,
  ptrace,
  userns,
  # The supervisor has no host SYS_ADMIN. Only namespace-local setup can use these.
  # Roles then inherit an additional irreversible seccomp namespace/mount denial.
  mount options=(rw, rprivate) -> /,
  mount fstype=proc -> /proc/,
  mount fstype=tmpfs -> /tmp/,
  mount fstype=tmpfs -> /dev/{shm,mqueue}/,
  deny /proc/{bus,fs,irq,sys}/** wklx,
  deny /proc/sysrq-trigger rwklx,
  deny /proc/{kcore,mem,kmem,keys,interrupts,timer_list,timer_stats,latency_stats,sched_debug} rwklx,
  deny /proc/{acpi,asound,scsi}/** rwklx,
  deny /sys/** wklx,
  deny /sys/{firmware,devices/virtual/powercap}/** r,
}
