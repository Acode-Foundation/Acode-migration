# proot

Builds the PRoot compatibility layer and its loaders from source with the
Android NDK, so every flavor (including `fdroid`) ships them inside the APK
instead of downloading prebuilt binaries at runtime.

## Sources

- `src/main/cpp`: PRoot, ported from the Xed-Editor Android module
  (`features/terminal/proot`), which is derived from
  [termux/proot](https://github.com/termux/proot). GPL-2.0-or-later.
- `src/main/cpp/talloc`: Samba talloc, bundled and linked statically into
  `libproot.so`. LGPL-3.0-or-later.

## Outputs

`externalNativeBuild` produces three executables per ABI, packaged as JNI
libraries and extracted at install time (`useLegacyPackaging = true`):

| Library | Role |
| --- | --- |
| `libproot.so` | PRoot binary |
| `libloader.so` | 64-bit loader |
| `libloader32.so` | 32-bit loader (arm64-v8a and x86_64 only) |

`CMakeLists.txt` defines `PROOT_UNBUNDLE_LOADER`, so `libproot.so` does not embed
the loaders. `app/src/main/assets/init-sandbox.sh` points `PROOT`,
`PROOT_LOADER` and `PROOT_LOADER_32` at `$NATIVE_DIR` accordingly.