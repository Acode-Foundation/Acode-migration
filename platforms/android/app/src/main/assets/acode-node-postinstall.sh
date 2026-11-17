#!/bin/sh

# dpkg puts a real binary back on upgrade, so the ELF magic decides whether the
# wrapper is still needed.
[ -e /usr/bin/node ] || exit 0

# `file` is not part of this rootfs, so read the ELF magic as hex. -c renders
# the first byte as the character E, never as 177, which is why -tx1 is used.
[ "$(od -An -tx1 -N4 /usr/bin/node 2>/dev/null | tr -d ' \n')" = "7f454c46" ] || exit 0

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

# Two shells can launch at once, so only the first may rewrite /usr/bin/node.
# Without this a second run moves the wrapper the first one wrote over the real
# binary, leaving node.distrib pointing at itself.
LOCK=/tmp/.acode-node-hook.lock
mkdir "$LOCK" 2>/dev/null || exit 0
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

# Re-check inside the lock: the winner has already rewritten the binary.
[ "$(od -An -tx1 -N4 /usr/bin/node 2>/dev/null | tr -d ' \n')" = "7f454c46" ] || exit 0

printf '\033[33m[node-hook]\033[0m Wrapping /usr/bin/node with %s\n' "$JEMALLOC"

mv -f /usr/bin/node /usr/bin/node.distrib

printf '#!/bin/sh\nLD_PRELOAD=%s exec /usr/bin/node.distrib "$@"\n' "$JEMALLOC" > /usr/bin/node

chmod +x /usr/bin/node
