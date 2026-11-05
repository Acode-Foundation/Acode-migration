# Acode iOS Ubuntu runtime

The existing Acode xterm UI connects to the same AXS HTTP/WebSocket API used on
Android, and the guest is the same ARM64 Ubuntu 24.04 rootfs Android runs under
proot. ARM64 Linux programs run inside ios-linuxkit's interpreter; they are not
launched as unsigned iOS executables.

On iOS that API is served by the app, not by AXS inside the guest. Only the
shells are emulated:

```
xterm.js ──ws/http──▶ TerminalServer (Swift, 127.0.0.1:8767)
                         └─ TerminalSession ──▶ Bridge/UbuntuTerminal.c ──▶ /dev/pts/N ──▶ bash
```

`UbuntuTerminal.c` registers a tty driver whose output goes straight to Swift
and whose input, resize and hangup go straight to the guest tty. Terminal I/O
therefore never uses emulated sockets, epoll or threads, and the guest pty still
provides job control, termios and `SIGWINCH`. `init-ubuntu.sh --prepare` runs
once per boot; each terminal then starts `bash --rcfile /initrc -i` directly.
The AXS binary stays in the guest as `axs` for users and plugins.

The native Executor services use guest processes and pipes. Apple
Network.framework supplies the raw process WebSocket transport for
`Executor.spawnStream`.

## Sources

| Component | Pinned source |
| --- | --- |
| Kernel, ARM64 interpreter, fakefs | [rcarmo/ios-linuxkit](https://github.com/rcarmo/ios-linuxkit/tree/61719f8177499f789fc2f7f421ea919ac7780608), `61719f8177499f789fc2f7f421ea919ac7780608` |
| libarchive | `deps/libarchive` and `deps/config.h` from that same revision; BSD notices retained |
| AXS | [bajrangCoder/acodex_server v0.2.17](https://github.com/bajrangCoder/acodex_server/releases/tag/v0.2.17), asset `axs-musl-android-arm64` |
| Ubuntu rootfs | The existing Android ARM64 Ubuntu 24.04 asset, copied at build time |
| Shell setup | The existing Android `init-ubuntu.sh` and its `acode-*` modules, with `UBUNTU_ROOT=/` on iOS |

AXS SHA-256: `2f2f07e388fd5701eec4d008e67f2a9a2c05564dbd09a3fea96c9dc1cee42765`.
Its upstream Rust source revision is `2fb966607893e3b8f0e243d71c83a505c06951b3`.
To replace it, build the pinned source with `cross build --release --locked
--target aarch64-unknown-linux-musl`, or verify the published asset's checksum.

The vendored runtime includes its GPL attribution and iOS distribution exception.
`GPL-3.0.txt` contains the license text. Distributions linking this runtime must
provide corresponding source under the applicable GPL terms; existing notices
for Acode and other dependencies still apply.

## Build

On an Apple Silicon Mac, install `brew install meson ninja llvm lld`, then use the
normal Acode iOS commands or build in Xcode. The **Build Ubuntu** phase compiles
the static runtime and Linux VDSO, then copies the existing rootfs and setup
scripts into the app. No Meson build products or developer paths are committed.
`ACODE_BUILD_TOOLS` and `ACODE_LLD_BIN` can point to alternative tool directories.
ARM64 devices and ARM64 simulators are supported.

Both shared Xcode schemes load `Ubuntu/lldbinit` for Run and Test. It passes
`SIGUSR1` to the runtime without stopping the debugger; the runtime uses this signal
to wake guest threads. With LLDB's default handling, Xcode pauses the entire app
during installation, and returning to the paused app can show a black screen.
For an already-paused session, run `process handle -p true -s false -n false
SIGUSR1` in Xcode's debug console, then `continue`.

## Local adaptations

- `platform/darwin.c` imports Dispatch for `dispatch_once`.
- `meson.build` builds the selected upstream libarchive sources and Acode bridge;
  command-line utilities and upstream e2e tests are excluded from cross builds.
- `fs/fake.c` releases its host root descriptor and bind table when unmounted.
- `fs/real.c` translates Darwin directory-unlink `EPERM` to Linux `EISDIR`,
  allowing Bun to remove directory locks.
- `/proc/stat` includes all ten CPU counters and `/proc/<pid>/stat` reports
  immutable process start ticks for process inspection and daemon identity checks.
- `kernel/group.c` handles the last terminal session member exiting after its
  session leader has been reaped.
- Synchronous memory and illegal-instruction faults restore default handling if
  their signals are blocked or ignored, preventing infinite fault retries.
- ARM64 halfword lane loads and stores decode the lane index correctly, including
  post-indexed addressing. This fixes Bun's hybrid TLS key exchange failures.
- The code-cache page table has 65,536 buckets to reduce unrelated code
  invalidation during Bun's JIT writes, using 2 MiB per guest address space.
- Block-cache hashing removes ARM64 instruction-alignment bits so all existing
  buckets are used, without increasing cache allocation.
- `kernel/exit.c` clears the exiting leader's thread-local pointer before its
  parent can reap it, preventing pthread cleanup from accessing a freed task.
- `Bridge/UbuntuFaults.c` reuses upstream ARM64 fault recovery and delegates faults
  outside the guest to the app's previous signal handlers.
- `Bridge/UbuntuRuntime.c` owns guest init, stdio, process cleanup and mounts.
  SIGUSR1 is unblocked only while creating guest threads, then the host worker's
  signal mask is restored.
- `Bridge/UbuntuTerminal.c` connects guest pseudo-terminals to Swift through
  `pty_open_fake`, as iSH does for its terminal view.
- `ubuntu_suspend`/`ubuntu_resume` run upstream `sockrestart` when the app moves
  to the background and back, so guest servers keep their listening sockets.

Ubuntu's glibc userland needed these on top (musl never exercised them):

- `kernel/poll.c` accepts a NULL `pselect6` signal-mask argument, which glibc's
  `select()` passes. apt could not start its download methods.
- `kernel/fork.c` ignores `clone3`'s `pidfd` field without `CLONE_PIDFD`, as
  Linux does. glibc's `pthread_create` always fills it in, so no thread started.
- `kernel/fs.h` uses arm64's `O_DIRECTORY` value. The x86 value it had is
  arm64's `O_DIRECT`, so `O_DIRECTORY` opens of files succeeded and GNU `mv`
  moved files into themselves.
- `kernel/mmap.c` ignores per-page copy-on-write state when growing a mapping,
  so apt can grow its package cache after forking.
- `fs/fake.c` gives bind-mounted paths the same `st_dev` from `stat` as from
  `fstat`. GNU `cp` and `install` refused to copy out of Terminal Public or
  the app bundle, reporting the file as "replaced while being copied".
- `fs/fake.c` reports `d_type` from fakefs metadata. Symlinks and devices are
  regular files on the host; glibc's `ldconfig` aborted on the host type.
- `tools/fakefs.c` gives a synthesized root entry a directory type. The Ubuntu
  rootfs archive has no `./` entry, so `/` was neither file nor directory and
  dpkg refused to unpack.
- `sync_file_range` succeeds as a no-op writeback hint, like `sync`.
- Node.js no longer receives `--no-expose-wasm`: V8 14 (Node.js 26) removed the
  flag and refuses to start, and `--jitless` already hides WebAssembly.

The guest root lives at `Library/Ubuntu`, outside every host bind mount. Installing
Ubuntu removes the `Library/Alpine` root of earlier builds. `/public`,
`/home` and `/root` share Acode's Terminal Public directory. `/acode` maps app data,
and authorized Files roots are also mapped at their native paths for language
servers. Linux filesystem metadata is owned by fakefs; do not edit its `data/`
directory with FileManager. The `ubuntu://localhost/` filesystem provider performs
guest file operations through the existing Executor API. The setup scripts run
read-only from `/acode-assets`; the app copies `initrc`, the `acode` CLI and the
MOTD into the rootfs before every setup, as Android does. The Node.js jemalloc
wrapper is not installed on iOS, because the emulator applies its Node.js flags
only to an executable named `node`. npm derives its default global prefix from
`PREFIX` (`/acode`), so setup writes `/acode/etc/npmrc` with
`prefix=/usr/local`; `~/.npmrc` still takes precedence.

## Compatibility limits

This is Linux userspace emulation, not Android proot. apt packages run as ARM64
Linux programs, but support still depends on the emulator's instructions and
syscalls. As on Android, setup does not install Node.js: it only registers the
NodeSource repository and pins `nodejs` to it. Node.js 26 is installed on first
use, by a language server install or `apt install nodejs`. Upstream
forces Node to run without JIT and with a 512 MiB old-space limit; V8
WebAssembly and packages requiring unsupported syscalls may not work. Ubuntu's
own Node.js 18, installed instead when NodeSource was unreachable during setup,
prints V8's conflicting-flag warning for WebAssembly on startup.
Bun (including compiled CLIs such as OpenCode) keeps baseline JIT for FFI, while
optimizing/concurrent JIT and concurrent garbage collection are disabled through
`BUN_JSC_` guest settings. Ubuntu already ships procps, GNU `tar` and `gzip`,
which daemon-based CLIs and large archive extraction rely on. The upstream optional
WebAssembly polyfills are not bundled. iOS may suspend or terminate the app in
the background. PRoot debug mode has no effect on iOS.
Physical-device performance, memory pressure and background behavior need their
own validation.

fakefs stores guest files as host files, so the guest is only as case-sensitive
as the volume holding `Library/Ubuntu`. iOS data volumes are case-sensitive, but
the simulator stores app containers on the Mac's volume, which usually is not.
There, packages with names differing only in case fail to unpack: perl (needed
by git) ships both `Pod/` and `pod/`, and dpkg reports "Directory not empty".
Test such packages on a device or on a case-sensitive APFS volume. iOS backups preserve Linux metadata and exclude host mounts;
Android proot backup archives have a different layout, and backups of the
earlier iOS Alpine runtime are rejected.

### Pi coding agent

The npm package `pi` is a numeric calculator. The coding agent is
`@earendil-works/pi-coding-agent`. Its Node entry point requires WebAssembly,
so launch it explicitly with Bun on iOS:

```sh
npm uninstall -g pi # Only if the unrelated calculator was installed.
npm install -g bun@1.4.2
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.99.1
bun --bun "$(command -v pi)"
```

The published CLI's startup, terminal input, and a local streaming HTTP response
passed simulator checks with the official ARM64 musl Bun binary on the earlier
Alpine runtime. On Ubuntu, npm installs the glibc Bun build, which has not been
checked yet. Physical-device authentication, provider requests, and coding tasks
still need validation.
