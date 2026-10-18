#!/usr/bin/env bash
# Records every process that crashes on a CI runner and reports them at the
# end of the job. A crashed browser process shows in a test only as a vague
# error: when WebKit's network process crashed during a Back, the test saw
# "WebKit encountered an internal error" and nothing else (#1431).
#
# Usage:
#   .github/process-crashes.sh install   let the kernel hand every core dump to `record`
#   .github/process-crashes.sh report    print the recorded crashes as job errors
#
# The kernel runs `record <name> <pid> <signal> <time>` as root for each
# crash, also for processes in containers. It writes one line and drops the
# core dump.
set -euo pipefail
# The kernel's helper runs as root, and root may not append to a file of
# another user in the sticky /tmp (fs.protected_regular), so the log lives in
# a directory of its own.
dir=/tmp/process-crashes
log=$dir/log

case "${1:-}" in
  install)
    rm -rf "$dir" && mkdir "$dir"
    sudo sysctl -q -w kernel.core_pattern="|$(realpath "$0") record %e %P %s %t"
    ;;
  record)
    echo "$(date -u -d "@$5" +%H:%M:%S) $2 (pid $3) ended with signal SIG$(kill -l "$4")" >> "$log"
    ;;
  report)
    if [[ -s "$log" ]]; then
      while IFS= read -r line; do echo "::error title=A process crashed::$line"; done < "$log"
    else
      echo "No process crashed."
    fi
    ;;
  *)
    sed -n '2,13p' "$0" | cut -c3-
    [[ "${1:-}" == "--help" ]]
    ;;
esac
