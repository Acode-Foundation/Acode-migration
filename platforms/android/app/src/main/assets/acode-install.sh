# One-time rootfs installation.
#
# Sourced by init-ubuntu.sh only for --installing; runs under /bin/sh (dash).
# Normal launches must NEVER run apt.
#
# The app writes the generated shell files (initrc, the acode CLI, the MOTD and
# the Node.js jemalloc hook) into the rootfs before this runs, so only the
# package and layout work is left here.

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

# Registered before the package lists are fetched below, so that one update
# covers NodeSource too.
log_step "Configuring the Node.js package repository..."
configure_nodesource_repo
log_ok "Node.js package repository ready"

# tzdata lets /etc/localtime resolve and libjemalloc2 backs the Node.js
# wrapper. Best effort and time-bounded so an offline install still works.
# Setup reaches the network here, for the package lists and NodeSource.
# The app only installs the wrapper where it is needed (not on iOS, whose
# emulator recognises Node.js by its file name).

APT_PACKAGES=""
[ -d /usr/share/zoneinfo ] || APT_PACKAGES="tzdata"
if [ -x /usr/local/bin/node-postinstall.sh ] && ! dpkg -s libjemalloc2 >/dev/null 2>&1; then
    APT_PACKAGES="$APT_PACKAGES libjemalloc2"
fi

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
configure_npm_prefix
run_node_jemalloc_hook
log_ok "Timezone and Node.js runtime configured"

# --------------------------------------------------------
# Rootfs filesystem setup
# --------------------------------------------------------

log_step "Preparing rootfs layout..."

# proot binds Android's linker config here when the device has one.
if [ "$UBUNTU_ROOT" != "/" ]; then
    mkdir -p /linkerconfig

    if [ ! -f /linkerconfig/ld.config.txt ]; then
        touch /linkerconfig/ld.config.txt
    fi
fi

mkdir -p "$HOME"

if [ ! -f "$HOME/.bashrc" ]; then
    touch "$HOME/.bashrc" && chmod 644 "$HOME/.bashrc"
fi

# --------------------------------------------------------
# Register the Android GIDs so `groups`/`id` can name them
# --------------------------------------------------------

if [ "$UBUNTU_ROOT" != "/" ]; then
    log_step "Registering Android groups..."
    register_android_groups
    log_ok "Android groups registered"
fi

# --------------------------------------------------------
# Mark rootfs as configured
# --------------------------------------------------------

mkdir -p "$PREFIX/.configured"

touch "$PREFIX/.configured/rootfs"

# The install path reports success purely from this exit code, so verify the
# artifacts actually landed instead of announcing completion unconditionally.
missing=""
for required in \
    "${UBUNTU_ROOT%/}/bin/sh" \
    "${UBUNTU_ROOT%/}/bin/bash" \
    "${UBUNTU_ROOT%/}/etc/group" \
    "${UBUNTU_ROOT%/}/initrc" \
    "${UBUNTU_ROOT%/}/usr/local/bin/acode" \
    "$PREFIX/.configured/rootfs"; do
    [ -e "$required" ] || missing="$missing $required"
done

if [ -n "$missing" ]; then
    log_error "Rootfs configuration incomplete, missing:$missing"
    exit 1
fi

log_ok "Rootfs configuration complete."
exit 0
