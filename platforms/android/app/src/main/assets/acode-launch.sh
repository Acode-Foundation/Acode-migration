# Per-launch preparation and AXS startup.
#
# Sourced by init-ubuntu.sh for every interactive launch; runs under /bin/sh
# (dash). The generated shell files are already in the rootfs, written by the
# app, so this module only refreshes the runtime state.

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
# any group Android grants later) without reinstalling the sandbox, and so a
# dpkg upgrade that restores the real node binary is re-wrapped.
register_android_groups
sync_timezone
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
