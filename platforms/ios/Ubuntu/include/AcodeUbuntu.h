#pragma once
#include <stdbool.h>
#include <stddef.h>

typedef void (*UbuntuExitCallback)(int pid, int status);
typedef struct UbuntuTerminal UbuntuTerminal;
// `output` and `congested` run on guest threads. `congested` tells blocking writers
// to wait until ubuntu_terminal_drained; `release` runs once the terminal is gone.
typedef struct {
    void (*output)(void *context, const char *data, size_t length);
    bool (*congested)(void *context);
    void (*release)(void *context);
} UbuntuTerminalCallbacks;

// Calls that access guest state are serialized by UbuntuRuntime.queue.
int ubuntu_boot(const char *root, UbuntuExitCallback callback);
int ubuntu_bind(const char *guest, const char *host, bool readOnly);
int ubuntu_chmod(const char *path, unsigned int mode);
int ubuntu_start(const char *command, const char *environment, int input, int output, int error);
int ubuntu_kill(int pid);
bool ubuntu_running(int pid);
void ubuntu_reap(void);
void ubuntu_stop_all(void);
bool ubuntu_idle(void);
int ubuntu_unmount(void);
bool ubuntu_import(const char *archive, const char *root, char *error, size_t capacity);
void ubuntu_install_fault_handlers(void);
// Recreate guest listening sockets that iOS reclaims while the app is suspended.
void ubuntu_suspend(void);
void ubuntu_resume(void);

// Runs a command on a new pseudo-terminal and returns its pid. The context is
// owned by the terminal from this call on, including when starting fails.
int ubuntu_terminal_start(const char *command, const char *environment, int rows, int cols,
                          void *context, UbuntuTerminalCallbacks callbacks, UbuntuTerminal **terminal);
// Input, resize, drained and close are thread-safe and do not need UbuntuRuntime.queue.
long ubuntu_terminal_input(UbuntuTerminal *terminal, const char *data, size_t length);
void ubuntu_terminal_resize(UbuntuTerminal *terminal, int rows, int cols);
void ubuntu_terminal_drained(UbuntuTerminal *terminal);
// Releases waiting writers, hangs up the session and drops the host's reference;
// the handle is invalid afterwards.
void ubuntu_terminal_close(UbuntuTerminal *terminal);
