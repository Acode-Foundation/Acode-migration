#!/bin/sh

# ============================================================
# Acode Ubuntu Rootfs launcher
#
# Runs inside proot under /bin/sh (dash), started by init-sandbox.sh. It keeps
# only what every invocation shares: the environment, argument parsing,
# /etc/hosts and the dispatch into the install or launch module. Everything
# else lives in a sibling acode-*.sh module, and the static shell files (initrc,
# acode CLI, MOTD, Node.js hook) are written into the rootfs by the app before
# this runs.
# ============================================================

ACODE_INIT_DIR=$(dirname "$0")

export PATH="/bin:/sbin:/usr/bin:/usr/sbin:/usr/share/bin:/usr/share/sbin:/usr/local/bin:/usr/local/sbin:/system/bin:/system/xbin:$PREFIX/local/bin"
export HOME="/public"
export TERM="xterm-256color"

# Shared paths and values read by the sourced modules.
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

INSTALLING=false
FAILSAFE=false

. "$ACODE_INIT_DIR/acode-log.sh"
. "$ACODE_INIT_DIR/acode-groups.sh"
. "$ACODE_INIT_DIR/acode-timezone.sh"
. "$ACODE_INIT_DIR/acode-node.sh"

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
# Dispatch
# ============================================================

if [ "$INSTALLING" = true ]; then
    . "$ACODE_INIT_DIR/acode-install.sh"
else
    . "$ACODE_INIT_DIR/acode-launch.sh"
fi
