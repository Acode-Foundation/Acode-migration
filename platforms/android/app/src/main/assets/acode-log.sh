# Log helpers shared by the Ubuntu launcher modules.
#
# The install log is rendered by the app's xterm, which understands ANSI SGR
# even though the native bridge hands the script a pipe instead of a tty.
# NO_COLOR (https://no-color.org) and ACODE_NO_COLOR opt out.
#
# Sourced by init-ubuntu.sh; runs under /bin/sh (dash).

if [ -n "${NO_COLOR:-}" ] || [ -n "${ACODE_NO_COLOR:-}" ]; then
    LOG_STEP=""
    LOG_OK=""
    LOG_WARN=""
    LOG_ERROR=""
    LOG_RESET=""
else
    LOG_STEP='\033[36m'
    LOG_OK='\033[32m'
    LOG_WARN='\033[33m'
    LOG_ERROR='\033[31m'
    LOG_RESET='\033[0m'
fi

log_step() {
    printf '%b[*] %s%b\n' "$LOG_STEP" "$*" "$LOG_RESET"
}

log_ok() {
    printf '%b[+] %s%b\n' "$LOG_OK" "$*" "$LOG_RESET"
}

log_warn() {
    printf '%b[!] %s%b\n' "$LOG_WARN" "$*" "$LOG_RESET"
}

log_error() {
    printf '%b[!] %s%b\n' "$LOG_ERROR" "$*" "$LOG_RESET" >&2
}
