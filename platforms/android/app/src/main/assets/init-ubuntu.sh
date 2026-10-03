#!/bin/bash

# ============================================================
# Acode Ubuntu Rootfs launcher
# ============================================================

export PATH="/bin:/sbin:/usr/bin:/usr/sbin:/usr/share/bin:/usr/share/sbin:/usr/local/bin:/usr/local/sbin:/system/bin:/system/xbin:$PREFIX/local/bin"
export HOME="/public"
export TERM="xterm-256color"
export PS1='\[\e[38;5;46m\]\u\[\e[39m\]@localhost \[\e[39m\]\w \[\e[0m\]\$ '

INSTALLING=false
FAILSAFE=false

# ============================================================
# Parse arguments
# ============================================================

while [ "$#" -gt 0 ]; do
    case "$1" in
        --installing)
            INSTALLING=true
            shift
            ;;
        --failsafe)
            FAILSAFE=true
            shift
            ;;
        --)
            shift
            break
            ;;
        *)
            break
            ;;
    esac
done

# glibc resolves "localhost" through /etc/hosts (nsswitch uses `files dns`);
# the Ubuntu rootfs ships an empty file, so populate it once.
if [ ! -s /etc/hosts ]; then
    printf '127.0.0.1\tlocalhost\n::1\t\tlocalhost\n' > /etc/hosts
fi

# ============================================================
# Execute supplied command directly (VERY IMPORTANT)
# ============================================================

if [ "$INSTALLING" != true ] && [ "$#" -gt 0 ]; then
    exec "$@"
fi

# ============================================================
# Android group names
#
# Bionic ships no group database, so the GIDs inherited from the Android app
# (AID_INET, AID_EVERYBODY, the per-app cache/shared GIDs, ...) have no names
# inside the rootfs.  Ubuntu's /etc/bash.bashrc runs `groups` for its sudo hint
# on every interactive shell — twice, because bash sources it directly and
# /etc/profile sources it again — which then prints
#
#   groups: cannot find name for group ID 3003
#
# once per unnamed GID.  /etc/group lives in the rootfs, so register the GIDs
# this process actually has.  This is idempotent and safe to run on install and
# on every launch.
# ============================================================

_add_android_group() {
    local name="$1" gid="$2"

    [ -n "$name" ] && [ -n "$gid" ] || return 0

    # Skip when this name or this GID is already registered.
    awk -F: -v n="$name" -v g="$gid" \
        '$1 == n || $3 == g { found = 1 } END { exit !found }' \
        /etc/group && return 0

    # Keep the file newline-terminated before appending.
    if [ -s /etc/group ] && [ -n "$(tail -c 1 /etc/group)" ]; then
        printf '\n' >> /etc/group
    fi

    printf '%s:x:%s:\n' "$name" "$gid" >> /etc/group
}

register_android_groups() {
    local android_gid gid

    [ -w /etc/group ] || return 0

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

# ============================================================
# Timezone
#
# /etc/localtime can only link a zone file once tzdata provides one. Re-run on
# every launch so a tzdata install that happens later is picked up.
# ============================================================

sync_timezone() {
    local zone

    [ -e /etc/localtime ] && return 0
    [ -r /etc/timezone ] || return 0

    zone="$(cat /etc/timezone 2>/dev/null)"
    [ -n "$zone" ] || return 0
    [ -f "/usr/share/zoneinfo/$zone" ] || return 0

    ln -sf "/usr/share/zoneinfo/$zone" /etc/localtime
}

# ============================================================
# Fix Nodejs double free error on proot
# ============================================================

install_node_jemalloc_hook() {
    mkdir -p /etc/apt/apt.conf.d /usr/local/bin

    if [ ! -e /etc/apt/apt.conf.d/99node-hook ]; then
        cat > /etc/apt/apt.conf.d/99node-hook <<'EOF'
DPkg::Post-Invoke {
    "if [ -x /usr/bin/node ]; then /usr/local/bin/node-postinstall.sh; fi";
};
EOF
    fi

    if [ ! -e /usr/local/bin/node-postinstall.sh ]; then
        cat > /usr/local/bin/node-postinstall.sh <<'EOF'
#!/bin/sh

# Re-applied after every dpkg run and on every sandbox launch. dpkg puts a real
# binary back on upgrade, so the ELF magic decides whether the wrapper is still
# needed.

[ -e /usr/bin/node ] || exit 0

# `file` is not part of this rootfs, so read the ELF magic directly.
if [ "$(od -An -c -N4 /usr/bin/node 2>/dev/null | tr -d ' ')" != "177ELF" ]; then
    exit 0
fi

JEMALLOC=""

for path in \
    /usr/lib/*/libjemalloc.so* \
    /usr/lib/libjemalloc.so* \
    /lib/*/libjemalloc.so* \
    /lib/libjemalloc.so*; do
    if [ -e "$path" ]; then
        JEMALLOC="$path"
        break
    fi
done

[ -n "$JEMALLOC" ] || exit 0

echo "[node-hook] Wrapping /usr/bin/node with $JEMALLOC"

mv -f /usr/bin/node /usr/bin/node.distrib

cat > /usr/bin/node <<WRAP
#!/bin/sh
LD_PRELOAD=$JEMALLOC exec /usr/bin/node.distrib "\$@"
WRAP

chmod +x /usr/bin/node
EOF

        chmod +x /usr/local/bin/node-postinstall.sh
    fi
}

run_node_jemalloc_hook() {
    [ -x /usr/local/bin/node-postinstall.sh ] || return 0

    /usr/local/bin/node-postinstall.sh
}

# ============================================================
# One-time rootfs installation
#
# IMPORTANT:
# Normal launches should NEVER run apt.
# ============================================================

if [ "$INSTALLING" = true ]; then
    export DEBIAN_FRONTEND=noninteractive

    echo "[*] Configuring rootfs..."

    # --------------------------------------------------------
    # Configure timezone. /etc/localtime is linked by sync_timezone() once
    # tzdata actually provides the zone file.
    # --------------------------------------------------------

    mkdir -p /etc

    if [ -n "$ANDROID_TZ" ]; then
        echo "$ANDROID_TZ" > /etc/timezone
        echo "[+] Timezone: $ANDROID_TZ"
    else
        echo "Etc/UTC" > /etc/timezone
        echo "[+] Timezone: UTC"
    fi

    # Deployed before the first package install so a later `apt install nodejs`
    # already finds the dpkg hook in place.
    install_node_jemalloc_hook

    # tzdata lets /etc/localtime resolve and libjemalloc2 backs the Node.js
    # wrapper. Best effort and time-bounded so an offline install still works.
    APT_TIMEOUT=""
    command -v timeout >/dev/null 2>&1 && APT_TIMEOUT="timeout 60"

    APT_PACKAGES=""
    [ -d /usr/share/zoneinfo ] || APT_PACKAGES="tzdata"
    dpkg -s libjemalloc2 >/dev/null 2>&1 || APT_PACKAGES="$APT_PACKAGES libjemalloc2"

    if [ -n "$APT_PACKAGES" ]; then
        $APT_TIMEOUT apt-get update >/dev/null 2>&1 || true
        $APT_TIMEOUT apt-get install -y $APT_PACKAGES >/dev/null 2>&1 || true
    fi

    sync_timezone
    run_node_jemalloc_hook

    # --------------------------------------------------------
    # Rootfs filesystem setup
    # --------------------------------------------------------

    mkdir -p /linkerconfig

    if [ ! -f /linkerconfig/ld.config.txt ]; then
        touch /linkerconfig/ld.config.txt
    fi

    mkdir -p "$HOME"
    mkdir -p "$PREFIX/ubuntu/usr/local/bin"

    # --------------------------------------------------------
    # Acode MOTD
    # --------------------------------------------------------

    if [ ! -e "$PREFIX/ubuntu/etc/acode_motd" ]; then
        cat > "$PREFIX/ubuntu/etc/acode_motd" <<'EOF'
Welcome to Ubuntu Linux in Acode!

Working with packages:

 - Search:    apt search <query>
 - Install:   apt install <package>
 - Uninstall: apt remove <package>
 - Upgrade:   apt update && apt upgrade
EOF
    fi

    # --------------------------------------------------------
    # Acode CLI
    # --------------------------------------------------------

    if [ ! -e "$PREFIX/ubuntu/usr/local/bin/acode" ]; then
        cat > "$PREFIX/ubuntu/usr/local/bin/acode" <<'ACODE_CLI'
#!/bin/bash

usage() {
    echo "Usage: acode [file/folder...]"
    echo
    echo "Open files or folders in Acode editor."
    echo
    echo "Examples:"
    echo "  acode file.txt"
    echo "  acode ."
    echo "  acode ~/project"
    echo "  acode -h, --help"
}

get_abs_path() {
    local path="$1"
    local abs_path=""

    if command -v realpath >/dev/null 2>&1; then
        abs_path=$(realpath -- "$path" 2>/dev/null)
    fi

    if [ -z "$abs_path" ]; then
        if [ -d "$path" ]; then
            abs_path=$(cd -- "$path" 2>/dev/null && pwd -P)

        elif [ -e "$path" ]; then
            local dir_name
            local file_name

            dir_name=$(dirname -- "$path")
            file_name=$(basename -- "$path")

            abs_path="$(
                cd -- "$dir_name" 2>/dev/null &&
                pwd -P
            )/$file_name"

        elif [[ "$path" == /* ]]; then
            abs_path="$path"

        else
            abs_path="$PWD/$path"
        fi
    fi

    echo "$abs_path"
}

open_in_acode() {
    local path
    local type="file"

    path=$(get_abs_path "$1")

    if [ -d "$path" ]; then
        type="folder"
    fi

    printf '\e]7777;open;%s;%s\a' "$type" "$path"
}

if [ "$#" -eq 0 ]; then
    open_in_acode "."
    exit 0
fi

for arg in "$@"; do
    case "$arg" in
        -h|--help)
            usage
            exit 0
            ;;

        *)
            if [ -e "$arg" ]; then
                open_in_acode "$arg"
            else
                echo "Error: '$arg' does not exist" >&2
                exit 1
            fi
            ;;
    esac
done
ACODE_CLI

        chmod +x "$PREFIX/ubuntu/usr/local/bin/acode"
    fi

    # --------------------------------------------------------
    # Create initrc
    # --------------------------------------------------------

    if [ ! -e "$PREFIX/ubuntu/initrc" ]; then
        cat > "$PREFIX/ubuntu/initrc" <<'EOF'
# ============================================================
# Acode Ubuntu shell initialization
# ============================================================

# Load system profile
if [ -f /etc/profile ]; then
    source /etc/profile
fi

export PATH="$PATH:/bin:/sbin:/usr/bin:/usr/sbin:/usr/share/bin:/usr/share/sbin:/usr/local/bin:/usr/local/sbin"
export HOME="/public"
export TERM="xterm-256color"
export SHELL="/bin/bash"

# Allow pip to install packages into the system environment.
export PIP_BREAK_SYSTEM_PACKAGES=1

# ============================================================
# Shorten current path
# ~/project/src/components
# becomes:
# ~/p/s/components
# ============================================================

_shorten_path() {
    local path="$PWD"

    if [[ "$HOME" != "/" && "$path" == "$HOME" ]]; then
        echo "~"
        return
    fi

    if [[ "$HOME" != "/" && "$path" == "$HOME/"* ]]; then
        path="~${path#$HOME}"
    fi

    [[ "$path" == "~" ]] && echo "~" && return

    local parts
    local result=""
    local len

    IFS='/' read -ra parts <<< "$path"

    len=${#parts[@]}

    for ((i=0; i<len; i++)); do
        [[ -z "${parts[i]}" ]] && continue

        if [[ "$i" -lt $((len - 1)) ]]; then
            result+="${parts[i]:0:1}/"
        else
            result+="${parts[i]}"
        fi
    done

    if [[ "$path" == /* ]]; then
        echo "/$result"
    else
        echo "$result"
    fi
}

# ============================================================
# Prompt
# ============================================================

PROMPT_COMMAND='_PS1_PATH=$(_shorten_path); _PS1_EXIT=$?'

PS1='\[\033[1;32m\]\u\[\033[0m\]@localhost \[\033[1;34m\]$_PS1_PATH\[\033[0m\] \[\033[0m\]\$ '

# ============================================================
# MOTD
# ============================================================

if [ -s /etc/acode_motd ]; then
    cat /etc/acode_motd
fi

# ============================================================
# Binary execution warning
# ============================================================

check_binary_execution() {
    local cmd="$1"
    local cmd_path=""

    [[ -z "$cmd" ]] && return

    if [[ "$cmd" == */* ]]; then
        cmd_path="$(realpath "$cmd" 2>/dev/null)"
    else
        cmd_path="$(command -v "$cmd" 2>/dev/null)"

        if [[ -n "$cmd_path" ]]; then
            cmd_path="$(realpath "$cmd_path" 2>/dev/null)"
        fi
    fi

    [[ -z "$cmd_path" ]] && return
    [[ ! -f "$cmd_path" ]] && return

    if [[ "$cmd_path" == /storage/* ]] ||
       [[ "$cmd_path" == /sdcard/* ]]; then

        echo -e "\e[1;31m[!] ATTENTION REQUIRED\e[0m

\e[1;31mThe binary is located in:\e[0m
  \e[36m$cmd_path\e[0m

\e[1;31mBinaries cannot be executed reliably from /sdcard or /storage.\e[0m

These locations are backed by Android's external storage layer
and do not support normal Linux executable permissions.

Move your project or binary to a directory under:

  \e[1;32m/home/\e[0m

Example:

  \e[1;32mmv myproject ~/myproject\e[0m
  \e[1;32mcd ~/myproject\e[0m

Then run the binary again.
" >&2
    fi
}

_acode_preexec() {
    [[ "$BASH_COMMAND" == trap* ]] && return

    local cmd="${BASH_COMMAND%% *}"

    check_binary_execution "$cmd"
}

# Preserve an existing DEBUG trap.
__acode_existing_debug_trap="$(trap -p DEBUG 2>/dev/null)"

if [[ -n "$__acode_existing_debug_trap" ]]; then
    __acode_existing_cmd="$(
        printf '%s' "$__acode_existing_debug_trap" |
        sed -E "s/.*'((.*))'.*/\1/"
    )"
else
    __acode_existing_cmd=""
fi

if [[ "$__acode_existing_cmd" != *"_acode_preexec"* ]]; then
    if [[ -n "$__acode_existing_cmd" ]]; then
        trap "$__acode_existing_cmd; _acode_preexec" DEBUG
    else
        trap '_acode_preexec' DEBUG
    fi
fi

unset __acode_existing_debug_trap
unset __acode_existing_cmd

# ============================================================
# Command-not-found handler
# ============================================================

command_not_found_handle() {
    local cmd="$1"
    local pkg=""

    pkg="$(
        apt-cache search "^${cmd}$" 2>/dev/null |
        awk '{print $1}' |
        head -n 1
    )"

    if [ -n "$pkg" ]; then
        echo -e "The program '$cmd' is not installed.\nInstall it with:\n \e[1;32mapt install $pkg\e[0m" >&2
    else
        echo "The program '$cmd' is not installed and no package provides it." >&2
    fi

    return 127
}

# Termux-compatible behaviour
alias clear='reset'

# ============================================================
# User configuration
# ============================================================

if [ -f /etc/bash/bashrc ]; then
    source /etc/bash/bashrc
fi

if [ -f "$HOME/.bashrc" ]; then
    source "$HOME/.bashrc"
fi
EOF
    fi

    chmod +x "$PREFIX/ubuntu/initrc"

    # --------------------------------------------------------
    # Register the Android GIDs so `groups`/`id` can name them
    # --------------------------------------------------------

    register_android_groups

    # --------------------------------------------------------
    # Mark rootfs as configured
    # --------------------------------------------------------

    mkdir -p "$PREFIX/.configured"

    touch "$PREFIX/.configured/rootfs"

    echo "[+] Rootfs configuration complete."
    exit 0
fi

# ============================================================

echo "$$" > "$PREFIX/pid"

chmod +x "$PREFIX/axs"

if [ "$FAILSAFE" = true ]; then
    exit 0
fi

# Runs on every launch too, so existing rootfs installs pick up new GIDs (and
# any group Android grants later) without reinstalling the sandbox, and so the
# Node.js jemalloc hook reaches installs made before it existed.
register_android_groups
sync_timezone
install_node_jemalloc_hook
run_node_jemalloc_hook

# AXS splits the `-c` string on whitespace and resolves the FIRST token as the
# program (src/terminal/handlers.rs: cmd.split_whitespace()). A leading `exec`
# therefore becomes the program name, and spawning `exec` fails with
# "No viable candidates found in PATH". Keep a single leading token: `bash`.
exec "$PREFIX/axs" -c "bash --rcfile /initrc -i"
