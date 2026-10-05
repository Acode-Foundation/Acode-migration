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

# Bump when a generated artifact below changes so existing installs refresh it.
# Presence checks alone pin a stale script on disk forever, which would keep a
# fixed bug alive for every user who installed before the fix shipped.
ACODE_GENERATED_VERSION="4"
ACODE_VERSION_FILE="/etc/acode/generated.version"
ACODE_GROUP_FILE="/etc/group"
ACODE_GROUP_LOCK="/etc/.acode-group.lock"
# Minutes an abandoned group lock may sit before it is treated as debris.
ACODE_GROUP_LOCK_GRACE="5"
# Node.js release the rootfs installs from NodeSource. Ubuntu 24.04 ships
# nodejs 18, which is past end of life.
ACODE_NODE_MAJOR="26.x"
ACODE_APT_SOURCES="/etc/apt/sources.list.d/nodesource.sources"
ACODE_APT_KEYRING="/usr/share/keyrings/nodesource.gpg"
ACODE_APT_PREFERENCES="/etc/apt/preferences.d"

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
#
# A leading option must not be exec'd as a program; only a real command is
# forwarded.
# ============================================================

if [ "$INSTALLING" != true ] && [ "$#" -gt 0 ] && [ "${1#--}" = "$1" ]; then
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
# Generated artifact versioning
#
# A pure "does it exist" check would pin a stale generated script on disk
# forever, so a bug fixed here would never reach anyone who installed earlier.
# /etc/acode/generated.version is written by the install path once every
# artifact has been regenerated; if it is missing or older, the artifacts are
# rewritten.
# ============================================================

is_current_version() {
    awk -v wanted="$1" '
        { count += ($0 == wanted) }
        END { exit !(count == 1) }
    ' "$ACODE_VERSION_FILE" 2>/dev/null
}

needs_refresh() {
    [ ! -e "$1" ] && return 0
    is_current_version "$ACODE_GENERATED_VERSION" && return 1
    grep -qF "acode-generated-version: $ACODE_GENERATED_VERSION" "$1" 2>/dev/null && return 1
    return 0
}

write_version_marker() {
    mkdir -p "$(dirname "$ACODE_VERSION_FILE")"
    printf '%s\n' "$ACODE_GENERATED_VERSION" > "$ACODE_VERSION_FILE.tmp"
    mv -f "$ACODE_VERSION_FILE.tmp" "$ACODE_VERSION_FILE"
}

# ============================================================
# Fix Nodejs double free error on proot
# ============================================================

install_node_jemalloc_hook() {
    mkdir -p /etc/apt/apt.conf.d /usr/local/bin

    if needs_refresh /etc/apt/apt.conf.d/99node-hook; then
        cat > /etc/apt/apt.conf.d/99node-hook <<EOF
// acode-generated-version: $ACODE_GENERATED_VERSION
DPkg::Post-Invoke {
    "if [ -x /usr/bin/node ]; then /usr/local/bin/node-postinstall.sh; fi";
};
EOF
    fi

    if needs_refresh /usr/local/bin/node-postinstall.sh; then
        cat > /usr/local/bin/node-postinstall.sh <<EOF
#!/bin/sh
# acode-generated-version: $ACODE_GENERATED_VERSION

# dpkg puts a real binary back on upgrade, so the ELF magic decides whether the
# wrapper is still needed.
[ -e /usr/bin/node ] || exit 0

# \`file\` is not part of this rootfs, so read the ELF magic as hex. -c renders
# the first byte as the character E, never as 177, which is why -tx1 is used.
[ "\$(od -An -tx1 -N4 /usr/bin/node 2>/dev/null | tr -d ' \\n')" = "7f454c46" ] || exit 0

JEMALLOC=""
for path in \\
    /usr/lib/*/libjemalloc.so* \\
    /usr/lib/libjemalloc.so* \\
    /lib/*/libjemalloc.so* \\
    /lib/libjemalloc.so*; do
    if [ -e "\$path" ]; then
        JEMALLOC="\$path"
        break
    fi
done

[ -n "\$JEMALLOC" ] || exit 0

# Two shells can launch at once, so only the first may rewrite /usr/bin/node.
# Without this a second run moves the wrapper the first one wrote over the real
# binary, leaving node.distrib pointing at itself.
LOCK=/tmp/.acode-node-hook.lock
mkdir "\$LOCK" 2>/dev/null || exit 0
trap 'rmdir "\$LOCK" 2>/dev/null' EXIT

# Re-check inside the lock: the winner has already rewritten the binary.
[ "\$(od -An -tx1 -N4 /usr/bin/node 2>/dev/null | tr -d ' \\n')" = "7f454c46" ] || exit 0

printf '\\033[33m[node-hook]\\033[0m Wrapping /usr/bin/node with %s\\n' "\$JEMALLOC"

mv -f /usr/bin/node /usr/bin/node.distrib

printf '#!/bin/sh\\nLD_PRELOAD=%s exec /usr/bin/node.distrib "\$@"\\n' "\$JEMALLOC" > /usr/bin/node

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
# NodeSource package repository
#
# Ubuntu 24.04 ships nodejs 18, which is past end of life, so anything the
# npm-based LSP installs need gets an unsupported runtime. This registers the
# NodeSource repository the way deb.nodesource.com/setup_26.x does, but inline:
# the published script is not used because it runs `apt update`, installs
# pre-requisites and rewrites the key on every run, while this only has to
# happen once per generated version and has to stay best effort. The apt pin
# keeps `apt install nodejs` on NodeSource.
# ============================================================

configure_nodesource_repo() {
    local arch=""

    # Architecture packages are fetched for; NodeSource only builds these two.
    arch="$(dpkg --print-architecture 2>/dev/null)"
    case "$arch" in
        amd64|arm64) ;;
        *)
            log_warn "NodeSource has no packages for '${arch:-unknown}' - keeping Ubuntu's nodejs"
            return 0
            ;;
    esac

    if needs_refresh "$ACODE_APT_SOURCES"; then
        log_step "Installing the NodeSource signing key..."

        # The key and the lists have to be registered before the update below,
        # and curl/gnupg are what the rootfs may still be missing.
        if ! apt-get install -y --no-install-recommends ca-certificates curl gnupg; then
            log_warn "Could not install curl/gnupg - keeping Ubuntu's nodejs"
            return 0
        fi

        mkdir -p \
            "$(dirname "$ACODE_APT_SOURCES")" \
            "$(dirname "$ACODE_APT_KEYRING")" \
            "$ACODE_APT_PREFERENCES"

        if ! curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key |
            gpg --dearmor -o "$ACODE_APT_KEYRING"; then
            log_warn "Could not import the NodeSource signing key - keeping Ubuntu's nodejs"
            return 0
        fi

        chmod 644 "$ACODE_APT_KEYRING"

        cat > "$ACODE_APT_SOURCES" <<EOF
# acode-generated-version: $ACODE_GENERATED_VERSION
Types: deb
URIs: https://deb.nodesource.com/node_$ACODE_NODE_MAJOR
Suites: nodistro
Components: main
Architectures: $arch
Signed-By: $ACODE_APT_KEYRING
EOF

        # The pin decides which suite wins when a package exists in both.
        cat > "$ACODE_APT_PREFERENCES/nodejs" <<'EOF'
Package: nodejs
Pin: origin deb.nodesource.com
Pin-Priority: 600
EOF
    fi

    if apt-get update; then
        log_ok "NodeSource repository configured"
    else
        log_warn "Could not read the NodeSource package lists - keeping Ubuntu's nodejs"
    fi
}

# ============================================================
# Install log colors
#
# The install log is rendered by the app's xterm, which understands ANSI SGR
# even though the native bridge hands the script a pipe instead of a tty.
# NO_COLOR (https://no-color.org) and ACODE_NO_COLOR opt out.
# ============================================================

if [ -n "${NO_COLOR:-}" ] || [ -n "${ACODE_NO_COLOR:-}" ]; then
    LOG_STEP=""
    LOG_OK=""
    LOG_WARN=""
    LOG_ERROR=""
    LOG_RESET=""
else
    LOG_STEP='\033[36m'
    LOG_OK='\033[32m'
    LOG_WARN='\033[33m'
    LOG_ERROR='\033[31m'
    LOG_RESET='\033[0m'
fi

log_step() {
    printf '%b[*] %s%b\n' "$LOG_STEP" "$*" "$LOG_RESET"
}

log_ok() {
    printf '%b[+] %s%b\n' "$LOG_OK" "$*" "$LOG_RESET"
}

log_warn() {
    printf '%b[!] %s%b\n' "$LOG_WARN" "$*" "$LOG_RESET"
}

log_error() {
    printf '%b[!] %s%b\n' "$LOG_ERROR" "$*" "$LOG_RESET" >&2
}

# ============================================================
# One-time rootfs installation
#
# IMPORTANT:
# Normal launches should NEVER run apt.
# ============================================================

if [ "$INSTALLING" = true ]; then
    export DEBIAN_FRONTEND=noninteractive

    log_step "Configuring rootfs..."

    # --------------------------------------------------------
    # Configure timezone. /etc/localtime is linked by sync_timezone() once
    # tzdata actually provides the zone file.
    # --------------------------------------------------------

    mkdir -p /etc

    if [ -n "$ANDROID_TZ" ]; then
        echo "$ANDROID_TZ" > /etc/timezone
        log_ok "Timezone: $ANDROID_TZ"
    else
        echo "Etc/UTC" > /etc/timezone
        log_ok "Timezone: UTC"
    fi

    # Deployed before the first package install so a later `apt install nodejs`
    # already finds the dpkg hook in place.
    log_step "Installing the Node.js jemalloc hook..."
    install_node_jemalloc_hook
    log_ok "Node.js jemalloc hook installed"

    # Registered before the package lists are fetched below, so that one update
    # covers NodeSource too.
    log_step "Configuring the Node.js package repository..."
    configure_nodesource_repo
    log_ok "Node.js package repository ready"

    # tzdata lets /etc/localtime resolve and libjemalloc2 backs the Node.js
    # wrapper. Best effort and time-bounded so an offline install still works.
    # Setup reaches the network here, for the package lists and NodeSource.

    APT_PACKAGES=""
    [ -d /usr/share/zoneinfo ] || APT_PACKAGES="tzdata"
    dpkg -s libjemalloc2 >/dev/null 2>&1 || APT_PACKAGES="$APT_PACKAGES libjemalloc2"

    if [ -n "$APT_PACKAGES" ]; then
        log_step "Installing required packages: $APT_PACKAGES"

        if apt-get update; then
            log_ok "Package lists updated"
        else
            log_warn "Could not update package lists - continuing without $APT_PACKAGES"
        fi

        if apt-get install -y $APT_PACKAGES; then
            log_ok "Installed: $APT_PACKAGES"
        else
            log_warn "Could not install: $APT_PACKAGES - continuing without them"
        fi
    else
        log_ok "Required packages already present"
    fi

    log_step "Applying timezone..."
    sync_timezone
    run_node_jemalloc_hook
    log_ok "Timezone and Node.js runtime configured"

    # --------------------------------------------------------
    # Rootfs filesystem setup
    # --------------------------------------------------------

    log_step "Preparing rootfs layout..."

    mkdir -p /linkerconfig

    if [ ! -f /linkerconfig/ld.config.txt ]; then
        touch /linkerconfig/ld.config.txt
    fi

    mkdir -p "$HOME"

    if [ ! -f "$HOME/.bashrc" ]; then
        touch "$HOME/.bashrc" && chmod 644 "$HOME/.bashrc"
    fi

    # --------------------------------------------------------
    # Generated artifacts
    # --------------------------------------------------------

    log_step "Writing shell configuration..."

    refresh_generated_artifacts

    log_ok "Shell configuration ready"

    # --------------------------------------------------------
    # Register the Android GIDs so `groups`/`id` can name them
    # --------------------------------------------------------

    log_step "Registering Android groups..."
    register_android_groups
    log_ok "Android groups registered"

    # --------------------------------------------------------
    # Mark rootfs as configured
    # --------------------------------------------------------

    mkdir -p "$PREFIX/.configured"

    touch "$PREFIX/.configured/rootfs"

    # The install path reports success purely from this exit code, so verify the
    # artifacts actually landed instead of announcing completion unconditionally.
    missing=""
    for required in \
        "$PREFIX/ubuntu/bin/sh" \
        "$PREFIX/ubuntu/bin/bash" \
        "$PREFIX/ubuntu/etc/group" \
        "$PREFIX/ubuntu/initrc" \
        "$PREFIX/ubuntu/usr/local/bin/acode" \
        "$PREFIX/.configured/rootfs"; do
        [ -e "$required" ] || missing="$missing $required"
    done

    if [ -n "$missing" ]; then
        log_error "Rootfs configuration incomplete, missing:$missing"
        exit 1
    fi

    write_version_marker

    log_ok "Rootfs configuration complete."
    exit 0
fi

# ============================================================
# Generated artifacts
#
# initrc, the acode CLI and the MOTD live in the rootfs rather than in this
# launcher, so they can be rewritten without reinstalling the sandbox. The
# call sites are the install path only: a normal launch must not touch them.
# Each write is guarded by needs_refresh, so a current install only performs
# the version check.
# ============================================================

refresh_generated_artifacts() {
    mkdir -p "$PREFIX/ubuntu/etc" "$PREFIX/ubuntu/usr/local/bin"

    # --------------------------------------------------------
    # Acode MOTD
    # --------------------------------------------------------

    if needs_refresh "$PREFIX/ubuntu/etc/acode_motd"; then
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

    if needs_refresh "$PREFIX/ubuntu/usr/local/bin/acode"; then
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

    log_ok "acode CLI ready"

    # --------------------------------------------------------
    # Create initrc
    # --------------------------------------------------------

    log_step "Writing shell configuration..."

    if needs_refresh "$PREFIX/ubuntu/initrc"; then
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

# The DEBUG trap forks a subshell per command, so only install it when the
# external-storage paths it warns about are actually mounted.
if [ -d /sdcard ] || [ -d /storage ]; then
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
fi

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
# Prompt
#
# Ubuntu's /etc/bash.bashrc installs a plain prompt on every interactive
# shell, and the rc files below load after this point, so the colored prompt
# is written here and repaired again if the user has no prompt of their own.
# ============================================================

PROMPT_COMMAND='_PS1_PATH=$(_shorten_path); _PS1_EXIT=$?; if [ "$_PS1_EXIT" -ne 0 ]; then _PS1_MARK="\[\033[31m\]>$\[\033[0m\]"; else _PS1_MARK="$"; fi'

PS1='\[\033[1;32m\]\u\[\033[0m\]@localhost \[\033[1;34m\]$_PS1_PATH\[\033[0m\] ${_PS1_MARK:-$} '

# ============================================================
# User configuration
# ============================================================

if [ -f /etc/bash.bashrc ]; then
    source /etc/bash.bashrc
fi

# Snapshot what the rootfs left in PS1 before the user's rc file runs, so a
# prompt that survives it unchanged can be told apart from a deliberate one.
_ACODE_ROOTFS_PS1="$PS1"

if [ -f "$HOME/.bashrc" ]; then
    source "$HOME/.bashrc"
fi

# A user prompt always wins. The plain prompt the rootfs ships is only kept
# when it survived the user's rc file untouched, which means it was never a
# choice, so the colored prompt goes back.
if [ "$PS1" = "$_ACODE_ROOTFS_PS1" ]; then
    PS1='\[\033[1;32m\]\u\[\033[0m\]@localhost \[\033[1;34m\]$_PS1_PATH\[\033[0m\] ${_PS1_MARK:-$} '
fi

unset _ACODE_ROOTFS_PS1
EOF
    fi

    chmod +x "$PREFIX/ubuntu/initrc"
}

# ============================================================

# One file per session: a single $PREFIX/pid only ever names the newest shell,
# so stopping the terminal left the other tabs running.
echo "$$" > "$PREFIX/pid.$$"
#keeping fro backward compatibility
echo "$$" > "$PREFIX/pid"

chmod +x "$PREFIX/axs"

if [ "$FAILSAFE" = true ]; then
    log_warn "FailSafe mode is on skipping ubuntu launch."
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
#
# The listener port is recorded before exec so the app can rediscover it after a
# WebView reload. AXS_PORT and AXS_ALLOW_ANY_ORIGIN let the app bind a free port;
# the app page is served from https://localhost, which is AXS's default CORS
# allowlist, so any-origin is only enabled on explicit opt-in.
AXS_PORT="${AXS_PORT:-8767}"
echo "$AXS_PORT" > "$PREFIX/axs.port"
set -- --port "$AXS_PORT"
if [ "${AXS_ALLOW_ANY_ORIGIN:-0}" = "1" ]; then
    set -- "$@" --allow-any-origin
fi
exec "$PREFIX/axs" "$@" -c "bash --rcfile /initrc -i"
