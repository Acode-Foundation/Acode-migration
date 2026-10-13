#include "AcodeUbuntu.h"
#include <stdio.h>
#include <stdlib.h>
#include "kernel/errno.h"
#include "kernel/init.h"
#include "kernel/signal.h"
#include "kernel/task.h"
#include "fs/devices.h"
#include "fs/tty.h"
#include "UbuntuSpawn.h"

// The guest side is a regular /dev/pts slave, so shells get job control,
// termios and SIGWINCH. The host side is this driver instead of a pty master,
// which keeps terminal I/O out of emulated sockets and polling.
struct UbuntuTerminal {
    struct tty *tty;
    int rows;
    int cols;
    void *context;
    UbuntuTerminalCallbacks callbacks;
    lock_t lock;
    cond_t drained;
    bool closed;
};

static int terminal_write(struct tty *tty, const void *data, size_t length, bool blocking);
static void terminal_cleanup(struct tty *tty);
static int attach_terminal(void *argument);

static const struct tty_driver_ops terminal_ops = {
    .write = terminal_write,
    .cleanup = terminal_cleanup,
};
// pty_open_fake fills in the slot table and major number.
static struct tty_driver terminal_driver = {.ops = &terminal_ops};

int ubuntu_terminal_start(const char *command, const char *environment, int rows, int cols,
                          void *context, UbuntuTerminalCallbacks callbacks, UbuntuTerminal **handle) {
    *handle = NULL;
    UbuntuTerminal *terminal = calloc(1, sizeof(UbuntuTerminal));
    if (terminal == NULL) { callbacks.release(context); return _ENOMEM; }
    *terminal = (UbuntuTerminal) {.rows = rows, .cols = cols, .context = context, .callbacks = callbacks};
    lock_init(&terminal->lock);
    cond_init(&terminal->drained);
    int pid = ubuntu_spawn(command, environment, attach_terminal, terminal);
    if (terminal->tty == NULL) {
        callbacks.release(context);
        cond_destroy(&terminal->drained);
        free(terminal);
    } else if (pid < 0) {
        ubuntu_terminal_close(terminal);
    } else {
        *handle = terminal;
    }
    return pid;
}

long ubuntu_terminal_input(UbuntuTerminal *terminal, const char *data, size_t length) {
    return tty_input(terminal->tty, data, length, false);
}

void ubuntu_terminal_resize(UbuntuTerminal *terminal, int rows, int cols) {
    struct tty *tty = terminal->tty;
    lock(&tty->lock);
    tty->winsize = (struct winsize_) {.row = rows, .col = cols};
    pid_t_ foreground = tty->fg_group;
    unlock(&tty->lock);
    if (foreground != 0) send_group_signal(foreground, SIGWINCH_, SIGINFO_NIL);
}

void ubuntu_terminal_drained(UbuntuTerminal *terminal) {
    lock(&terminal->lock);
    notify(&terminal->drained);
    unlock(&terminal->lock);
}

void ubuntu_terminal_close(UbuntuTerminal *terminal) {
    lock(&terminal->lock);
    terminal->closed = true;
    notify(&terminal->drained);
    unlock(&terminal->lock);
    struct tty *tty = terminal->tty;
    lock(&tty->lock);
    pid_t_ session = tty->session;
    pid_t_ foreground = tty->fg_group;
    tty_hangup(tty);
    unlock(&tty->lock);
    // Matches Linux when the master side of a pty goes away.
    if (foreground != 0) send_group_signal(foreground, SIGHUP_, SIGINFO_NIL);
    if (session != 0 && session != foreground) send_group_signal(session, SIGHUP_, SIGINFO_NIL);
    lock(&ttys_lock);
    tty_release(tty);
    unlock(&ttys_lock);
}

// Runs on guest threads. The tty lock may be held (echo), so it must not re-enter the tty.
// A blocking writer waits like on a full pipe while the client is behind. wait_for
// returns _EINTR for pending guest signals, so Ctrl-C and SIGKILL still get through,
// and nothing has been written yet when it does.
static int terminal_write(struct tty *tty, const void *data, size_t length, bool blocking) {
    UbuntuTerminal *terminal = tty->data;
    if (blocking) {
        int result = 0;
        lock(&terminal->lock);
        while (result == 0 && !terminal->closed && terminal->callbacks.congested(terminal->context)) {
            struct timespec recheck = {.tv_nsec = 100 * 1000 * 1000};
            result = wait_for(&terminal->drained, &terminal->lock, &recheck);
            if (result == _ETIMEDOUT) result = 0;
        }
        unlock(&terminal->lock);
        if (result < 0) return result;
    }
    terminal->callbacks.output(terminal->context, data, length);
    return 0;
}

// Runs once the host and every guest descriptor have released the tty.
static void terminal_cleanup(struct tty *tty) {
    UbuntuTerminal *terminal = tty->data;
    terminal->callbacks.release(terminal->context);
    cond_destroy(&terminal->drained);
    free(terminal);
}

// Runs as the new session leader, so opening the slave makes it the controlling tty.
static int attach_terminal(void *argument) {
    UbuntuTerminal *terminal = argument;
    struct tty *tty = pty_open_fake(&terminal_driver);
    if (IS_ERR(tty)) return (int) PTR_ERR(tty);
    tty->data = terminal;
    tty->winsize = (struct winsize_) {.row = terminal->rows, .col = terminal->cols};
    terminal->tty = tty;
    char path[32];
    snprintf(path, sizeof(path), "/dev/pts/%d", tty->num);
    return create_stdio(path, TTY_PSEUDO_SLAVE_MAJOR, tty->num);
}
