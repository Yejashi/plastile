// plastile-input: test-only input injector for disposable nested KWin sessions.
//
// Usage: plastile-input FD   (FD = EIS socket from org.kde.KWin.EIS.RemoteDesktop.connectToEIS
//                             on the nested session's private bus, inherited by this process)
// Commands on stdin, one per line; each prints "ok <command>" once emitted:
//   move X Y              absolute pointer motion (logical compositor coordinates)
//   press left|right      button down        release left|right   button up
//   key CODE down|up      evdev key code (e.g. 125 = KEY_LEFTMETA, 1 = KEY_ESC)
// Prints "ready" once pointer-absolute, button and keyboard devices are resumed.
// KWin replaces its EIS devices when the output layout changes (an output disabled in the
// middle of a drag): a removed or paused device is dropped, its replacement is adopted when
// it resumes, and a command waits (bounded, 3 s) for its device to be emulating again.
// This drives KWin's real input pipeline (interactive move/resize included); it is
// never used against the user's session.
#define _POSIX_C_SOURCE 200809L
#include <libei.h>
#include <linux/input-event-codes.h>
#include <poll.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static struct ei_device *abs_dev, *btn_dev, *kbd_dev;
static bool abs_ok, btn_ok, kbd_ok, announced;
static uint32_t seq;

static void handle(struct ei *ei)
{
    struct ei_event *ev;
    while ((ev = ei_get_event(ei))) {
        switch (ei_event_get_type(ev)) {
        case EI_EVENT_SEAT_ADDED:
            ei_seat_bind_capabilities(ei_event_get_seat(ev), EI_DEVICE_CAP_POINTER_ABSOLUTE, EI_DEVICE_CAP_POINTER,
                                      EI_DEVICE_CAP_BUTTON, EI_DEVICE_CAP_KEYBOARD, NULL);
            break;
        case EI_EVENT_DEVICE_ADDED: {
            struct ei_device *d = ei_event_get_device(ev);
            if (!abs_dev && ei_device_has_capability(d, EI_DEVICE_CAP_POINTER_ABSOLUTE)) abs_dev = ei_device_ref(d);
            if (!btn_dev && ei_device_has_capability(d, EI_DEVICE_CAP_BUTTON)) btn_dev = ei_device_ref(d);
            if (!kbd_dev && ei_device_has_capability(d, EI_DEVICE_CAP_KEYBOARD)) kbd_dev = ei_device_ref(d);
            break;
        }
        case EI_EVENT_DEVICE_REMOVED:
        case EI_EVENT_DEVICE_PAUSED: {
            struct ei_device *d = ei_event_get_device(ev);
            bool removed = ei_event_get_type(ev) == EI_EVENT_DEVICE_REMOVED;
            if (d == abs_dev) { abs_ok = false; if (removed) { ei_device_unref(abs_dev); abs_dev = NULL; } }
            if (d == btn_dev) { btn_ok = false; if (removed) { ei_device_unref(btn_dev); btn_dev = NULL; } }
            if (d == kbd_dev) { kbd_ok = false; if (removed) { ei_device_unref(kbd_dev); kbd_dev = NULL; } }
            break;
        }
        case EI_EVENT_DEVICE_RESUMED: {
            struct ei_device *d = ei_event_get_device(ev);
            ei_device_start_emulating(d, ++seq);
            if (d == abs_dev) abs_ok = true;
            if (d == btn_dev) btn_ok = true;
            if (d == kbd_dev) kbd_ok = true;
            break;
        }
        case EI_EVENT_DISCONNECT:
            fprintf(stdout, "disconnected\n");
            fflush(stdout);
            exit(1);
        default:
            break;
        }
        ei_event_unref(ev);
    }
    if (!announced && abs_ok && btn_ok && kbd_ok) {
        announced = true;
        printf("ready\n");
        fflush(stdout);
    }
}

/* Wait (bounded) until the device flag is set again after KWin replaced its devices. */
static void await_device(struct ei *ei, bool *ok)
{
    for (int i = 0; i < 300 && !*ok; ++i) {
        struct pollfd p = { .fd = ei_get_fd(ei), .events = POLLIN };
        if (poll(&p, 1, 10) > 0) { ei_dispatch(ei); handle(ei); }
    }
}

static int command(struct ei *ei, char *line)
{
    double x, y;
    char what[16];
    unsigned code;
    line[strcspn(line, "\n")] = '\0';
    ei_dispatch(ei);
    handle(ei);
    if (strncmp(line, "move ", 5) == 0) await_device(ei, &abs_ok);
    else if (strncmp(line, "press ", 6) == 0 || strncmp(line, "release ", 8) == 0) await_device(ei, &btn_ok);
    else if (strncmp(line, "key ", 4) == 0) await_device(ei, &kbd_ok);
    if (sscanf(line, "move %lf %lf", &x, &y) == 2 && abs_ok) {
        ei_device_pointer_motion_absolute(abs_dev, x, y);
        ei_device_frame(abs_dev, ei_now(ei));
    } else if (sscanf(line, "press %15s", what) == 1 && btn_ok) {
        ei_device_button_button(btn_dev, strcmp(what, "right") == 0 ? BTN_RIGHT : BTN_LEFT, true);
        ei_device_frame(btn_dev, ei_now(ei));
    } else if (sscanf(line, "release %15s", what) == 1 && btn_ok) {
        ei_device_button_button(btn_dev, strcmp(what, "right") == 0 ? BTN_RIGHT : BTN_LEFT, false);
        ei_device_frame(btn_dev, ei_now(ei));
    } else if (sscanf(line, "key %u %15s", &code, what) == 2 && kbd_ok) {
        ei_device_keyboard_key(kbd_dev, code, strcmp(what, "down") == 0);
        ei_device_frame(kbd_dev, ei_now(ei));
    } else {
        printf("error %s\n", line);
        fflush(stdout);
        return -1;
    }
    ei_dispatch(ei); // flush
    printf("ok %s\n", line);
    fflush(stdout);
    return 0;
}

int main(int argc, char **argv)
{
    if (argc != 2) {
        fprintf(stderr, "usage: %s FD\n", argv[0]);
        return 2;
    }
    struct ei *ei = ei_new_sender(NULL);
    ei_configure_name(ei, "plastile-input");
    if (ei_setup_backend_fd(ei, atoi(argv[1])) != 0) {
        fprintf(stderr, "ei_setup_backend_fd failed\n");
        return 1;
    }
    char buf[256];
    struct pollfd fds[2] = { { .fd = ei_get_fd(ei), .events = POLLIN }, { .fd = STDIN_FILENO, .events = POLLIN } };
    for (;;) {
        if (poll(fds, 2, -1) < 0) return 1;
        if (fds[0].revents & POLLIN) { ei_dispatch(ei); handle(ei); }
        if (fds[1].revents & (POLLIN | POLLHUP)) {
            if (!fgets(buf, sizeof buf, stdin)) break;
            command(ei, buf);
        }
    }
    ei_unref(ei);
    return 0;
}
