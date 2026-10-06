#!/usr/bin/env bash
set -euo pipefail
rule=(-p tcp --dport 443 -m conntrack --ctstate NEW -m comment --comment whatsapp-otp-api -j ACCEPT)
case "${1:-}" in
  start)
    /usr/sbin/iptables -w -C INPUT "${rule[@]}" 2>/dev/null || /usr/sbin/iptables -w -I INPUT 1 "${rule[@]}"
    ;;
  stop)
    if /usr/sbin/iptables -w -C INPUT "${rule[@]}" 2>/dev/null; then
      /usr/sbin/iptables -w -D INPUT "${rule[@]}"
    fi
    ;;
  *) exit 2 ;;
esac
