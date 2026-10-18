// plastile-keytap: timestamped key-chord injector for Plastile's physical latency harness
// (docs/validation/PHYSICAL_RUNBOOK.md, tools/physical/orchestrate.py).
//
// Exactly one backend is chosen explicitly:
//   --backend uinput   Create a virtual keyboard through /dev/uinput (linux/uinput.h). Its events
//                      enter the kernel input stack and reach the compositor of the active seat,
//                      exactly like a USB keyboard. Before opening /dev/uinput it refuses to run
//                      unless XDG_SESSION_TYPE=wayland and the WAYLAND_DISPLAY socket is served by
//                      a non-nested kwin_wayland (or its kwin_wayland_wrapper) of the same user.
//   --backend dry      No device at all: exercises the protocol and timing path only (tests).
//   --backend libei --ei-fd N
//                      Only in the plastile-keytap-ei build (make ei; needs libei). Emits through
//                      an EIS socket that one specific KWin handed out
//                      (org.kde.KWin.EIS.RemoteDesktop.connectToEIS), so it can reach only that
//                      compositor. Used for nested dry runs in tools/physical/nested_dryrun.py.
//
// Commands on stdin, one per line:
//   tap ID MODS KEY    Press MODS (comma-separated evdev codes, at least one of KEY_LEFTMETA=125 or
//                      KEY_RIGHTMETA=126), press KEY, release KEY, release MODS in reverse order.
//                      ID is an opaque token (letters, digits, - _ . :) echoed in the output.
//   ping               Print a pong record with the current CLOCK_MONOTONIC time.
//   quit               Release everything, destroy the device and exit.
// End of input, SIGINT, SIGTERM and SIGHUP behave like quit. A tap in progress is completed (its
// key releases are always sent) before a signal is acted on.
//
// Output: JSON Lines on stdout, flushed per line: ready, tap, pong, error, exit.
//   t_input_ns      CLOCK_MONOTONIC read immediately before the write() carrying KEY's press and its
//                   SYN_REPORT (uinput), or before the libei key event (libei).
//   t_write_end_ns  CLOCK_MONOTONIC read after that write() returned (uinput) or after ei_dispatch()
//                   flushed the frame (libei). For uinput the kernel's evdev timestamp of the press
//                   lies between t_input_ns and t_write_end_ns.
// Only keyboard key codes 1..248 are accepted. Every tap must carry a Meta modifier so that a key
// that is not bound as a global shortcut cannot type text into the focused application.
#define _GNU_SOURCE
#include <ctype.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/input-event-codes.h>
#include <linux/input.h>
#include <linux/uinput.h>
#include <poll.h>
#include <signal.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>
#ifdef KEYTAP_LIBEI
#include <libei.h>
#endif

#define MAX_MODS 4
#define MAX_KEYCODE KEY_MICMUTE /* 248: end of the ordinary keyboard range */
#define LINE_MAX_LEN 512

enum backend { BACKEND_NONE, BACKEND_DRY, BACKEND_UINPUT, BACKEND_LIBEI };

enum exit_code { EXIT_OK = 0, EXIT_USAGE = 2, EXIT_GUARD = 3, EXIT_DEVICE = 4, EXIT_IO = 5 };

static volatile sig_atomic_t g_stop;
static enum backend g_backend = BACKEND_NONE;
static int g_ufd = -1;
static bool g_device_created;
static int g_pressed[MAX_MODS + 1];
static int g_npressed;
static unsigned long g_taps;
static unsigned long g_max_taps = 200000;
static unsigned g_settle_ms = 1000, g_hold_ms = 12, g_gap_ms = 4, g_min_interval_ms = 40;
static uint64_t g_last_tap_ns;
static unsigned long long g_res_ns;
static bool g_ready;
static char g_device_name[UINPUT_MAX_NAME_SIZE] = "plastile-keytap";
#ifdef KEYTAP_LIBEI
static struct ei *g_ei;
static struct ei_device *g_kbd;
static int g_ei_fd = -1;
static uint32_t g_ei_seq;
#endif

static uint64_t now_ns(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64_t)ts.tv_sec * 1000000000ull + (uint64_t)ts.tv_nsec;
}

static void sleep_ms(unsigned ms)
{
    struct timespec ts = { .tv_sec = ms / 1000, .tv_nsec = (long)(ms % 1000) * 1000000L };
    while (nanosleep(&ts, &ts) != 0 && errno == EINTR) {
    }
}

static void out(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
static void out(const char *fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);
    vprintf(fmt, ap);
    va_end(ap);
    putchar('\n');
    if (fflush(stdout) != 0) {
        g_stop = SIGPIPE; // reader went away: stop after cleanup
    }
}

// Copy `s` into `dst` as JSON string contents (without quotes).
static void json_escape(char *dst, size_t cap, const char *s)
{
    size_t o = 0;
    for (; *s && o + 7 < cap; ++s) {
        unsigned char c = (unsigned char)*s;
        if (c == '"' || c == '\\') {
            dst[o++] = '\\';
            dst[o++] = (char)c;
        } else if (c < 0x20 || c == 0x7f) {
            o += (size_t)snprintf(dst + o, cap - o, "\\u%04x", c);
        } else {
            dst[o++] = (char)c;
        }
    }
    dst[o] = '\0';
}

static void out_error(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
static void out_error(const char *fmt, ...)
{
    char msg[LINE_MAX_LEN + 128], esc[sizeof msg * 6 + 1];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(msg, sizeof msg, fmt, ap);
    va_end(ap);
    json_escape(esc, sizeof esc, msg);
    out("{\"ev\":\"error\",\"t_ns\":%llu,\"msg\":\"%s\"}", (unsigned long long)now_ns(), esc);
}

static const char *backend_name(void)
{
    switch (g_backend) {
    case BACKEND_DRY: return "dry";
    case BACKEND_UINPUT: return "uinput";
    case BACKEND_LIBEI: return "libei";
    default: return "none";
    }
}

// ------------------------------------------------------------------ session guard (uinput)

static int read_small(const char *path, char *buf, size_t cap, size_t *len_out)
{
    int fd = open(path, O_RDONLY | O_CLOEXEC);
    if (fd < 0) return -1;
    size_t len = 0;
    while (len + 1 < cap) {
        ssize_t n = read(fd, buf + len, cap - 1 - len);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) break;
        len += (size_t)n;
    }
    close(fd);
    buf[len] = '\0';
    if (len_out) *len_out = len;
    return 0;
}

static int proc_comm(pid_t pid, char *buf, size_t cap)
{
    char path[64];
    snprintf(path, sizeof path, "/proc/%d/comm", (int)pid);
    if (read_small(path, buf, cap, NULL) != 0) return -1;
    buf[strcspn(buf, "\n")] = '\0';
    return 0;
}

static pid_t proc_ppid(pid_t pid)
{
    char path[64], buf[1024];
    snprintf(path, sizeof path, "/proc/%d/stat", (int)pid);
    if (read_small(path, buf, sizeof buf, NULL) != 0) return -1;
    const char *p = strrchr(buf, ')'); // comm may contain spaces and parentheses
    if (!p) return -1;
    char state;
    int ppid;
    if (sscanf(p + 1, " %c %d", &state, &ppid) != 2) return -1;
    return (pid_t)ppid;
}

// kwin_wayland_wrapper owns the listening socket and runs kwin_wayland as its child.
static pid_t find_child_named(pid_t parent, const char *name)
{
    DIR *d = opendir("/proc");
    if (!d) return -1;
    struct dirent *e;
    pid_t found = -1;
    while ((e = readdir(d))) {
        if (!isdigit((unsigned char)e->d_name[0])) continue;
        pid_t pid = (pid_t)atoi(e->d_name);
        char comm[64];
        if (proc_ppid(pid) == parent && proc_comm(pid, comm, sizeof comm) == 0 && strcmp(comm, name) == 0) {
            found = pid;
            break;
        }
    }
    closedir(d);
    return found;
}

static int guard_session(char *why, size_t cap, pid_t *kwin_out)
{
    const char *st = getenv("XDG_SESSION_TYPE");
    if (!st || strcmp(st, "wayland") != 0) {
        snprintf(why, cap, "XDG_SESSION_TYPE is '%s', not 'wayland'", st ? st : "(unset)");
        return -1;
    }
    const char *wd = getenv("WAYLAND_DISPLAY");
    if (!wd || !*wd) {
        snprintf(why, cap, "WAYLAND_DISPLAY is not set");
        return -1;
    }
    struct sockaddr_un addr = { .sun_family = AF_UNIX };
    int n;
    if (wd[0] == '/') {
        n = snprintf(addr.sun_path, sizeof addr.sun_path, "%s", wd);
    } else {
        const char *rt = getenv("XDG_RUNTIME_DIR");
        if (!rt || !*rt) {
            snprintf(why, cap, "XDG_RUNTIME_DIR is not set");
            return -1;
        }
        n = snprintf(addr.sun_path, sizeof addr.sun_path, "%s/%s", rt, wd);
    }
    if (n < 0 || (size_t)n >= sizeof addr.sun_path) {
        snprintf(why, cap, "Wayland socket path is too long");
        return -1;
    }
    int s = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (s < 0 || connect(s, (struct sockaddr *)&addr, sizeof addr) != 0) {
        snprintf(why, cap, "cannot connect to Wayland socket %s: %s", addr.sun_path, strerror(errno));
        if (s >= 0) close(s);
        return -1;
    }
    struct ucred cred;
    socklen_t len = sizeof cred;
    int rc = getsockopt(s, SOL_SOCKET, SO_PEERCRED, &cred, &len);
    close(s);
    if (rc != 0) {
        snprintf(why, cap, "SO_PEERCRED failed: %s", strerror(errno));
        return -1;
    }
    if (cred.uid != getuid()) {
        snprintf(why, cap, "the compositor runs as uid %d, this process as uid %d (do not run this tool with sudo)",
                 (int)cred.uid, (int)getuid());
        return -1;
    }
    char comm[64];
    if (proc_comm(cred.pid, comm, sizeof comm) != 0) {
        snprintf(why, cap, "cannot read /proc/%d/comm", (int)cred.pid);
        return -1;
    }
    pid_t kwin = -1;
    if (strcmp(comm, "kwin_wayland") == 0) {
        kwin = cred.pid;
    } else if (strcmp(comm, "kwin_wayland_wr") == 0) { // comm is truncated to 15 characters
        kwin = find_child_named(cred.pid, "kwin_wayland");
        if (kwin < 0) {
            snprintf(why, cap, "kwin_wayland_wrapper (pid %d) has no kwin_wayland child", (int)cred.pid);
            return -1;
        }
    } else {
        snprintf(why, cap, "the Wayland compositor is '%s' (pid %d), not KWin", comm, (int)cred.pid);
        return -1;
    }
    char path[64], cmdline[8192];
    size_t clen = 0;
    snprintf(path, sizeof path, "/proc/%d/cmdline", (int)kwin);
    if (read_small(path, cmdline, sizeof cmdline, &clen) != 0 || clen == 0) {
        snprintf(why, cap, "cannot read the command line of kwin_wayland (pid %d)", (int)kwin);
        return -1;
    }
    static const char *const nested_flags[] = { "--virtual", "--wayland-display", "--x11-display" };
    for (size_t off = 0; off < clen; off += strlen(cmdline + off) + 1) {
        for (size_t i = 0; i < sizeof nested_flags / sizeof nested_flags[0]; ++i) {
            size_t fl = strlen(nested_flags[i]);
            if (strncmp(cmdline + off, nested_flags[i], fl) == 0 && (cmdline[off + fl] == '\0' || cmdline[off + fl] == '=')) {
                snprintf(why, cap, "kwin_wayland (pid %d) runs nested (%s): uinput would reach the host session instead",
                         (int)kwin, nested_flags[i]);
                return -1;
            }
        }
    }
    *kwin_out = kwin;
    return 0;
}

// ------------------------------------------------------------------------------- backends

static int uinput_open(void)
{
    g_ufd = open("/dev/uinput", O_WRONLY | O_NONBLOCK | O_CLOEXEC);
    if (g_ufd < 0) {
        out_error("cannot open /dev/uinput: %s (see PHYSICAL_RUNBOOK.md: uinput access)", strerror(errno));
        return -1;
    }
    if (ioctl(g_ufd, UI_SET_EVBIT, EV_KEY) < 0 || ioctl(g_ufd, UI_SET_EVBIT, EV_SYN) < 0) {
        out_error("UI_SET_EVBIT failed: %s", strerror(errno));
        return -1;
    }
    // Advertise a full keyboard so udev/libinput classify the device as a keyboard.
    for (int k = 1; k <= MAX_KEYCODE; ++k) {
        if (ioctl(g_ufd, UI_SET_KEYBIT, k) < 0) {
            out_error("UI_SET_KEYBIT %d failed: %s", k, strerror(errno));
            return -1;
        }
    }
    struct uinput_setup us;
    memset(&us, 0, sizeof us);
    us.id.bustype = BUS_VIRTUAL;
    us.id.vendor = 0x504c;  // "PL"
    us.id.product = 0x4b54; // "KT"
    us.id.version = 1;
    snprintf(us.name, sizeof us.name, "%s", g_device_name);
    if (ioctl(g_ufd, UI_DEV_SETUP, &us) < 0 || ioctl(g_ufd, UI_DEV_CREATE) < 0) {
        out_error("creating the uinput device failed: %s", strerror(errno));
        return -1;
    }
    g_device_created = true;
    sleep_ms(g_settle_ms); // let udev and the compositor's libinput add the device
    return 0;
}

static int write_all(const void *buf, size_t len)
{
    ssize_t w;
    do {
        w = write(g_ufd, buf, len);
    } while (w < 0 && errno == EINTR);
    return w == (ssize_t)len ? 0 : -1;
}

// One packet: n key events with the same value, then SYN_REPORT.
static int send_keys(const int *codes, int n, int value)
{
    if (g_backend == BACKEND_DRY) return 0;
    if (g_backend == BACKEND_UINPUT) {
        struct input_event evs[MAX_MODS + 2];
        memset(evs, 0, sizeof evs);
        for (int i = 0; i < n; ++i) {
            evs[i].type = EV_KEY;
            evs[i].code = (unsigned short)codes[i];
            evs[i].value = value;
        }
        evs[n].type = EV_SYN;
        evs[n].code = SYN_REPORT;
        return write_all(evs, sizeof evs[0] * (size_t)(n + 1));
    }
#ifdef KEYTAP_LIBEI
    if (g_backend == BACKEND_LIBEI) {
        if (!g_kbd) return -1;
        for (int i = 0; i < n; ++i) ei_device_keyboard_key(g_kbd, (uint32_t)codes[i], value != 0);
        ei_device_frame(g_kbd, ei_now(g_ei));
        ei_dispatch(g_ei); // flush the frame to the socket
        return 0;
    }
#endif
    return -1;
}

static void pressed_add(int code)
{
    if (g_npressed < MAX_MODS + 1) g_pressed[g_npressed++] = code;
}

static void pressed_remove(int code)
{
    for (int i = 0; i < g_npressed; ++i) {
        if (g_pressed[i] == code) {
            g_pressed[i] = g_pressed[--g_npressed];
            return;
        }
    }
}

// Best effort: release every key this process still holds, newest first.
static void release_all(void)
{
    while (g_npressed > 0) {
        int code = g_pressed[--g_npressed];
        send_keys(&code, 1, 0);
    }
}

static void cleanup(void)
{
    release_all();
    if (g_ufd >= 0) {
        if (g_device_created) ioctl(g_ufd, UI_DEV_DESTROY);
        close(g_ufd);
        g_ufd = -1;
        g_device_created = false;
    }
#ifdef KEYTAP_LIBEI
    if (g_kbd) {
        ei_device_stop_emulating(g_kbd);
        ei_device_unref(g_kbd);
        g_kbd = NULL;
    }
    if (g_ei) {
        ei_dispatch(g_ei);
        ei_unref(g_ei);
        g_ei = NULL;
    }
#endif
}

#ifdef KEYTAP_LIBEI
static void ei_handle(void)
{
    struct ei_event *ev;
    while ((ev = ei_get_event(g_ei))) {
        switch (ei_event_get_type(ev)) {
        case EI_EVENT_SEAT_ADDED:
            ei_seat_bind_capabilities(ei_event_get_seat(ev), EI_DEVICE_CAP_KEYBOARD, NULL);
            break;
        case EI_EVENT_DEVICE_ADDED: {
            struct ei_device *d = ei_event_get_device(ev);
            if (!g_kbd && ei_device_has_capability(d, EI_DEVICE_CAP_KEYBOARD)) g_kbd = ei_device_ref(d);
            break;
        }
        case EI_EVENT_DEVICE_RESUMED:
            if (ei_event_get_device(ev) == g_kbd) {
                ei_device_start_emulating(g_kbd, ++g_ei_seq);
                if (!g_ready) {
                    g_ready = true;
                    out("{\"ev\":\"ready\",\"backend\":\"libei\",\"t_ns\":%llu,\"clock\":\"CLOCK_MONOTONIC\","
                        "\"clock_res_ns\":%llu,\"hold_ms\":%u,\"gap_ms\":%u,\"min_interval_ms\":%u,\"pid\":%d}",
                        (unsigned long long)now_ns(), g_res_ns, g_hold_ms, g_gap_ms, g_min_interval_ms, (int)getpid());
                }
            }
            break;
        case EI_EVENT_DEVICE_PAUSED:
            if (ei_event_get_device(ev) == g_kbd) out_error("libei keyboard paused by the compositor");
            break;
        case EI_EVENT_DISCONNECT:
            out_error("EIS disconnected");
            g_stop = SIGHUP;
            break;
        default:
            break;
        }
        ei_event_unref(ev);
    }
}
#endif

// -------------------------------------------------------------------------------- commands

static bool valid_id(const char *s)
{
    size_t n = strlen(s);
    if (n == 0 || n > 63) return false;
    for (; *s; ++s) {
        if (!isalnum((unsigned char)*s) && !strchr("-_.:", *s)) return false;
    }
    return true;
}

static int parse_code(const char *s, int *out_code)
{
    char *end;
    errno = 0;
    long v = strtol(s, &end, 10);
    if (errno || end == s || *end || v < 1 || v > MAX_KEYCODE) return -1;
    *out_code = (int)v;
    return 0;
}

static void do_tap(char *id, char *mods_s, char *key_s)
{
    int mods[MAX_MODS], nmods = 0, key;
    if (!valid_id(id)) {
        out_error("tap: invalid id");
        return;
    }
    if (strcmp(mods_s, "-") != 0) {
        char *save = NULL;
        for (char *tok = strtok_r(mods_s, ",", &save); tok; tok = strtok_r(NULL, ",", &save)) {
            if (nmods == MAX_MODS || parse_code(tok, &mods[nmods]) != 0) {
                out_error("tap %s: bad modifier list", id);
                return;
            }
            for (int i = 0; i < nmods; ++i) {
                if (mods[i] == mods[nmods]) {
                    out_error("tap %s: duplicate modifier %d", id, mods[nmods]);
                    return;
                }
            }
            ++nmods;
        }
    }
    if (parse_code(key_s, &key) != 0) {
        out_error("tap %s: bad key code '%s' (1..%d)", id, key_s, MAX_KEYCODE);
        return;
    }
    bool meta = false;
    for (int i = 0; i < nmods; ++i) {
        if (mods[i] == KEY_LEFTMETA || mods[i] == KEY_RIGHTMETA) meta = true;
        if (mods[i] == key) {
            out_error("tap %s: key %d is also listed as a modifier", id, key);
            return;
        }
    }
    if (!meta) {
        out_error("tap %s: refused: every tap needs a Meta modifier (125 or 126)", id);
        return;
    }
    if (!g_ready) {
        out_error("tap %s: device not ready", id);
        return;
    }
    if (g_taps >= g_max_taps) {
        out_error("tap %s: refused: --max-taps %lu reached", id, g_max_taps);
        return;
    }
    uint64_t t = now_ns();
    if (g_last_tap_ns && t - g_last_tap_ns < (uint64_t)g_min_interval_ms * 1000000ull) {
        out_error("tap %s: refused: closer than --min-interval-ms %u to the previous tap", id, g_min_interval_ms);
        return;
    }

    // The press/release sequence is never interrupted by a signal: keys must not stay down.
    sigset_t block, old;
    sigemptyset(&block);
    sigaddset(&block, SIGINT);
    sigaddset(&block, SIGTERM);
    sigaddset(&block, SIGHUP);
    sigprocmask(SIG_BLOCK, &block, &old);
    uint64_t t_input = 0, t_end = 0, t_rel = 0;
    bool ok = true;
    if (nmods) {
        ok = send_keys(mods, nmods, 1) == 0;
        if (ok) {
            for (int i = 0; i < nmods; ++i) pressed_add(mods[i]);
            sleep_ms(g_gap_ms);
        }
    }
    if (ok) {
        t_input = now_ns();
        ok = send_keys(&key, 1, 1) == 0;
        t_end = now_ns();
    }
    if (ok) {
        pressed_add(key);
        sleep_ms(g_hold_ms);
        ok = send_keys(&key, 1, 0) == 0;
        t_rel = now_ns();
        if (ok) pressed_remove(key);
    }
    if (ok && nmods) {
        int rev[MAX_MODS];
        for (int i = 0; i < nmods; ++i) rev[i] = mods[nmods - 1 - i];
        sleep_ms(g_gap_ms);
        ok = send_keys(rev, nmods, 0) == 0;
        if (ok) {
            for (int i = 0; i < nmods; ++i) pressed_remove(mods[i]);
        }
    }
    if (!ok) {
        int err = errno;
        release_all();
        sigprocmask(SIG_SETMASK, &old, NULL);
        out_error("tap %s: write failed: %s", id, strerror(err));
        g_stop = SIGHUP;
        return;
    }
    sigprocmask(SIG_SETMASK, &old, NULL);
    g_last_tap_ns = t_input;
    ++g_taps;
    char modlist[64] = "";
    size_t o = 0;
    for (int i = 0; i < nmods; ++i) o += (size_t)snprintf(modlist + o, sizeof modlist - o, "%s%d", i ? "," : "", mods[i]);
    out("{\"ev\":\"tap\",\"id\":\"%s\",\"backend\":\"%s\",\"mods\":[%s],\"key\":%d,\"t_input_ns\":%llu,"
        "\"t_write_end_ns\":%llu,\"t_release_ns\":%llu,\"n\":%lu}",
        id, backend_name(), modlist, key, (unsigned long long)t_input, (unsigned long long)t_end,
        (unsigned long long)t_rel, g_taps);
}

static void handle_line(char *line)
{
    line[strcspn(line, "\r\n")] = '\0';
    char *save = NULL;
    char *cmd = strtok_r(line, " \t", &save);
    if (!cmd) return;
    if (strcmp(cmd, "tap") == 0) {
        char *id = strtok_r(NULL, " \t", &save);
        char *mods = strtok_r(NULL, " \t", &save);
        char *key = strtok_r(NULL, " \t", &save);
        if (!id || !mods || !key || strtok_r(NULL, " \t", &save)) {
            out_error("usage: tap ID MODS KEY");
            return;
        }
        do_tap(id, mods, key);
    } else if (strcmp(cmd, "ping") == 0) {
        out("{\"ev\":\"pong\",\"t_ns\":%llu}", (unsigned long long)now_ns());
    } else if (strcmp(cmd, "quit") == 0) {
        g_stop = -1;
    } else {
        out_error("unknown command '%.32s'", cmd);
    }
}

// ------------------------------------------------------------------------------------ main

static void on_signal(int sig)
{
    g_stop = sig;
}

static void usage(FILE *f, const char *argv0)
{
    fprintf(f,
            "usage: %s --backend uinput|dry"
#ifdef KEYTAP_LIBEI
            "|libei [--ei-fd N]"
#endif
            " [--settle-ms N] [--hold-ms N] [--gap-ms N] [--min-interval-ms N] [--max-taps N] [--name STR]\n"
            "Reads 'tap ID MODS KEY', 'ping' and 'quit' on stdin; writes JSON Lines on stdout.\n"
            "See tools/physical/README.md and docs/validation/PHYSICAL_RUNBOOK.md.\n",
            argv0);
}

static int parse_uint(const char *s, unsigned long max, unsigned long *v)
{
    char *end;
    errno = 0;
    unsigned long x = strtoul(s, &end, 10);
    if (errno || end == s || *end || x > max || s[0] == '-') return -1;
    *v = x;
    return 0;
}

int main(int argc, char **argv)
{
    for (int i = 1; i < argc; ++i) {
        const char *a = argv[i];
        const char *v = i + 1 < argc ? argv[i + 1] : NULL;
        unsigned long x = 0;
        if (strcmp(a, "-h") == 0 || strcmp(a, "--help") == 0) {
            usage(stdout, argv[0]);
            return EXIT_OK;
        }
        if (!v) {
            usage(stderr, argv[0]);
            return EXIT_USAGE;
        }
        ++i;
        if (strcmp(a, "--backend") == 0) {
            if (strcmp(v, "uinput") == 0) g_backend = BACKEND_UINPUT;
            else if (strcmp(v, "dry") == 0) g_backend = BACKEND_DRY;
#ifdef KEYTAP_LIBEI
            else if (strcmp(v, "libei") == 0) g_backend = BACKEND_LIBEI;
#endif
            else {
                fprintf(stderr, "%s: unknown backend '%s'\n", argv[0], v);
                return EXIT_USAGE;
            }
        } else if (strcmp(a, "--name") == 0) {
            snprintf(g_device_name, sizeof g_device_name, "%s", v);
#ifdef KEYTAP_LIBEI
        } else if (strcmp(a, "--ei-fd") == 0 && parse_uint(v, 1 << 20, &x) == 0) {
            g_ei_fd = (int)x;
#endif
        } else if (strcmp(a, "--settle-ms") == 0 && parse_uint(v, 60000, &x) == 0) {
            g_settle_ms = (unsigned)x;
        } else if (strcmp(a, "--hold-ms") == 0 && parse_uint(v, 500, &x) == 0) {
            g_hold_ms = (unsigned)x;
        } else if (strcmp(a, "--gap-ms") == 0 && parse_uint(v, 500, &x) == 0) {
            g_gap_ms = (unsigned)x;
        } else if (strcmp(a, "--min-interval-ms") == 0 && parse_uint(v, 60000, &x) == 0) {
            g_min_interval_ms = (unsigned)x;
        } else if (strcmp(a, "--max-taps") == 0 && parse_uint(v, 10000000, &x) == 0) {
            g_max_taps = x;
        } else {
            fprintf(stderr, "%s: bad option or value: %s %s\n", argv[0], a, v);
            return EXIT_USAGE;
        }
    }
    if (g_backend == BACKEND_NONE) {
        usage(stderr, argv[0]);
        return EXIT_USAGE;
    }

    struct sigaction sa;
    memset(&sa, 0, sizeof sa);
    sa.sa_handler = on_signal; // no SA_RESTART: poll()/read() return EINTR
    sigemptyset(&sa.sa_mask);
    sigaction(SIGINT, &sa, NULL);
    sigaction(SIGTERM, &sa, NULL);
    sigaction(SIGHUP, &sa, NULL);
    signal(SIGPIPE, SIG_IGN);

    struct timespec res;
    clock_getres(CLOCK_MONOTONIC, &res);
    g_res_ns = (unsigned long long)res.tv_sec * 1000000000ull + (unsigned long long)res.tv_nsec;
    const unsigned long long res_ns = g_res_ns;

    if (g_backend == BACKEND_UINPUT) {
        char why[512];
        pid_t kwin = -1;
        if (guard_session(why, sizeof why, &kwin) != 0) {
            out_error("refusing to run: %s", why);
            out("{\"ev\":\"exit\",\"reason\":\"guard\",\"code\":%d,\"taps\":0}", EXIT_GUARD);
            return EXIT_GUARD;
        }
        if (uinput_open() != 0) {
            cleanup();
            out("{\"ev\":\"exit\",\"reason\":\"device\",\"code\":%d,\"taps\":0}", EXIT_DEVICE);
            return EXIT_DEVICE;
        }
        g_ready = true;
        char esc[sizeof g_device_name * 6 + 1];
        json_escape(esc, sizeof esc, g_device_name);
        out("{\"ev\":\"ready\",\"backend\":\"uinput\",\"t_ns\":%llu,\"clock\":\"CLOCK_MONOTONIC\",\"clock_res_ns\":%llu,"
            "\"device_name\":\"%s\",\"compositor_pid\":%d,\"settle_ms\":%u,\"hold_ms\":%u,\"gap_ms\":%u,"
            "\"min_interval_ms\":%u,\"pid\":%d}",
            (unsigned long long)now_ns(), res_ns, esc, (int)kwin, g_settle_ms, g_hold_ms, g_gap_ms, g_min_interval_ms,
            (int)getpid());
    } else if (g_backend == BACKEND_DRY) {
        g_ready = true;
        out("{\"ev\":\"ready\",\"backend\":\"dry\",\"t_ns\":%llu,\"clock\":\"CLOCK_MONOTONIC\",\"clock_res_ns\":%llu,"
            "\"hold_ms\":%u,\"gap_ms\":%u,\"min_interval_ms\":%u,\"pid\":%d}",
            (unsigned long long)now_ns(), res_ns, g_hold_ms, g_gap_ms, g_min_interval_ms, (int)getpid());
    }
#ifdef KEYTAP_LIBEI
    else if (g_backend == BACKEND_LIBEI) {
        if (g_ei_fd < 0) {
            fprintf(stderr, "%s: --backend libei needs --ei-fd N\n", argv[0]);
            return EXIT_USAGE;
        }
        g_ei = ei_new_sender(NULL);
        ei_configure_name(g_ei, "plastile-keytap");
        if (ei_setup_backend_fd(g_ei, g_ei_fd) != 0) {
            out_error("ei_setup_backend_fd failed");
            cleanup();
            return EXIT_DEVICE;
        }
    }
#endif

    char buf[LINE_MAX_LEN + 1];
    size_t len = 0;
    const char *reason = "quit";
    int code = EXIT_OK;
    while (!g_stop) {
        struct pollfd fds[2] = { { .fd = STDIN_FILENO, .events = POLLIN } };
        nfds_t nfds = 1;
#ifdef KEYTAP_LIBEI
        if (g_ei) {
            fds[1].fd = ei_get_fd(g_ei);
            fds[1].events = POLLIN;
            nfds = 2;
        }
#endif
        if (poll(fds, nfds, -1) < 0) {
            if (errno == EINTR) continue;
            reason = "poll-error";
            code = EXIT_IO;
            break;
        }
#ifdef KEYTAP_LIBEI
        if (nfds == 2 && (fds[1].revents & (POLLIN | POLLHUP | POLLERR))) {
            ei_dispatch(g_ei);
            ei_handle();
        }
#endif
        if (!(fds[0].revents & (POLLIN | POLLHUP | POLLERR))) continue;
        ssize_t n = read(STDIN_FILENO, buf + len, LINE_MAX_LEN - len);
        if (n < 0) {
            if (errno == EINTR) continue;
            reason = "stdin-error";
            code = EXIT_IO;
            break;
        }
        if (n == 0) {
            reason = "stdin-eof";
            break;
        }
        len += (size_t)n;
        buf[len] = '\0';
        char *start = buf, *nl;
        while (!g_stop && (nl = memchr(start, '\n', len - (size_t)(start - buf)))) {
            *nl = '\0';
            handle_line(start);
            start = nl + 1;
        }
        len -= (size_t)(start - buf);
        memmove(buf, start, len);
        if (len == LINE_MAX_LEN) {
            out_error("input line longer than %d bytes discarded", LINE_MAX_LEN);
            len = 0;
        }
    }
    if (g_stop > 0) reason = g_stop == SIGPIPE ? "stdout-closed" : "signal";
    cleanup();
    out("{\"ev\":\"exit\",\"reason\":\"%s\",\"code\":%d,\"taps\":%lu}", reason, code, g_taps);
    return code;
}
