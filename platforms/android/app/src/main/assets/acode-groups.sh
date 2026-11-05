# Android group registration for the Ubuntu rootfs.
#
# Bionic ships no group database, so the GIDs inherited from the Android app
# (AID_INET, AID_EVERYBODY, the per-app cache/shared GIDs, ...) have no names
# inside the rootfs.  Ubuntu's /etc/bash.bashrc runs `groups` for its sudo hint
# on every interactive shell - twice, because bash sources it directly and
# /etc/profile sources it again - which then prints
#
#   groups: cannot find name for group ID 3003
#
# once per unnamed GID.  /etc/group lives in the rootfs, so register the GIDs
# this process actually has.  This is idempotent and safe to run on install and
# on every launch.
#
# Sourced by init-ubuntu.sh; runs under /bin/sh (dash). ACODE_GROUP_FILE,
# ACODE_GROUP_LOCK and ACODE_GROUP_LOCK_GRACE come from the entry script.

_add_android_group() {
    local name="$1" gid="$2"

    [ -n "$name" ] && [ -n "$gid" ] || return 0

    # Every terminal tab appends concurrently, so the lookup and the append have
    # to be one atomic step or duplicate lines accumulate. mkdir is the atomic
    # primitive here because flock is not guaranteed to exist in the rootfs.
    if ! mkdir "$ACODE_GROUP_LOCK" 2>/dev/null; then
        # A shell killed with SIGKILL cannot run its EXIT trap, which would park
        # this directory forever and skip group registration on every later
        # launch. The pass takes milliseconds, so anything older than the grace
        # period is debris: clear it and retry once.
        if [ -n "$(find "$ACODE_GROUP_LOCK" -maxdepth 0 -mmin +"$ACODE_GROUP_LOCK_GRACE" 2>/dev/null)" ]; then
            rmdir "$ACODE_GROUP_LOCK" 2>/dev/null
        fi

        # Losing the race means another shell is already performing the pass:
        # skip rather than steal the directory, which would let a second writer
        # in while it appends.
        mkdir "$ACODE_GROUP_LOCK" 2>/dev/null || return 0
    fi
    trap 'rmdir "$ACODE_GROUP_LOCK" 2>/dev/null' EXIT

    if ! awk -F: -v n="$name" -v g="$gid" '
        $1 == n || $3 == g { found = 1 }
        END { exit !found }
    ' "$ACODE_GROUP_FILE"; then
        # Keep the file newline-terminated before appending.
        if [ -s "$ACODE_GROUP_FILE" ] && [ -n "$(tail -c 1 "$ACODE_GROUP_FILE")" ]; then
            printf '\n' >> "$ACODE_GROUP_FILE"
        fi

        printf '%s:x:%s:\n' "$name" "$gid" >> "$ACODE_GROUP_FILE"
    fi

    rmdir "$ACODE_GROUP_LOCK" 2>/dev/null
    return 0
}

register_android_groups() {
    local android_gid

    [ -w "$ACODE_GROUP_FILE" ] || return 0

    # The kernel still reports the real credentials even though proot -0 fakes
    # getuid()/getgid() for the shell, so `Gid:` names the app's primary GID
    # (AID_APP_START + app id, e.g. 10546).
    android_gid="$(awk '/^Gid:/{ print $2; exit }' /proc/self/status 2>/dev/null)"
    case "$android_gid" in ''|*[!0-9]*) android_gid="$(id -g 2>/dev/null)" ;; esac
    case "$android_gid" in ''|*[!0-9]*) android_gid=0 ;; esac

    # Android derives the other per-app GIDs from the app id:
    # cache = app + 10000 (AID_CACHE_GID_START), shared = app + 40000
    # (AID_SHARED_GID_START).
    if [ "$android_gid" -ge 10000 ] && [ "$android_gid" -le 19999 ]; then
        _add_android_group android_app "$android_gid"
        _add_android_group android_cache "$((android_gid + 10000))"
        _add_android_group android_shared "$((android_gid + 40000))"
    fi

    # Well-known Android AIDs (android_filesystem_config.h) that can show up in
    # an app's supplementary groups.
    _add_android_group sdcard_rw 1015
    _add_android_group media_rw 1023
    _add_android_group sdcard_r 1028
    _add_android_group external_storage 1077
    _add_android_group inet 3003
    _add_android_group net_raw 3004
    _add_android_group net_admin 3005
    _add_android_group net_bw_stats 3006
    _add_android_group net_bw_acct 3007
    _add_android_group readproc 3009
    _add_android_group wakelock 3010
    _add_android_group uhid 3011
    _add_android_group readtracefs 3012
    _add_android_group everybody 9997
    _add_android_group android_misc 9998
    _add_android_group android_nobody 9999

    # Anything left (multi-user offsets, OEM IDs) still needs a name, otherwise
    # `groups` keeps warning about it.
    for gid in $(awk '/^Groups:/{ $1 = ""; print }' /proc/self/status 2>/dev/null); do
        case "$gid" in ''|*[!0-9]*) continue ;; esac
        _add_android_group "android_gid_$gid" "$gid"
    done
}
