#!/bin/bash
set -euo pipefail

ubuntu_dir=$(cd "$(dirname "$0")" && pwd)
printf '%s  %s\n' '2f2f07e388fd5701eec4d008e67f2a9a2c05564dbd09a3fea96c9dc1cee42765' "$ubuntu_dir/Assets/axs" | shasum -a 256 -c -
export PATH="${ACODE_BUILD_TOOLS:-/opt/homebrew/bin}:/usr/local/bin:$PATH"
export PATH="${ACODE_LLD_BIN:-/opt/homebrew/opt/lld/bin}:$PATH"
for tool in meson ninja ld.lld; do
    command -v "$tool" >/dev/null || { echo "error: Install the Linux runtime build tools: brew install meson ninja llvm lld"; exit 1; }
done

sdk=${SDKROOT:-$(xcrun --sdk iphonesimulator --show-sdk-path)}
platform=${PLATFORM_NAME:-iphonesimulator}
build_dir=${DERIVED_FILE_DIR:-"$ubuntu_dir/../../../.ios-build/ubuntu"}/Ubuntu-$platform
mkdir -p "$build_dir"
target="arm64-apple-ios${IPHONEOS_DEPLOYMENT_TARGET:-18.6}"
if [[ "$platform" == iphonesimulator ]]; then target="$target-simulator"; fi
if [[ "${ARCHS:-arm64}" != arm64 ]]; then
    echo "error: The Linux runtime requires an ARM64 device or Apple Silicon simulator."
    exit 1
fi

crossfile="$build_dir/cross.ini"
cat > "$crossfile.tmp" <<EOF
[binaries]
c = '/usr/bin/clang'
ar = '/usr/bin/ar'
[host_machine]
system = 'darwin'
cpu_family = 'aarch64'
cpu = 'arm64'
endian = 'little'
[built-in options]
c_args = ['-target', '$target', '-isysroot', '$sdk', '-D_XOPEN_SOURCE=700', '-D_DARWIN_C_SOURCE']
c_link_args = ['-target', '$target', '-isysroot', '$sdk']
[properties]
needs_exe_wrapper = true
sdk_path = '$sdk'
EOF
# Preserve timestamps so an unchanged Xcode build remains incremental.
if ! cmp -s "$crossfile.tmp" "$crossfile"; then mv "$crossfile.tmp" "$crossfile"; else rm "$crossfile.tmp"; fi
export CC_FOR_BUILD=/usr/bin/clang
if [[ ! -f "$build_dir/build.ninja" ]]; then
    meson setup "$build_dir" "$ubuntu_dir/Vendor/ios-linuxkit" --cross-file "$crossfile" -Dbuildtype=release
fi
ninja -C "$build_dir" libish.a libish_emu.a libfakefs.a libacode_ubuntu.a libacode_archive.a
test -s "$build_dir/vdso/arm64/libvdso.so.elf" || { echo "error: ARM64 Linux VDSO was not built. Install llvm and lld."; exit 1; }
archives=("$build_dir/libacode_ubuntu.a" "$build_dir/libish.a" "$build_dir/libish_emu.a" "$build_dir/libfakefs.a" "$build_dir/libacode_archive.a")
for archive in "${archives[@]}"; do
    if [[ "$archive" -nt "$build_dir/libAcodeUbuntu.a" ]]; then
        /usr/bin/libtool -static -o "$build_dir/libAcodeUbuntu.a" "${archives[@]}"
        break
    fi
done

if [[ -n "${TARGET_BUILD_DIR:-}" ]]; then
    bundle="$TARGET_BUILD_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH"
    resources="$bundle/Ubuntu"
    # Incremental builds keep files a previous build copied, including the
    # pre-Ubuntu Alpine runtime.
    rm -rf "$resources" "$bundle/Alpine"
    mkdir -p "$resources"
    android_assets="$ubuntu_dir/../../android/app/src/main/assets"
    cp "$ubuntu_dir/../../android/app/src/store/assets/arm64/ubuntu.rootfs" "$resources/ubuntu.rootfs"
    # The Android launcher and its modules, plus the files the app writes into
    # the rootfs. iOS skips the Node.js jemalloc hook: the emulator applies its
    # Node.js flags by executable name, which the hook's wrapper would change.
    for asset in init-ubuntu.sh acode-log.sh acode-groups.sh acode-timezone.sh acode-node.sh \
        acode-install.sh acode-launch.sh acode-initrc acode-cli acode-motd; do
        cp "$android_assets/$asset" "$resources/$asset"
    done
    cp "$ubuntu_dir/Assets/axs" "$resources/axs"
    cp "$ubuntu_dir/Vendor/ios-linuxkit/LICENSE.md" "$resources/ios-linuxkit-LICENSE.md"
    cp "$ubuntu_dir/Vendor/ios-linuxkit/LICENSE.IOS" "$resources/LICENSE.IOS"
    cp "$ubuntu_dir/GPL-3.0.txt" "$resources/GPL-3.0.txt"
    cp "$ubuntu_dir/Vendor/ios-linuxkit/deps/libarchive/COPYING" "$resources/libarchive-COPYING"
    cp "$ubuntu_dir/README.md" "$resources/README.md"
fi
