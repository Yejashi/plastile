/*
 * plastile-xclient: a small, controllable X11 (xcb) client used to measure how
 * KWin treats XWayland windows and their ICCCM/EWMH hints (size increments,
 * aspect ratio, fixed size, transient dialogs). It logs JSON Lines with
 * CLOCK_MONOTONIC timestamps to stdout. See README.md.
 *
 * Test fixture only. Not part of any Plastile runtime. Run it only against a
 * nested Xwayland (DISPLAY discovered from a disposable kwin_wayland --xwayland).
 */
#define _GNU_SOURCE
#include <errno.h>
#include <getopt.h>
#include <inttypes.h>
#include <poll.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/timerfd.h>
#include <time.h>
#include <unistd.h>

#include <xcb/xcb.h>
#include <xcb/xcb_icccm.h>
#include <xcb/xproto.h>

/* ------------------------------------------------------------------------ */
/* Time and JSON logging                                                     */
/* ------------------------------------------------------------------------ */

static uint64_t now_ns(void)
{
	struct timespec ts;
	clock_gettime(CLOCK_MONOTONIC, &ts);
	return (uint64_t)ts.tv_sec * 1000000000ull + (uint64_t)ts.tv_nsec;
}

static char lbuf[8192];
static size_t llen;
static bool lover;

static void lprintf(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
static void lprintf(const char *fmt, ...)
{
	if (lover)
		return;
	va_list ap;
	va_start(ap, fmt);
	int n = vsnprintf(lbuf + llen, sizeof(lbuf) - llen, fmt, ap);
	va_end(ap);
	if (n < 0 || (size_t)n >= sizeof(lbuf) - llen)
		lover = true;
	else
		llen += (size_t)n;
}

static void lstart(const char *ev)
{
	llen = 0;
	lover = false;
	lprintf("{\"t_ns\":%" PRIu64 ",\"ev\":\"%s\"", now_ns(), ev);
}

static void lesc(const char *s)
{
	lprintf("\"");
	for (const unsigned char *p = (const unsigned char *)s; *p && !lover; p++) {
		if (*p == '"' || *p == '\\')
			lprintf("\\%c", *p);
		else if (*p < 0x20)
			lprintf("\\u%04x", *p);
		else
			lprintf("%c", *p);
	}
	lprintf("\"");
}

static void lstr(const char *k, const char *v)
{
	lprintf(",\"%s\":", k);
	if (v)
		lesc(v);
	else
		lprintf("null");
}
static void lint(const char *k, int64_t v) { lprintf(",\"%s\":%" PRId64, k, v); }
static void lbool(const char *k, bool v) { lprintf(",\"%s\":%s", k, v ? "true" : "false"); }

static void lend(void)
{
	if (lover) {
		fprintf(stdout, "{\"t_ns\":%" PRIu64 ",\"ev\":\"error\",\"msg\":\"log record too long\"}\n", now_ns());
	} else {
		lprintf("}\n");
		fwrite(lbuf, 1, llen, stdout);
	}
	fflush(stdout);
}

static void log_error(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
static void log_error(const char *fmt, ...)
{
	char msg[1024];
	va_list ap;
	va_start(ap, fmt);
	vsnprintf(msg, sizeof(msg), fmt, ap);
	va_end(ap);
	lstart("error");
	lstr("msg", msg);
	lend();
}

/* ------------------------------------------------------------------------ */
/* State                                                                     */
/* ------------------------------------------------------------------------ */

struct size {
	int w, h;
};

struct win {
	xcb_window_t id;
	xcb_gcontext_t gc;
	const char *name; /* "main" / "dialog" */
	uint32_t colour;
	int configures;
	bool mapped;
	int last_w, last_h;
};

static struct {
	const char *title;
	const char *klass;
	struct size size, min, max, inc;
	int aspect_n, aspect_d;
	bool fixed, dialog;
	bool main_destroyed; /* close-main: the dialog outlives its parent */
	int exit_after_ms;

	xcb_connection_t *c;
	xcb_screen_t *screen;
	struct win main, dlg;
	xcb_atom_t WM_PROTOCOLS, WM_DELETE_WINDOW, _NET_WM_NAME, UTF8_STRING, _NET_WM_PID, _NET_WM_WINDOW_TYPE,
		_NET_WM_WINDOW_TYPE_DIALOG, _NET_WM_WINDOW_TYPE_NORMAL, WM_CLIENT_LEADER;
	int exit_tfd;
	bool stdin_open;
	bool quit;
	const char *exit_reason;
	int exit_code;
} g = {
	.title = "plastile-xclient",
	.klass = "plastile-xclient",
	.size = {400, 300},
	.exit_after_ms = 0,
	.exit_tfd = -1,
	.stdin_open = true,
	.exit_reason = "close",
};

static bool parse_size(const char *s, struct size *out)
{
	int w, h;
	char tail;
	if (sscanf(s, "%dx%d%c", &w, &h, &tail) != 2 || w < 0 || h < 0)
		return false;
	out->w = w;
	out->h = h;
	return true;
}

static xcb_atom_t intern(const char *name)
{
	xcb_intern_atom_cookie_t ck = xcb_intern_atom(g.c, 0, (uint16_t)strlen(name), name);
	xcb_intern_atom_reply_t *r = xcb_intern_atom_reply(g.c, ck, NULL);
	if (!r) {
		log_error("intern atom %s failed", name);
		exit(2);
	}
	xcb_atom_t a = r->atom;
	free(r);
	return a;
}

static void set_text(xcb_window_t w, xcb_atom_t prop, xcb_atom_t type, const char *s)
{
	xcb_change_property(g.c, XCB_PROP_MODE_REPLACE, w, prop, type, 8, (uint32_t)strlen(s), s);
}

/* Fill the whole window with its solid colour. */
static void fill(struct win *w)
{
	xcb_rectangle_t r = {0, 0, (uint16_t)(w->last_w > 0 ? w->last_w : 1), (uint16_t)(w->last_h > 0 ? w->last_h : 1)};
	xcb_poly_fill_rectangle(g.c, w->id, w->gc, 1, &r);
}

static void apply_normal_hints(struct win *w, bool is_dialog)
{
	xcb_size_hints_t h;
	memset(&h, 0, sizeof(h));
	struct size min = g.min, max = g.max;
	struct size sz = is_dialog ? (struct size){300, 200} : g.size;
	if (g.fixed && !is_dialog) {
		min = sz;
		max = sz;
	}
	xcb_icccm_size_hints_set_size(&h, false, sz.w, sz.h);
	if (!is_dialog) {
		if (min.w > 0 || min.h > 0)
			xcb_icccm_size_hints_set_min_size(&h, min.w, min.h);
		if (max.w > 0 || max.h > 0)
			xcb_icccm_size_hints_set_max_size(&h, max.w, max.h);
		if (g.inc.w > 0 || g.inc.h > 0) {
			/* Increments count from the base size; base = min (ICCCM) or 0. */
			xcb_icccm_size_hints_set_resize_inc(&h, g.inc.w > 0 ? g.inc.w : 1, g.inc.h > 0 ? g.inc.h : 1);
			xcb_icccm_size_hints_set_base_size(&h, min.w > 0 ? min.w : 0, min.h > 0 ? min.h : 0);
		}
		if (g.aspect_n > 0 && g.aspect_d > 0)
			xcb_icccm_size_hints_set_aspect(&h, g.aspect_n, g.aspect_d, g.aspect_n, g.aspect_d);
	}
	xcb_icccm_set_wm_normal_hints(g.c, w->id, &h);

	lstart("size_hints");
	lstr("win", w->name);
	lint("flags", (int64_t)h.flags);
	lint("width", sz.w);
	lint("height", sz.h);
	lint("min_w", is_dialog ? 0 : min.w);
	lint("min_h", is_dialog ? 0 : min.h);
	lint("max_w", is_dialog ? 0 : max.w);
	lint("max_h", is_dialog ? 0 : max.h);
	lint("inc_w", is_dialog ? 0 : g.inc.w);
	lint("inc_h", is_dialog ? 0 : g.inc.h);
	lint("aspect_n", is_dialog ? 0 : g.aspect_n);
	lint("aspect_d", is_dialog ? 0 : g.aspect_d);
	lend();
}

static void create_window(struct win *w, const char *name, int width, int height, uint32_t colour, bool is_dialog)
{
	w->name = name;
	w->colour = colour;
	w->last_w = width;
	w->last_h = height;
	if (!w->id)
		w->id = xcb_generate_id(g.c);
	uint32_t mask = XCB_CW_BACK_PIXEL | XCB_CW_EVENT_MASK;
	uint32_t values[2] = {colour, XCB_EVENT_MASK_EXPOSURE | XCB_EVENT_MASK_STRUCTURE_NOTIFY |
						  XCB_EVENT_MASK_PROPERTY_CHANGE};
	xcb_create_window(g.c, XCB_COPY_FROM_PARENT, w->id, g.screen->root, 0, 0, (uint16_t)width, (uint16_t)height, 0,
			  XCB_WINDOW_CLASS_INPUT_OUTPUT, g.screen->root_visual, mask, values);
	w->gc = xcb_generate_id(g.c);
	uint32_t gcv[1] = {colour};
	xcb_create_gc(g.c, w->gc, w->id, XCB_GC_FOREGROUND, gcv);

	char title[512];
	snprintf(title, sizeof(title), is_dialog ? "%s dialog" : "%s", g.title);
	set_text(w->id, XCB_ATOM_WM_NAME, XCB_ATOM_STRING, title);
	set_text(w->id, g._NET_WM_NAME, g.UTF8_STRING, title);

	/* WM_CLASS: instance\0class\0 */
	char cls[512];
	size_t il = strlen(g.klass), cl = strlen(g.klass);
	if (il + cl + 2 > sizeof(cls)) {
		log_error("class too long");
		exit(2);
	}
	memcpy(cls, g.klass, il + 1);
	memcpy(cls + il + 1, g.klass, cl + 1);
	xcb_change_property(g.c, XCB_PROP_MODE_REPLACE, w->id, XCB_ATOM_WM_CLASS, XCB_ATOM_STRING, 8,
			    (uint32_t)(il + cl + 2), cls);

	xcb_atom_t protocols[1] = {g.WM_DELETE_WINDOW};
	xcb_icccm_set_wm_protocols(g.c, w->id, g.WM_PROTOCOLS, 1, protocols);
	uint32_t pid = (uint32_t)getpid();
	xcb_change_property(g.c, XCB_PROP_MODE_REPLACE, w->id, g._NET_WM_PID, XCB_ATOM_CARDINAL, 32, 1, &pid);
	xcb_change_property(g.c, XCB_PROP_MODE_REPLACE, w->id, g.WM_CLIENT_LEADER, XCB_ATOM_WINDOW, 32, 1, &g.main.id);

	xcb_atom_t type = is_dialog ? g._NET_WM_WINDOW_TYPE_DIALOG : g._NET_WM_WINDOW_TYPE_NORMAL;
	xcb_change_property(g.c, XCB_PROP_MODE_REPLACE, w->id, g._NET_WM_WINDOW_TYPE, XCB_ATOM_ATOM, 32, 1, &type);
	if (is_dialog)
		xcb_icccm_set_wm_transient_for(g.c, w->id, g.main.id);

	apply_normal_hints(w, is_dialog);

	lstart("create");
	lstr("win", name);
	lint("xid", w->id);
	lstr("title", title);
	lstr("class", g.klass);
	lint("width", width);
	lint("height", height);
	lbool("transient", is_dialog);
	lstr("type", is_dialog ? "_NET_WM_WINDOW_TYPE_DIALOG" : "_NET_WM_WINDOW_TYPE_NORMAL");
	lint("colour", colour);
	lend();
	xcb_map_window(g.c, w->id);
	lstart("map_request");
	lstr("win", name);
	lend();
}

static struct win *win_of(xcb_window_t id)
{
	if (id == g.main.id)
		return &g.main;
	if (g.dialog && id == g.dlg.id)
		return &g.dlg;
	return NULL;
}

static void handle_event(xcb_generic_event_t *ev)
{
	uint8_t type = ev->response_type & ~0x80;
	switch (type) {
	case XCB_MAP_NOTIFY: {
		xcb_map_notify_event_t *e = (xcb_map_notify_event_t *)ev;
		struct win *w = win_of(e->window);
		if (!w)
			break;
		w->mapped = true;
		lstart("map");
		lstr("win", w->name);
		lend();
		break;
	}
	case XCB_UNMAP_NOTIFY: {
		xcb_unmap_notify_event_t *e = (xcb_unmap_notify_event_t *)ev;
		struct win *w = win_of(e->window);
		if (!w)
			break;
		w->mapped = false;
		lstart("unmap");
		lstr("win", w->name);
		lend();
		break;
	}
	case XCB_CONFIGURE_NOTIFY: {
		xcb_configure_notify_event_t *e = (xcb_configure_notify_event_t *)ev;
		struct win *w = win_of(e->window);
		if (!w)
			break;
		bool resized = e->width != w->last_w || e->height != w->last_h;
		w->last_w = e->width;
		w->last_h = e->height;
		w->configures++;
		lstart("configure");
		lstr("win", w->name);
		lint("x", e->x);
		lint("y", e->y);
		lint("w", e->width);
		lint("h", e->height);
		lint("border", e->border_width);
		lbool("resized", resized);
		lbool("synthetic", (ev->response_type & 0x80) != 0);
		lint("n", w->configures);
		lend();
		if (resized)
			fill(w);
		break;
	}
	case XCB_REPARENT_NOTIFY: {
		xcb_reparent_notify_event_t *e = (xcb_reparent_notify_event_t *)ev;
		struct win *w = win_of(e->window);
		if (!w)
			break;
		lstart("reparent");
		lstr("win", w->name);
		lint("parent", e->parent);
		lbool("root", e->parent == g.screen->root);
		lend();
		break;
	}
	case XCB_EXPOSE: {
		xcb_expose_event_t *e = (xcb_expose_event_t *)ev;
		struct win *w = win_of(e->window);
		if (!w)
			break;
		fill(w);
		lstart("expose");
		lstr("win", w->name);
		lint("x", e->x);
		lint("y", e->y);
		lint("w", e->width);
		lint("h", e->height);
		lint("count", e->count);
		lend();
		break;
	}
	case XCB_PROPERTY_NOTIFY: {
		xcb_property_notify_event_t *e = (xcb_property_notify_event_t *)ev;
		struct win *w = win_of(e->window);
		if (!w)
			break;
		xcb_get_atom_name_cookie_t ck = xcb_get_atom_name(g.c, e->atom);
		xcb_get_atom_name_reply_t *r = xcb_get_atom_name_reply(g.c, ck, NULL);
		lstart("property");
		lstr("win", w->name);
		if (r) {
			char name[256];
			int n = xcb_get_atom_name_name_length(r);
			if (n > (int)sizeof(name) - 1)
				n = (int)sizeof(name) - 1;
			memcpy(name, xcb_get_atom_name_name(r), (size_t)n);
			name[n] = 0;
			lstr("atom", name);
			free(r);
		} else {
			lint("atom", e->atom);
		}
		lbool("deleted", e->state == XCB_PROPERTY_DELETE);
		lend();
		break;
	}
	case XCB_CLIENT_MESSAGE: {
		xcb_client_message_event_t *e = (xcb_client_message_event_t *)ev;
		struct win *w = win_of(e->window);
		if (!w)
			break;
		if (e->type == g.WM_PROTOCOLS && e->data.data32[0] == g.WM_DELETE_WINDOW) {
			lstart("close_requested");
			lstr("win", w->name);
			lend();
			if (w == &g.main) {
				g.quit = true;
				g.exit_reason = "close";
			} else {
				xcb_destroy_window(g.c, w->id);
				lstart("dialog_destroyed");
				lend();
			}
		}
		break;
	}
	case XCB_DESTROY_NOTIFY: {
		xcb_destroy_notify_event_t *e = (xcb_destroy_notify_event_t *)ev;
		struct win *w = win_of(e->window);
		if (!w)
			break;
		lstart("destroy");
		lstr("win", w->name);
		lend();
		break;
	}
	case 0: {
		xcb_generic_error_t *e = (xcb_generic_error_t *)ev;
		log_error("x error code %d major %d minor %d resource %u", e->error_code, e->major_code, e->minor_code,
			  e->resource_id);
		break;
	}
	default:
		break;
	}
}

static void handle_command(char *line)
{
	size_t n = strlen(line);
	while (n && (line[n - 1] == '\n' || line[n - 1] == '\r' || line[n - 1] == ' '))
		line[--n] = 0;
	if (!n)
		return;
	lstart("command");
	lstr("line", line);
	lend();
	if (strcmp(line, "quit") == 0) {
		g.quit = true;
		g.exit_reason = "quit";
		return;
	}
	if (strcmp(line, "close-main") == 0) {
		/* The application destroys its main window and keeps the dialog (an orphaned transient). */
		if (!g.main.id || g.main_destroyed) {
			log_error("close-main: no main window");
			return;
		}
		xcb_destroy_window(g.c, g.main.id);
		xcb_flush(g.c);
		g.main_destroyed = true;
		lstart("main_destroyed");
		lbool("dialog_kept", g.dialog);
		lend();
		return;
	}
	int w, h;
	if (sscanf(line, "resize %d %d", &w, &h) == 2 && w > 0 && h > 0) {
		if (g.main_destroyed) {
			log_error("resize: main window destroyed");
			return;
		}
		uint32_t v[2] = {(uint32_t)w, (uint32_t)h};
		xcb_configure_window(g.c, g.main.id, XCB_CONFIG_WINDOW_WIDTH | XCB_CONFIG_WINDOW_HEIGHT, v);
		xcb_flush(g.c);
		lstart("resize_request");
		lstr("win", "main");
		lint("w", w);
		lint("h", h);
		lend();
		return;
	}
	log_error("unknown command: %s", line);
}

static void usage(FILE *f)
{
	fprintf(f,
		"usage: plastile-xclient [--title STR] [--class STR] [--size WxH] [--min WxH] [--max WxH]\n"
		"                        [--inc WxH] [--aspect N:M] [--fixed] [--dialog] [--exit-after-ms N]\n"
		"stdin commands: 'resize W H', 'close-main', 'quit'. JSON Lines log on stdout.\n");
}

int main(int argc, char **argv)
{
	static const struct option opts[] = {
		{"title", required_argument, 0, 't'}, {"class", required_argument, 0, 'c'},
		{"size", required_argument, 0, 's'},  {"min", required_argument, 0, 'm'},
		{"max", required_argument, 0, 'M'},   {"inc", required_argument, 0, 'i'},
		{"aspect", required_argument, 0, 'a'}, {"fixed", no_argument, 0, 'f'},
		{"dialog", no_argument, 0, 'd'},      {"exit-after-ms", required_argument, 0, 'e'},
		{"help", no_argument, 0, 'h'},        {0, 0, 0, 0},
	};
	int opt;
	while ((opt = getopt_long(argc, argv, "h", opts, NULL)) != -1) {
		bool ok = true;
		switch (opt) {
		case 't': g.title = optarg; break;
		case 'c': g.klass = optarg; break;
		case 's': ok = parse_size(optarg, &g.size); break;
		case 'm': ok = parse_size(optarg, &g.min); break;
		case 'M': ok = parse_size(optarg, &g.max); break;
		case 'i': ok = parse_size(optarg, &g.inc); break;
		case 'a': {
			char tail;
			ok = sscanf(optarg, "%d:%d%c", &g.aspect_n, &g.aspect_d, &tail) == 2 && g.aspect_n > 0 && g.aspect_d > 0;
			break;
		}
		case 'f': g.fixed = true; break;
		case 'd': g.dialog = true; break;
		case 'e': g.exit_after_ms = atoi(optarg); ok = g.exit_after_ms > 0; break;
		case 'h': usage(stdout); return 0;
		default: usage(stderr); return 2;
		}
		if (!ok) {
			fprintf(stderr, "bad argument for option: %s\n", optarg);
			return 2;
		}
	}
	if (g.size.w <= 0 || g.size.h <= 0) {
		fprintf(stderr, "--size must be positive\n");
		return 2;
	}

	const char *display = getenv("DISPLAY");
	int screen_nr = 0;
	g.c = xcb_connect(display, &screen_nr);
	if (!g.c || xcb_connection_has_error(g.c)) {
		lstart("error");
		lstr("msg", "cannot connect to X display");
		lstr("display", display);
		lend();
		return 1;
	}
	const xcb_setup_t *setup = xcb_get_setup(g.c);
	xcb_screen_iterator_t it = xcb_setup_roots_iterator(setup);
	for (int i = 0; i < screen_nr; i++)
		xcb_screen_next(&it);
	g.screen = it.data;

	g.WM_PROTOCOLS = intern("WM_PROTOCOLS");
	g.WM_DELETE_WINDOW = intern("WM_DELETE_WINDOW");
	g._NET_WM_NAME = intern("_NET_WM_NAME");
	g.UTF8_STRING = intern("UTF8_STRING");
	g._NET_WM_PID = intern("_NET_WM_PID");
	g._NET_WM_WINDOW_TYPE = intern("_NET_WM_WINDOW_TYPE");
	g._NET_WM_WINDOW_TYPE_DIALOG = intern("_NET_WM_WINDOW_TYPE_DIALOG");
	g._NET_WM_WINDOW_TYPE_NORMAL = intern("_NET_WM_WINDOW_TYPE_NORMAL");
	g.WM_CLIENT_LEADER = intern("WM_CLIENT_LEADER");

	lstart("start");
	lint("pid", getpid());
	lstr("display", display);
	lstr("title", g.title);
	lstr("class", g.klass);
	lint("width", g.size.w);
	lint("height", g.size.h);
	lint("min_w", g.min.w);
	lint("min_h", g.min.h);
	lint("max_w", g.max.w);
	lint("max_h", g.max.h);
	lint("inc_w", g.inc.w);
	lint("inc_h", g.inc.h);
	lint("aspect_n", g.aspect_n);
	lint("aspect_d", g.aspect_d);
	lbool("fixed", g.fixed);
	lbool("dialog", g.dialog);
	lint("exit_after_ms", g.exit_after_ms);
	lint("root_w", g.screen->width_in_pixels);
	lint("root_h", g.screen->height_in_pixels);
	lstr("log_clock", "CLOCK_MONOTONIC");
	lend();

	/* Colours are derived from the title so two clients differ visibly. */
	uint32_t hsh = 2166136261u;
	for (const unsigned char *p = (const unsigned char *)g.title; *p; p++)
		hsh = (hsh ^ *p) * 16777619u;
	uint32_t main_colour = 0x404040u | (hsh & 0x7f7f7fu);
	uint32_t dlg_colour = 0x404040u | ((hsh >> 7) & 0x7f7f7fu);

	/* Pre-allocate the main id so both windows' WM_CLIENT_LEADER can refer to it. */
	g.main.id = xcb_generate_id(g.c);
	create_window(&g.main, "main", g.size.w, g.size.h, main_colour, false);
	if (g.dialog)
		create_window(&g.dlg, "dialog", 300, 200, dlg_colour, true);
	xcb_flush(g.c);

	if (g.exit_after_ms > 0) {
		g.exit_tfd = timerfd_create(CLOCK_MONOTONIC, TFD_NONBLOCK | TFD_CLOEXEC);
		struct itimerspec its = {{0, 0}, {g.exit_after_ms / 1000, (long)(g.exit_after_ms % 1000) * 1000000L}};
		timerfd_settime(g.exit_tfd, 0, &its, NULL);
	}

	char cmdbuf[1024];
	size_t cmdlen = 0;
	int xfd = xcb_get_file_descriptor(g.c);
	while (!g.quit) {
		struct pollfd pfd[3];
		int n = 0;
		pfd[n++] = (struct pollfd){xfd, POLLIN, 0};
		int stdin_idx = -1, tfd_idx = -1;
		if (g.stdin_open) {
			stdin_idx = n;
			pfd[n++] = (struct pollfd){STDIN_FILENO, POLLIN, 0};
		}
		if (g.exit_tfd >= 0) {
			tfd_idx = n;
			pfd[n++] = (struct pollfd){g.exit_tfd, POLLIN, 0};
		}
		xcb_flush(g.c);
		int r = poll(pfd, (nfds_t)n, -1);
		if (r < 0) {
			if (errno == EINTR)
				continue;
			log_error("poll: %s", strerror(errno));
			g.exit_reason = "poll-error";
			g.exit_code = 1;
			break;
		}
		if (xcb_connection_has_error(g.c)) {
			log_error("X connection error");
			g.exit_reason = "display-error";
			g.exit_code = 1;
			break;
		}
		xcb_generic_event_t *ev;
		while ((ev = xcb_poll_for_event(g.c)) != NULL) {
			handle_event(ev);
			free(ev);
		}
		if (stdin_idx >= 0 && (pfd[stdin_idx].revents & (POLLIN | POLLHUP))) {
			ssize_t k = read(STDIN_FILENO, cmdbuf + cmdlen, sizeof(cmdbuf) - 1 - cmdlen);
			if (k <= 0) {
				g.stdin_open = false;
				lstart("stdin_eof");
				lend();
			} else {
				cmdlen += (size_t)k;
				cmdbuf[cmdlen] = 0;
				char *nl;
				while ((nl = memchr(cmdbuf, '\n', cmdlen)) != NULL) {
					*nl = 0;
					handle_command(cmdbuf);
					size_t used = (size_t)(nl - cmdbuf) + 1;
					memmove(cmdbuf, cmdbuf + used, cmdlen - used);
					cmdlen -= used;
				}
				if (cmdlen == sizeof(cmdbuf) - 1)
					cmdlen = 0; /* discard an over-long line */
			}
		}
		if (tfd_idx >= 0 && (pfd[tfd_idx].revents & POLLIN)) {
			uint64_t exp;
			if (read(g.exit_tfd, &exp, sizeof(exp)) > 0) {
				g.quit = true;
				g.exit_reason = "exit-after";
			}
		}
	}
	lstart("exit");
	lstr("reason", g.exit_reason);
	lint("code", g.exit_code);
	lint("configures", g.main.configures);
	lend();
	xcb_disconnect(g.c);
	return g.exit_code;
}
