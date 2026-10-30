# Timezone linking for the Ubuntu rootfs.
#
# /etc/localtime can only link a zone file once tzdata provides one. Re-run on
# every launch so a tzdata install that happens later is picked up.
#
# Sourced by init-ubuntu.sh; runs under /bin/sh (dash).

sync_timezone() {
    local zone

    [ -e /etc/localtime ] && return 0
    [ -r /etc/timezone ] || return 0

    zone="$(cat /etc/timezone 2>/dev/null)"
    [ -n "$zone" ] || return 0
    [ -f "/usr/share/zoneinfo/$zone" ] || return 0

    ln -sf "/usr/share/zoneinfo/$zone" /etc/localtime
}
