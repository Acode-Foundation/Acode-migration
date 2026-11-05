# Node.js runtime wiring for the Ubuntu rootfs.
#
# Sourced by init-ubuntu.sh; runs under /bin/sh (dash). The files this module
# installs (the jemalloc wrapper and the dpkg hook that calls it) are written
# into the rootfs by the app before the install runs, so this module only has
# to invoke and register them. ACODE_NODE_MAJOR and the ACODE_APT_* paths come
# from the entry script.

# Ubuntu 24.04 ships nodejs 18, which is past end of life, so anything the
# npm-based LSP installs need gets an unsupported runtime. This registers the
# NodeSource repository the way deb.nodesource.com/setup_26.x does, but inline:
# the published script is not used because it runs `apt update`, installs
# pre-requisites and rewrites the key on every run, while this only has to
# happen on the install path. The apt pin keeps `apt install nodejs` on
# NodeSource.
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

    # The install path starts from a fresh rootfs, so the sources file decides
    # whether this is the first pass; there is no version to track.
    if [ ! -e "$ACODE_APT_SOURCES" ]; then
        log_step "Installing the NodeSource signing key..."

        # The bundled rootfs ships empty package lists, so apt cannot install
        # curl/gnupg until the lists have been fetched once.
        if ! apt-get update; then
            log_warn "Could not update package lists - keeping Ubuntu's nodejs"
            return 0
        fi

        # curl/gnupg are what the rootfs may still be missing.
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

# dpkg puts a real binary back on upgrade, so the wrapper is re-applied on the
# install path and on every launch.
run_node_jemalloc_hook() {
    [ -x /usr/local/bin/node-postinstall.sh ] || return 0

    /usr/local/bin/node-postinstall.sh
}
