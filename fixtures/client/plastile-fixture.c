/*
 * plastile-fixture: a small, controllable raw-libwayland xdg-shell client used
 * to measure compositor (KWin) geometry behaviour. It logs JSON Lines with
 * CLOCK_MONOTONIC timestamps to stdout. See README.md for the CLI, control
 * commands, log schema and limitations.
 *
 * Test fixture only. Not part of any Plastile runtime.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <getopt.h>
#include <inttypes.h>
#include <poll.h>
#include <signal.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/signalfd.h>
#include <sys/timerfd.h>
#include <time.h>
#include <unistd.h>

#include <wayland-client.h>

#include "presentation-time-client-protocol.h"
#include "wlr-layer-shell-unstable-v1-client-protocol.h"
#include "xdg-decoration-unstable-v1-client-protocol.h"
#include "xdg-shell-client-protocol.h"

#define MAX_BUFFERS 16
#define CFG_QUEUE 64
#define MAX_STATES 32
#define MAX_OUTPUTS 16
#define STRIP_CELL 16
#define STRIP_COLS 16
#define STRIP_ROWS 2

/* ------------------------------------------------------------------------ */
/* Time and JSON logging                                                     */
/* ------------------------------------------------------------------------ */

static uint64_t now_ns(void)
{
	struct timespec ts;
	clock_gettime(CLOCK_MONOTONIC, &ts);
	return (uint64_t)ts.tv_sec * 1000000000ull + (uint64_t)ts.tv_nsec;
}

static char lbuf[16384];
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

static void lstart_at(const char *ev, uint64_t t)
{
	llen = 0;
	lover = false;
	lprintf("{\"t_ns\":%" PRIu64 ",\"ev\":\"%s\"", t, ev);
}

static void lstart(const char *ev) { lstart_at(ev, now_ns()); }

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
static void luint(const char *k, uint64_t v) { lprintf(",\"%s\":%" PRIu64, k, v); }
static void lnull(const char *k) { lprintf(",\"%s\":null", k); }
static void lbool(const char *k, bool v) { lprintf(",\"%s\":%s", k, v ? "true" : "false"); }
static void lraw(const char *s) { lprintf("%s", s); }

static void lend(void)
{
	if (lover) {
		/* Never emit truncated JSON. */
		fprintf(stdout, "{\"t_ns\":%" PRIu64 ",\"ev\":\"error\",\"msg\":\"log record too long\"}\n",
			now_ns());
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

enum deco_req { DECO_NONE, DECO_SSD, DECO_CSD };
enum delay_mode { DELAY_LATEST, DELAY_EACH };
enum panel_edge { PANEL_NONE, PANEL_TOP, PANEL_BOTTOM, PANEL_LEFT, PANEL_RIGHT };

struct window;

/* A bound wl_output (panel mode only), used to pick the panel's output by name. */
struct output {
	struct wl_output *wl;
	uint32_t global_name;
	char name[64];
	bool have_name;
};

struct buffer {
	struct window *win;
	struct wl_buffer *wl;
	void *data;
	size_t size;
	int w, h, stride;
	bool allocated;
	bool busy;
};

struct pending_cfg {
	uint32_t serial;
	int32_t w, h;
	uint64_t arrival_ns;
	uint64_t due_ns;
};

/* One record per in-flight wl_callback or wp_presentation_feedback. */
struct tracked {
	struct tracked *prev, *next;
	struct window *win;
	uint32_t seq;
	struct wl_callback *cb;
	struct wp_presentation_feedback *fb;
};

struct window {
	const char *name; /* "main", "child" or "panel" */
	bool is_child;
	bool is_panel; /* zwlr_layer_surface_v1 role instead of xdg_toplevel */
	struct wl_surface *surface;
	struct xdg_surface *xdg_surface;
	struct xdg_toplevel *toplevel;
	struct zwlr_layer_surface_v1 *layer;
	struct zxdg_toplevel_decoration_v1 *deco;
	uint32_t deco_mode; /* last decoration configure, 0 = none */

	struct buffer bufs[MAX_BUFFERS];
	int32_t cur_w, cur_h;
	bool configured; /* at least one configure acked */
	bool mapped;     /* first buffer committed */
	bool first_buffer_done;

	/* toplevel configure data waiting for xdg_surface.configure */
	int32_t tl_w, tl_h;
	uint32_t tl_states[MAX_STATES];
	size_t tl_nstates;
	bool have_bounds;
	int32_t bounds_w, bounds_h;

	/* delayed-configure queue (latest mode keeps at most one entry) */
	struct pending_cfg q[CFG_QUEUE];
	size_t qhead, qcount;
	int cfg_tfd;
	bool cfg_armed;
	uint64_t cfg_count;

	struct tracked *tracked;
};

static struct {
	/* options */
	const char *app_id;
	const char *title;
	char title_buf[512];
	int64_t id;
	int32_t init_w, init_h;
	int32_t min_w, min_h, max_w, max_h;
	bool have_min, have_max;
	int64_t cfg_delay_ms;
	enum delay_mode delay_mode;
	bool ignore_size;
	bool clamp;
	int64_t parent_after_ms;
	int64_t exit_after_ms;
	bool exit_on_map; /* first buffer commit and window destruction share one flush */
	int64_t exit_after_map_ms; /* -1: off; exit N ms after the main window mapped */
	bool have_late_min;
	int32_t late_min_w, late_min_h;
	int64_t late_min_delay_ms;
	enum deco_req deco_req;
	enum panel_edge panel_edge; /* PANEL_NONE: ordinary xdg_toplevel client */
	int32_t panel_size;
	const char *panel_output; /* wl_output name to anchor the panel to, or NULL */

	/* wayland */
	struct wl_display *display;
	struct wl_registry *registry;
	struct wl_compositor *compositor;
	uint32_t compositor_adv, compositor_ver;
	struct wl_shm *shm;
	uint32_t shm_adv, shm_ver;
	struct xdg_wm_base *wm_base;
	uint32_t wm_base_adv, wm_base_ver;
	struct wp_presentation *presentation;
	uint32_t pres_adv, pres_ver;
	struct zxdg_decoration_manager_v1 *deco_mgr;
	uint32_t deco_adv, deco_ver;
	struct zwlr_layer_shell_v1 *layer_shell;
	uint32_t layer_adv, layer_ver;
	struct output outputs[MAX_OUTPUTS];
	int n_outputs;
	uint32_t output_adv, output_ver;
	bool shm_xrgb;

	struct window main_win, child_win;
	bool child_exists;
	uint64_t child_gen;

	uint32_t seq; /* global commit sequence, 1-based */

	int exit_tfd, parent_tfd, late_min_tfd, sig_fd;
	bool stdin_open;
	char stdin_buf[4096];
	size_t stdin_len;

	bool running;
	const char *exit_reason;
	int exit_code;
} g;

/* ------------------------------------------------------------------------ */
/* Helpers                                                                   */
/* ------------------------------------------------------------------------ */

static const char *state_name(uint32_t s, char *tmp, size_t n)
{
	static const char *names[] = {
		[XDG_TOPLEVEL_STATE_MAXIMIZED] = "maximized",
		[XDG_TOPLEVEL_STATE_FULLSCREEN] = "fullscreen",
		[XDG_TOPLEVEL_STATE_RESIZING] = "resizing",
		[XDG_TOPLEVEL_STATE_ACTIVATED] = "activated",
		[XDG_TOPLEVEL_STATE_TILED_LEFT] = "tiled_left",
		[XDG_TOPLEVEL_STATE_TILED_RIGHT] = "tiled_right",
		[XDG_TOPLEVEL_STATE_TILED_TOP] = "tiled_top",
		[XDG_TOPLEVEL_STATE_TILED_BOTTOM] = "tiled_bottom",
		[XDG_TOPLEVEL_STATE_SUSPENDED] = "suspended",
		[XDG_TOPLEVEL_STATE_CONSTRAINED_LEFT] = "constrained_left",
		[XDG_TOPLEVEL_STATE_CONSTRAINED_RIGHT] = "constrained_right",
		[XDG_TOPLEVEL_STATE_CONSTRAINED_TOP] = "constrained_top",
		[XDG_TOPLEVEL_STATE_CONSTRAINED_BOTTOM] = "constrained_bottom",
	};
	if (s < sizeof(names) / sizeof(names[0]) && names[s])
		return names[s];
	snprintf(tmp, n, "unknown_%u", s);
	return tmp;
}

static void arm_timer_abs(int fd, uint64_t due_ns)
{
	struct itimerspec its = {0};
	if (due_ns == 0)
		due_ns = 1; /* 0 would disarm */
	its.it_value.tv_sec = (time_t)(due_ns / 1000000000ull);
	its.it_value.tv_nsec = (long)(due_ns % 1000000000ull);
	if (timerfd_settime(fd, TFD_TIMER_ABSTIME, &its, NULL) < 0)
		log_error("timerfd_settime: %s", strerror(errno));
}

static void disarm_timer(int fd)
{
	struct itimerspec its = {0};
	timerfd_settime(fd, 0, &its, NULL);
}

static void drain_timer(int fd)
{
	uint64_t exp;
	while (read(fd, &exp, sizeof(exp)) == (ssize_t)sizeof(exp))
		;
}

static void track_add(struct window *w, struct tracked *t)
{
	t->win = w;
	t->prev = NULL;
	t->next = w->tracked;
	if (w->tracked)
		w->tracked->prev = t;
	w->tracked = t;
}

static void track_remove(struct tracked *t)
{
	struct window *w = t->win;
	if (t->prev)
		t->prev->next = t->next;
	else
		w->tracked = t->next;
	if (t->next)
		t->next->prev = t->prev;
	if (t->cb)
		wl_callback_destroy(t->cb);
	if (t->fb)
		wp_presentation_feedback_destroy(t->fb);
	free(t);
}

/* ------------------------------------------------------------------------ */
/* Buffers and rendering                                                     */
/* ------------------------------------------------------------------------ */

static void buffer_release(void *data, struct wl_buffer *wl)
{
	(void)wl;
	struct buffer *b = data;
	b->busy = false;
}

static const struct wl_buffer_listener buffer_listener = {
	.release = buffer_release,
};

static void buffer_free(struct buffer *b)
{
	if (!b->allocated)
		return;
	wl_buffer_destroy(b->wl);
	munmap(b->data, b->size);
	memset(b, 0, sizeof(*b));
}

static bool buffer_alloc(struct window *w, struct buffer *b, int width, int height)
{
	int stride = width * 4;
	size_t size = (size_t)stride * (size_t)height;
	int fd = memfd_create("plastile-fixture", MFD_CLOEXEC);
	if (fd < 0) {
		log_error("memfd_create: %s", strerror(errno));
		return false;
	}
	if (ftruncate(fd, (off_t)size) < 0) {
		log_error("ftruncate: %s", strerror(errno));
		close(fd);
		return false;
	}
	void *data = mmap(NULL, size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
	if (data == MAP_FAILED) {
		log_error("mmap: %s", strerror(errno));
		close(fd);
		return false;
	}
	struct wl_shm_pool *pool = wl_shm_create_pool(g.shm, fd, (int32_t)size);
	struct wl_buffer *wl = wl_shm_pool_create_buffer(pool, 0, width, height, stride,
						 WL_SHM_FORMAT_XRGB8888);
	wl_shm_pool_destroy(pool);
	close(fd);
	b->win = w;
	b->wl = wl;
	b->data = data;
	b->size = size;
	b->w = width;
	b->h = height;
	b->stride = stride;
	b->allocated = true;
	b->busy = false;
	wl_buffer_add_listener(wl, &buffer_listener, b);
	return true;
}

/* Never returns a buffer the compositor still holds. */
static struct buffer *buffer_get(struct window *w, int width, int height)
{
	struct buffer *free_slot = NULL, *idle_other = NULL;
	for (int i = 0; i < MAX_BUFFERS; i++) {
		struct buffer *b = &w->bufs[i];
		if (!b->allocated) {
			if (!free_slot)
				free_slot = b;
			continue;
		}
		if (b->busy)
			continue;
		if (b->w == width && b->h == height)
			return b;
		if (!idle_other)
			idle_other = b;
	}
	struct buffer *b = idle_other ? idle_other : free_slot;
	if (!b)
		return NULL;
	buffer_free(b);
	if (!buffer_alloc(w, b, width, height))
		return NULL;
	return b;
}

static uint32_t marker_color(int64_t id, uint32_t seq)
{
	uint32_t x = ((uint32_t)id * 2654435761u) ^ (seq * 2246822519u);
	x ^= x >> 15;
	x *= 2246822519u;
	x ^= x >> 13;
	x *= 3266489917u;
	x ^= x >> 16;
	uint32_t r = 0x40 + ((x >> 16) & 0x7f);
	uint32_t gg = 0x40 + ((x >> 8) & 0x7f);
	uint32_t bb = 0x40 + (x & 0x7f);
	return 0xff000000u | (r << 16) | (gg << 8) | bb;
}

static void paint(struct buffer *b, uint32_t seq)
{
	uint32_t bg = marker_color(g.id, seq);
	uint32_t *px = b->data;
	size_t n = (size_t)b->w * (size_t)b->h;
	for (size_t i = 0; i < n; i++)
		px[i] = bg;
	/* 2 rows x 16 cells of 16x16 px; row 0 = bits 31..16, row 1 = bits 15..0,
	 * MSB leftmost; white = 1, black = 0. */
	for (int row = 0; row < STRIP_ROWS; row++) {
		for (int col = 0; col < STRIP_COLS; col++) {
			int bit = 31 - (row * STRIP_COLS + col);
			uint32_t c = ((seq >> bit) & 1u) ? 0xffffffffu : 0xff000000u;
			for (int y = row * STRIP_CELL; y < (row + 1) * STRIP_CELL && y < b->h; y++) {
				uint32_t *line = px + (size_t)y * (size_t)b->w;
				for (int x = col * STRIP_CELL; x < (col + 1) * STRIP_CELL && x < b->w; x++)
					line[x] = c;
			}
		}
	}
}

/* ------------------------------------------------------------------------ */
/* Frame callbacks and presentation feedback                                 */
/* ------------------------------------------------------------------------ */

static void frame_done(void *data, struct wl_callback *cb, uint32_t time_ms)
{
	(void)cb;
	struct tracked *t = data;
	lstart("frame_done");
	lstr("win", t->win->name);
	luint("seq", t->seq);
	luint("cb_time_ms", time_ms);
	lend();
	track_remove(t);
}

static const struct wl_callback_listener frame_listener = {
	.done = frame_done,
};

static void fb_sync_output(void *data, struct wp_presentation_feedback *fb, struct wl_output *out)
{
	(void)data;
	(void)fb;
	(void)out;
}

static void fb_presented(void *data, struct wp_presentation_feedback *fb, uint32_t tv_sec_hi,
			 uint32_t tv_sec_lo, uint32_t tv_nsec, uint32_t refresh, uint32_t seq_hi,
			 uint32_t seq_lo, uint32_t flags)
{
	(void)fb;
	struct tracked *t = data;
	uint64_t sec = ((uint64_t)tv_sec_hi << 32) | tv_sec_lo;
	lstart("presented");
	lstr("win", t->win->name);
	luint("seq", t->seq);
	luint("present_ns", sec * 1000000000ull + tv_nsec);
	luint("tv_sec", sec);
	luint("tv_nsec", tv_nsec);
	luint("refresh_ns", refresh);
	luint("seq_hi", seq_hi);
	luint("seq_lo", seq_lo);
	luint("flags_raw", flags);
	lraw(",\"flags\":[");
	bool first = true;
	static const struct {
		uint32_t bit;
		const char *name;
	} fl[] = {
		{WP_PRESENTATION_FEEDBACK_KIND_VSYNC, "vsync"},
		{WP_PRESENTATION_FEEDBACK_KIND_HW_CLOCK, "hw_clock"},
		{WP_PRESENTATION_FEEDBACK_KIND_HW_COMPLETION, "hw_completion"},
		{WP_PRESENTATION_FEEDBACK_KIND_ZERO_COPY, "zero_copy"},
	};
	for (size_t i = 0; i < sizeof(fl) / sizeof(fl[0]); i++) {
		if (flags & fl[i].bit) {
			lprintf("%s\"%s\"", first ? "" : ",", fl[i].name);
			first = false;
		}
	}
	lraw("]");
	lend();
	t->fb = NULL;
	wp_presentation_feedback_destroy(fb);
	track_remove(t);
}

static void fb_discarded(void *data, struct wp_presentation_feedback *fb)
{
	struct tracked *t = data;
	lstart("discarded");
	lstr("win", t->win->name);
	luint("seq", t->seq);
	lend();
	t->fb = NULL;
	wp_presentation_feedback_destroy(fb);
	track_remove(t);
}

static const struct wp_presentation_feedback_listener fb_listener = {
	.sync_output = fb_sync_output,
	.presented = fb_presented,
	.discarded = fb_discarded,
};

/* ------------------------------------------------------------------------ */
/* Committing                                                                */
/* ------------------------------------------------------------------------ */

static void on_mapped(struct window *w);

static void clamp_size(int32_t *w, int32_t *h)
{
	if (!g.clamp)
		return;
	if (g.have_min) {
		if (g.min_w > 0 && *w < g.min_w)
			*w = g.min_w;
		if (g.min_h > 0 && *h < g.min_h)
			*h = g.min_h;
	}
	if (g.have_max) {
		if (g.max_w > 0 && *w > g.max_w)
			*w = g.max_w;
		if (g.max_h > 0 && *h > g.max_h)
			*h = g.max_h;
	}
}

/* serial < 0: no configure acked for this commit. */
static void commit_buffer(struct window *w, int32_t width, int32_t height, int64_t serial,
			  const char *reason)
{
	if (width <= 0 || height <= 0 || width > 16384 || height > 16384) {
		log_error("%s: refusing to commit invalid size %dx%d", w->name, width, height);
		return;
	}
	struct buffer *b = buffer_get(w, width, height);
	if (!b) {
		log_error("%s: no free buffer for %dx%d (all %d held by compositor or alloc failed)",
			  w->name, width, height, MAX_BUFFERS);
		return;
	}
	uint32_t seq = ++g.seq;
	paint(b, seq);
	wl_surface_attach(w->surface, b->wl, 0, 0);
	if (g.compositor_ver >= 4)
		wl_surface_damage_buffer(w->surface, 0, 0, width, height);
	else
		wl_surface_damage(w->surface, 0, 0, width, height);

	struct tracked *t = calloc(1, sizeof(*t));
	if (t) {
		t->seq = seq;
		t->cb = wl_surface_frame(w->surface);
		wl_callback_add_listener(t->cb, &frame_listener, t);
		track_add(w, t);
	}
	if (g.presentation) {
		struct tracked *f = calloc(1, sizeof(*f));
		if (f) {
			f->seq = seq;
			f->fb = wp_presentation_feedback(g.presentation, w->surface);
			wp_presentation_feedback_add_listener(f->fb, &fb_listener, f);
			track_add(w, f);
		}
	}
	b->busy = true;
	wl_surface_commit(w->surface);
	/* --exit-on-map: the mapping commit is not flushed here; teardown flushes it together
	 * with the window's destruction, so the compositor handles both in one dispatch. */
	bool hold = g.exit_on_map && !w->mapped && !w->is_child && !w->is_panel;
	if (!hold)
		wl_display_flush(g.display);
	w->cur_w = width;
	w->cur_h = height;

	lstart("commit");
	lstr("win", w->name);
	luint("seq", seq);
	lint("width", width);
	lint("height", height);
	if (serial >= 0)
		lint("serial", serial);
	else
		lnull("serial");
	lstr("reason", reason);
	if (hold)
		lbool("flush_deferred", true);
	lend();

	if (!w->mapped) {
		w->mapped = true;
		on_mapped(w);
	}
}

static void process_cfg(struct window *w, const struct pending_cfg *c)
{
	if (w->layer)
		zwlr_layer_surface_v1_ack_configure(w->layer, c->serial);
	else
		xdg_surface_ack_configure(w->xdg_surface, c->serial);
	uint64_t t = now_ns();
	lstart_at("ack", t);
	lstr("win", w->name);
	luint("serial", c->serial);
	luint("delay_ns", t - c->arrival_ns);
	lend();
	w->configured = true;

	bool initial = !w->first_buffer_done;
	w->first_buffer_done = true;
	int32_t width = c->w > 0 ? c->w : w->cur_w;
	int32_t height = c->h > 0 ? c->h : w->cur_h;
	const char *reason = initial ? "initial" : "configure";
	if (w->is_panel) {
		/* A layer surface commits exactly what the compositor configured. */
	} else if (g.ignore_size && !w->is_child) {
		width = w->cur_w;
		height = w->cur_h;
		if (!initial)
			reason = "ignore-size";
	} else if (!w->is_child) {
		clamp_size(&width, &height);
	}
	commit_buffer(w, width, height, c->serial, reason);
}

static void cfg_timer_fired(struct window *w)
{
	drain_timer(w->cfg_tfd);
	w->cfg_armed = false;
	uint64_t now = now_ns();
	while (w->qcount > 0) {
		struct pending_cfg *c = &w->q[w->qhead];
		if (c->due_ns > now)
			break;
		struct pending_cfg copy = *c;
		w->qhead = (w->qhead + 1) % CFG_QUEUE;
		w->qcount--;
		process_cfg(w, &copy);
	}
	if (w->qcount > 0) {
		arm_timer_abs(w->cfg_tfd, w->q[w->qhead].due_ns);
		w->cfg_armed = true;
	}
}

static void enqueue_cfg(struct window *w, uint32_t serial, int32_t width, int32_t height,
			uint64_t arrival)
{
	struct pending_cfg c = {
		.serial = serial,
		.w = width,
		.h = height,
		.arrival_ns = arrival,
		.due_ns = arrival + (uint64_t)g.cfg_delay_ms * 1000000ull,
	};
	if (g.cfg_delay_ms <= 0) {
		process_cfg(w, &c);
		return;
	}
	if (g.delay_mode == DELAY_LATEST) {
		if (w->qcount > 0) {
			struct pending_cfg *old = &w->q[w->qhead];
			lstart("superseded");
			lstr("win", w->name);
			luint("serial", old->serial);
			luint("by_serial", serial);
			lend();
			/* Keep the original deadline: the timer runs from the first
			 * unanswered configure, so a stream of configures cannot
			 * starve the client indefinitely. */
			c.due_ns = old->due_ns;
			*old = c;
		} else {
			w->qhead = 0;
			w->q[0] = c;
			w->qcount = 1;
		}
	} else {
		if (w->qcount == CFG_QUEUE) {
			/* Acking a newer serial implicitly acks older ones, so dropping
			 * the oldest stays protocol-legal. */
			lstart("superseded");
			lstr("win", w->name);
			luint("serial", w->q[w->qhead].serial);
			lstr("why", "queue_full");
			lend();
			w->qhead = (w->qhead + 1) % CFG_QUEUE;
			w->qcount--;
		}
		w->q[(w->qhead + w->qcount) % CFG_QUEUE] = c;
		w->qcount++;
	}
	if (!w->cfg_armed) {
		arm_timer_abs(w->cfg_tfd, w->q[w->qhead].due_ns);
		w->cfg_armed = true;
	}
}

/* ------------------------------------------------------------------------ */
/* xdg-shell listeners                                                       */
/* ------------------------------------------------------------------------ */

static void wm_base_ping(void *data, struct xdg_wm_base *base, uint32_t serial)
{
	(void)data;
	xdg_wm_base_pong(base, serial);
}

static const struct xdg_wm_base_listener wm_base_listener = {
	.ping = wm_base_ping,
};

static void xdg_surface_configure(void *data, struct xdg_surface *xs, uint32_t serial)
{
	(void)xs;
	struct window *w = data;
	uint64_t t = now_ns();
	w->cfg_count++;
	lstart_at("configure", t);
	lstr("win", w->name);
	luint("serial", serial);
	lint("width", w->tl_w);
	lint("height", w->tl_h);
	lraw(",\"states\":[");
	for (size_t i = 0; i < w->tl_nstates; i++) {
		char tmp[32];
		lprintf("%s\"%s\"", i ? "," : "", state_name(w->tl_states[i], tmp, sizeof(tmp)));
	}
	lraw("]");
	if (w->have_bounds)
		lprintf(",\"bounds\":[%d,%d]", w->bounds_w, w->bounds_h);
	if (w->deco) {
		const char *m = w->deco_mode == ZXDG_TOPLEVEL_DECORATION_V1_MODE_SERVER_SIDE ? "server_side"
				: w->deco_mode == ZXDG_TOPLEVEL_DECORATION_V1_MODE_CLIENT_SIDE ? "client_side"
											   : NULL;
		lstr("decoration", m);
	}
	luint("n", w->cfg_count);
	lend();
	enqueue_cfg(w, serial, w->tl_w, w->tl_h, t);
}

static const struct xdg_surface_listener xdg_surface_listener = {
	.configure = xdg_surface_configure,
};

static void destroy_child(void);

static void toplevel_configure(void *data, struct xdg_toplevel *tl, int32_t width, int32_t height,
			       struct wl_array *states)
{
	(void)tl;
	struct window *w = data;
	w->tl_w = width;
	w->tl_h = height;
	w->tl_nstates = 0;
	uint32_t *s;
	wl_array_for_each(s, states)
	{
		if (w->tl_nstates < MAX_STATES)
			w->tl_states[w->tl_nstates++] = *s;
	}
}

static void toplevel_close(void *data, struct xdg_toplevel *tl)
{
	(void)tl;
	struct window *w = data;
	lstart("close_requested");
	lstr("win", w->name);
	lend();
	if (w->is_child) {
		destroy_child();
	} else {
		g.running = false;
		g.exit_reason = "close";
	}
}

static void toplevel_configure_bounds(void *data, struct xdg_toplevel *tl, int32_t width,
				      int32_t height)
{
	(void)tl;
	struct window *w = data;
	w->have_bounds = true;
	w->bounds_w = width;
	w->bounds_h = height;
}

static void toplevel_wm_capabilities(void *data, struct xdg_toplevel *tl, struct wl_array *caps)
{
	(void)tl;
	struct window *w = data;
	static const char *names[] = {NULL, "window_menu", "maximize", "fullscreen", "minimize"};
	lstart("wm_capabilities");
	lstr("win", w->name);
	lraw(",\"caps\":[");
	uint32_t *c;
	bool first = true;
	wl_array_for_each(c, caps)
	{
		if (*c < 5 && names[*c])
			lprintf("%s\"%s\"", first ? "" : ",", names[*c]);
		else
			lprintf("%s\"unknown_%u\"", first ? "" : ",", *c);
		first = false;
	}
	lraw("]");
	lend();
}

static const struct xdg_toplevel_listener toplevel_listener = {
	.configure = toplevel_configure,
	.close = toplevel_close,
	.configure_bounds = toplevel_configure_bounds,
	.wm_capabilities = toplevel_wm_capabilities,
};

static void deco_configure(void *data, struct zxdg_toplevel_decoration_v1 *d, uint32_t mode)
{
	(void)d;
	struct window *w = data;
	w->deco_mode = mode;
	lstart("decoration");
	lstr("win", w->name);
	lstr("mode", mode == ZXDG_TOPLEVEL_DECORATION_V1_MODE_SERVER_SIDE ? "server_side"
		     : mode == ZXDG_TOPLEVEL_DECORATION_V1_MODE_CLIENT_SIDE ? "client_side"
									     : "unknown");
	lend();
}

static const struct zxdg_toplevel_decoration_v1_listener deco_listener = {
	.configure = deco_configure,
};

/* ------------------------------------------------------------------------ */
/* wlr-layer-shell listeners (panel mode)                                    */
/* ------------------------------------------------------------------------ */

static const char *panel_edge_name(enum panel_edge e)
{
	switch (e) {
	case PANEL_TOP: return "top";
	case PANEL_BOTTOM: return "bottom";
	case PANEL_LEFT: return "left";
	case PANEL_RIGHT: return "right";
	default: return NULL;
	}
}

static void layer_configure(void *data, struct zwlr_layer_surface_v1 *ls, uint32_t serial, uint32_t width,
			    uint32_t height)
{
	(void)ls;
	struct window *w = data;
	uint64_t t = now_ns();
	w->cfg_count++;
	/* Same record shape as the xdg path; a layer surface has no states. */
	lstart_at("configure", t);
	lstr("win", w->name);
	luint("serial", serial);
	lint("width", (int64_t)width);
	lint("height", (int64_t)height);
	lraw(",\"states\":[]");
	lstr("shell", "layer");
	luint("n", w->cfg_count);
	lend();
	enqueue_cfg(w, serial, (int32_t)width, (int32_t)height, t);
}

static void layer_closed(void *data, struct zwlr_layer_surface_v1 *ls)
{
	(void)ls;
	struct window *w = data;
	lstart("close_requested");
	lstr("win", w->name);
	lstr("shell", "layer");
	lend();
	g.running = false;
	g.exit_reason = "close";
}

static const struct zwlr_layer_surface_v1_listener layer_listener = {
	.configure = layer_configure,
	.closed = layer_closed,
};

static void output_geometry(void *data, struct wl_output *o, int32_t x, int32_t y, int32_t pw, int32_t ph,
			    int32_t subpixel, const char *make, const char *model, int32_t transform)
{
	(void)data; (void)o; (void)x; (void)y; (void)pw; (void)ph; (void)subpixel; (void)make; (void)model;
	(void)transform;
}

static void output_mode(void *data, struct wl_output *o, uint32_t flags, int32_t w, int32_t h, int32_t refresh)
{
	(void)data; (void)o; (void)flags; (void)w; (void)h; (void)refresh;
}

static void output_done(void *data, struct wl_output *o)
{
	(void)data;
	(void)o;
}

static void output_scale(void *data, struct wl_output *o, int32_t factor)
{
	(void)data; (void)o; (void)factor;
}

static void output_name(void *data, struct wl_output *o, const char *name)
{
	(void)o;
	struct output *out = data;
	snprintf(out->name, sizeof(out->name), "%s", name);
	out->have_name = true;
}

static void output_description(void *data, struct wl_output *o, const char *desc)
{
	(void)data; (void)o; (void)desc;
}

static const struct wl_output_listener output_listener = {
	.geometry = output_geometry,
	.mode = output_mode,
	.done = output_done,
	.scale = output_scale,
	.name = output_name,
	.description = output_description,
};

/* ------------------------------------------------------------------------ */
/* Window lifecycle                                                          */
/* ------------------------------------------------------------------------ */

static bool window_create(struct window *w, const char *name, bool is_child, const char *title,
			  int32_t width, int32_t height)
{
	memset(w, 0, sizeof(*w));
	w->name = name;
	w->is_child = is_child;
	w->cur_w = width;
	w->cur_h = height;
	w->cfg_tfd = timerfd_create(CLOCK_MONOTONIC, TFD_NONBLOCK | TFD_CLOEXEC);
	if (w->cfg_tfd < 0) {
		log_error("timerfd_create: %s", strerror(errno));
		return false;
	}
	w->surface = wl_compositor_create_surface(g.compositor);
	w->xdg_surface = xdg_wm_base_get_xdg_surface(g.wm_base, w->surface);
	xdg_surface_add_listener(w->xdg_surface, &xdg_surface_listener, w);
	w->toplevel = xdg_surface_get_toplevel(w->xdg_surface);
	xdg_toplevel_add_listener(w->toplevel, &toplevel_listener, w);
	xdg_toplevel_set_app_id(w->toplevel, g.app_id);
	xdg_toplevel_set_title(w->toplevel, title);
	if (is_child) {
		xdg_toplevel_set_parent(w->toplevel, g.main_win.toplevel);
	} else {
		if (g.have_min)
			xdg_toplevel_set_min_size(w->toplevel, g.min_w, g.min_h);
		if (g.have_max)
			xdg_toplevel_set_max_size(w->toplevel, g.max_w, g.max_h);
	}
	if (g.deco_req != DECO_NONE) {
		if (g.deco_mgr) {
			w->deco = zxdg_decoration_manager_v1_get_toplevel_decoration(g.deco_mgr, w->toplevel);
			zxdg_toplevel_decoration_v1_add_listener(w->deco, &deco_listener, w);
			zxdg_toplevel_decoration_v1_set_mode(
				w->deco, g.deco_req == DECO_SSD ? ZXDG_TOPLEVEL_DECORATION_V1_MODE_SERVER_SIDE
								: ZXDG_TOPLEVEL_DECORATION_V1_MODE_CLIENT_SIDE);
		} else {
			log_error("%s: decoration mode requested but zxdg_decoration_manager_v1 is absent", name);
		}
	}
	wl_surface_commit(w->surface); /* initial bufferless commit */
	wl_display_flush(g.display);
	lstart("initial_commit");
	lstr("win", name);
	lstr("title", title);
	lint("width", width);
	lint("height", height);
	lend();
	return true;
}

/* Panel mode: a zwlr_layer_surface_v1 on the top layer, scope "dock", anchored to
 * `edge` plus both perpendicular edges, with exclusive_zone == size. */
static bool panel_create(struct window *w, enum panel_edge edge, int32_t size, const char *output_name)
{
	memset(w, 0, sizeof(*w));
	w->name = "panel";
	w->is_panel = true;
	w->cur_w = size; /* fallbacks only; the compositor sends the real size */
	w->cur_h = size;
	w->cfg_tfd = timerfd_create(CLOCK_MONOTONIC, TFD_NONBLOCK | TFD_CLOEXEC);
	if (w->cfg_tfd < 0) {
		log_error("timerfd_create: %s", strerror(errno));
		return false;
	}
	struct wl_output *out = NULL;
	const char *out_used = NULL;
	if (output_name) {
		for (int i = 0; i < g.n_outputs; i++) {
			if (g.outputs[i].have_name && !strcmp(g.outputs[i].name, output_name)) {
				out = g.outputs[i].wl;
				out_used = g.outputs[i].name;
				break;
			}
		}
		if (!out) {
			log_error("panel: no wl_output named %s (bound %d outputs, wl_output v%u)", output_name,
				  g.n_outputs, g.output_ver);
			return false;
		}
	}
	uint32_t anchor;
	int32_t req_w = 0, req_h = 0;
	switch (edge) {
	case PANEL_TOP:
		anchor = ZWLR_LAYER_SURFACE_V1_ANCHOR_TOP | ZWLR_LAYER_SURFACE_V1_ANCHOR_LEFT |
			 ZWLR_LAYER_SURFACE_V1_ANCHOR_RIGHT;
		req_h = size;
		break;
	case PANEL_BOTTOM:
		anchor = ZWLR_LAYER_SURFACE_V1_ANCHOR_BOTTOM | ZWLR_LAYER_SURFACE_V1_ANCHOR_LEFT |
			 ZWLR_LAYER_SURFACE_V1_ANCHOR_RIGHT;
		req_h = size;
		break;
	case PANEL_LEFT:
		anchor = ZWLR_LAYER_SURFACE_V1_ANCHOR_LEFT | ZWLR_LAYER_SURFACE_V1_ANCHOR_TOP |
			 ZWLR_LAYER_SURFACE_V1_ANCHOR_BOTTOM;
		req_w = size;
		break;
	case PANEL_RIGHT:
		anchor = ZWLR_LAYER_SURFACE_V1_ANCHOR_RIGHT | ZWLR_LAYER_SURFACE_V1_ANCHOR_TOP |
			 ZWLR_LAYER_SURFACE_V1_ANCHOR_BOTTOM;
		req_w = size;
		break;
	default:
		log_error("panel: invalid edge");
		return false;
	}
	w->surface = wl_compositor_create_surface(g.compositor);
	w->layer = zwlr_layer_shell_v1_get_layer_surface(g.layer_shell, w->surface, out,
							 ZWLR_LAYER_SHELL_V1_LAYER_TOP, "dock");
	zwlr_layer_surface_v1_add_listener(w->layer, &layer_listener, w);
	zwlr_layer_surface_v1_set_anchor(w->layer, anchor);
	zwlr_layer_surface_v1_set_size(w->layer, (uint32_t)req_w, (uint32_t)req_h);
	zwlr_layer_surface_v1_set_exclusive_zone(w->layer, size);
	zwlr_layer_surface_v1_set_keyboard_interactivity(w->layer, ZWLR_LAYER_SURFACE_V1_KEYBOARD_INTERACTIVITY_NONE);
	wl_surface_commit(w->surface); /* initial bufferless commit */
	wl_display_flush(g.display);
	lstart("initial_commit");
	lstr("win", w->name);
	lstr("shell", "layer");
	lstr("layer", "top");
	lstr("scope", "dock");
	lstr("edge", panel_edge_name(edge));
	lint("exclusive_zone", size);
	lint("width", req_w);
	lint("height", req_h);
	lstr("output", out_used);
	lraw(",\"outputs\":[");
	for (int i = 0; i < g.n_outputs; i++) {
		lraw(i ? "," : "");
		if (g.outputs[i].have_name)
			lesc(g.outputs[i].name);
		else
			lraw("null");
	}
	lraw("]");
	lend();
	return true;
}

static void window_destroy(struct window *w)
{
	while (w->tracked)
		track_remove(w->tracked);
	if (w->deco)
		zxdg_toplevel_decoration_v1_destroy(w->deco);
	if (w->toplevel)
		xdg_toplevel_destroy(w->toplevel);
	if (w->xdg_surface)
		xdg_surface_destroy(w->xdg_surface);
	if (w->layer)
		zwlr_layer_surface_v1_destroy(w->layer);
	if (w->surface)
		wl_surface_destroy(w->surface);
	for (int i = 0; i < MAX_BUFFERS; i++)
		buffer_free(&w->bufs[i]);
	if (w->cfg_tfd >= 0)
		close(w->cfg_tfd);
	memset(w, 0, sizeof(*w));
	w->cfg_tfd = -1;
}

static void spawn_child(void)
{
	if (g.child_exists) {
		log_error("child already exists");
		return;
	}
	if (!g.main_win.mapped) {
		log_error("cannot spawn child before main window is mapped");
		return;
	}
	if (g.main_win.is_panel) {
		log_error("cannot spawn a child in panel mode (no xdg_toplevel parent)");
		return;
	}
	char title[600];
	snprintf(title, sizeof(title), "%s child", g.title);
	if (!window_create(&g.child_win, "child", true, title, 300, 200)) {
		window_destroy(&g.child_win);
		return;
	}
	g.child_exists = true;
	g.child_gen++;
}

static void destroy_child(void)
{
	if (!g.child_exists) {
		log_error("no child to close");
		return;
	}
	window_destroy(&g.child_win);
	g.child_exists = false;
	wl_display_flush(g.display);
	lstart("child_destroyed");
	luint("child_gen", g.child_gen);
	lend();
}

static void on_mapped(struct window *w)
{
	if (w->is_child) {
		lstart("child_mapped");
		luint("child_gen", g.child_gen);
		lint("width", w->cur_w);
		lint("height", w->cur_h);
		lend();
		return;
	}
	lstart("mapped");
	lstr("win", w->name);
	lint("width", w->cur_w);
	lint("height", w->cur_h);
	lend();
	if (g.exit_on_map) {
		/* Stop before anything else is flushed; teardown destroys the window and
		 * sends the held mapping commit and the destruction requests together. */
		g.running = false;
		g.exit_reason = "exit-on-map";
		return;
	}
	if (g.exit_after_map_ms >= 0)
		arm_timer_abs(g.exit_tfd, now_ns() + (uint64_t)g.exit_after_map_ms * 1000000ull);
	if (g.parent_after_ms >= 0)
		arm_timer_abs(g.parent_tfd, now_ns() + (uint64_t)g.parent_after_ms * 1000000ull);
	if (g.have_late_min)
		arm_timer_abs(g.late_min_tfd, now_ns() + (uint64_t)g.late_min_delay_ms * 1000000ull);
}

/* --late-min-size: raise xdg_toplevel.min_size after mapping (bufferless commit), like a
 * client that computes its real minimum only once its content exists. */
static void apply_late_min(void)
{
	if (!g.main_win.toplevel)
		return;
	g.have_min = true;
	g.min_w = g.late_min_w;
	g.min_h = g.late_min_h;
	xdg_toplevel_set_min_size(g.main_win.toplevel, g.min_w, g.min_h);
	wl_surface_commit(g.main_win.surface);
	wl_display_flush(g.display);
	lstart("size_hints");
	lstr("win", "main");
	lstr("reason", "late-min-size");
	lprintf(",\"min\":[%d,%d],\"max\":[%d,%d]", g.min_w, g.min_h, g.have_max ? g.max_w : 0,
		g.have_max ? g.max_h : 0);
	lint("current_width", g.main_win.cur_w);
	lint("current_height", g.main_win.cur_h);
	lend();
}

/* ------------------------------------------------------------------------ */
/* Registry                                                                  */
/* ------------------------------------------------------------------------ */

static uint32_t umin(uint32_t a, uint32_t b) { return a < b ? a : b; }

static void shm_format(void *data, struct wl_shm *shm, uint32_t format)
{
	(void)data;
	(void)shm;
	if (format == WL_SHM_FORMAT_XRGB8888)
		g.shm_xrgb = true;
}

static const struct wl_shm_listener shm_listener = {
	.format = shm_format,
};

static void pres_clock_id(void *data, struct wp_presentation *p, uint32_t clk_id)
{
	(void)data;
	(void)p;
	const char *name = clk_id == CLOCK_MONOTONIC ? "CLOCK_MONOTONIC"
			   : clk_id == CLOCK_MONOTONIC_RAW ? "CLOCK_MONOTONIC_RAW"
			   : clk_id == CLOCK_REALTIME ? "CLOCK_REALTIME"
			   : clk_id == CLOCK_BOOTTIME ? "CLOCK_BOOTTIME"
						       : "other";
	lstart("presentation_clock");
	luint("clk_id", clk_id);
	lstr("name", name);
	lbool("same_as_log_clock", clk_id == CLOCK_MONOTONIC);
	lend();
}

static const struct wp_presentation_listener pres_listener = {
	.clock_id = pres_clock_id,
};

static void registry_global(void *data, struct wl_registry *reg, uint32_t name, const char *iface,
			    uint32_t version)
{
	(void)data;
	if (!strcmp(iface, wl_compositor_interface.name) && !g.compositor) {
		g.compositor_adv = version;
		g.compositor_ver = umin(version, 4);
		g.compositor = wl_registry_bind(reg, name, &wl_compositor_interface, g.compositor_ver);
	} else if (!strcmp(iface, wl_shm_interface.name) && !g.shm) {
		g.shm_adv = version;
		g.shm_ver = 1;
		g.shm = wl_registry_bind(reg, name, &wl_shm_interface, g.shm_ver);
		wl_shm_add_listener(g.shm, &shm_listener, NULL);
	} else if (!strcmp(iface, xdg_wm_base_interface.name) && !g.wm_base) {
		g.wm_base_adv = version;
		g.wm_base_ver = umin(version, (uint32_t)xdg_wm_base_interface.version);
		g.wm_base = wl_registry_bind(reg, name, &xdg_wm_base_interface, g.wm_base_ver);
		xdg_wm_base_add_listener(g.wm_base, &wm_base_listener, NULL);
	} else if (!strcmp(iface, wp_presentation_interface.name) && !g.presentation) {
		g.pres_adv = version;
		g.pres_ver = umin(version, (uint32_t)wp_presentation_interface.version);
		g.presentation = wl_registry_bind(reg, name, &wp_presentation_interface, g.pres_ver);
		wp_presentation_add_listener(g.presentation, &pres_listener, NULL);
	} else if (!strcmp(iface, zxdg_decoration_manager_v1_interface.name) && !g.deco_mgr) {
		g.deco_adv = version;
		if (g.deco_req != DECO_NONE) {
			g.deco_ver = 1;
			g.deco_mgr = wl_registry_bind(reg, name, &zxdg_decoration_manager_v1_interface, 1);
		}
	} else if (!strcmp(iface, zwlr_layer_shell_v1_interface.name) && !g.layer_shell) {
		g.layer_adv = version;
		if (g.panel_edge != PANEL_NONE) {
			g.layer_ver = umin(version, (uint32_t)zwlr_layer_shell_v1_interface.version);
			g.layer_shell = wl_registry_bind(reg, name, &zwlr_layer_shell_v1_interface, g.layer_ver);
		}
	} else if (!strcmp(iface, wl_output_interface.name)) {
		g.output_adv = version;
		/* Outputs are bound only in panel mode (the toplevel path stays output-agnostic). */
		if (g.panel_edge != PANEL_NONE && g.n_outputs < MAX_OUTPUTS) {
			g.output_ver = umin(version, 4); /* v4: name/description events */
			struct output *o = &g.outputs[g.n_outputs++];
			o->global_name = name;
			o->wl = wl_registry_bind(reg, name, &wl_output_interface, g.output_ver);
			wl_output_add_listener(o->wl, &output_listener, o);
		}
	}
}

static void registry_global_remove(void *data, struct wl_registry *reg, uint32_t name)
{
	(void)data;
	(void)reg;
	lstart("global_removed");
	luint("name", name);
	lend();
}

static const struct wl_registry_listener registry_listener = {
	.global = registry_global,
	.global_remove = registry_global_remove,
};

static void log_bound_entry(const char *iface, uint32_t adv, uint32_t ver, bool *first)
{
	lprintf("%s\"%s\":{\"advertised\":", *first ? "" : ",", iface);
	if (adv)
		lprintf("%u", adv);
	else
		lprintf("null");
	lprintf(",\"bound\":");
	if (ver)
		lprintf("%u", ver);
	else
		lprintf("null");
	lprintf("}");
	*first = false;
}

static void log_bound(void)
{
	lstart("bound");
	lraw(",\"globals\":{");
	bool first = true;
	log_bound_entry("wl_compositor", g.compositor_adv, g.compositor_ver, &first);
	log_bound_entry("wl_shm", g.shm_adv, g.shm_ver, &first);
	log_bound_entry("xdg_wm_base", g.wm_base_adv, g.wm_base_ver, &first);
	log_bound_entry("wp_presentation", g.pres_adv, g.pres_ver, &first);
	log_bound_entry("zxdg_decoration_manager_v1", g.deco_adv, g.deco_ver, &first);
	log_bound_entry("zwlr_layer_shell_v1", g.layer_adv, g.layer_ver, &first);
	log_bound_entry("wl_output", g.output_adv, g.output_ver, &first);
	lraw("}");
	lend();
}

/* ------------------------------------------------------------------------ */
/* stdin control                                                             */
/* ------------------------------------------------------------------------ */

static void handle_command(char *line)
{
	char *save = NULL;
	char *cmd = strtok_r(line, " \t", &save);
	if (!cmd)
		return;
	char *rest = save; /* remainder after the command word */
	lstart("command");
	lstr("cmd", cmd);
	lstr("args", rest && *rest ? rest : NULL);
	lend();

	int a = 0, b = 0;
	if (g.main_win.is_panel && strcmp(cmd, "quit") != 0) {
		log_error("%s: not supported in panel mode (layer surface, no xdg_toplevel)", cmd);
		return;
	}
	if (!strcmp(cmd, "resize")) {
		if (!rest || sscanf(rest, "%d %d", &a, &b) != 2 || a <= 0 || b <= 0) {
			log_error("usage: resize W H");
			return;
		}
		if (!g.main_win.configured) {
			log_error("resize before first configure ack");
			return;
		}
		commit_buffer(&g.main_win, a, b, -1, "app-resize");
	} else if (!strcmp(cmd, "min") || !strcmp(cmd, "max")) {
		if (!rest || sscanf(rest, "%d %d", &a, &b) != 2 || a < 0 || b < 0) {
			log_error("usage: %s W H", cmd);
			return;
		}
		if (cmd[1] == 'i') {
			g.have_min = true;
			g.min_w = a;
			g.min_h = b;
			xdg_toplevel_set_min_size(g.main_win.toplevel, a, b);
		} else {
			g.have_max = true;
			g.max_w = a;
			g.max_h = b;
			xdg_toplevel_set_max_size(g.main_win.toplevel, a, b);
		}
		/* min/max are double-buffered: apply with a bufferless commit. */
		wl_surface_commit(g.main_win.surface);
		wl_display_flush(g.display);
		lstart("size_hints");
		lstr("win", "main");
		lprintf(",\"min\":[%d,%d],\"max\":[%d,%d]", g.have_min ? g.min_w : 0,
			g.have_min ? g.min_h : 0, g.have_max ? g.max_w : 0, g.have_max ? g.max_h : 0);
		lend();
	} else if (!strcmp(cmd, "child")) {
		spawn_child();
	} else if (!strcmp(cmd, "close-child")) {
		destroy_child();
	} else if (!strcmp(cmd, "title")) {
		if (!rest || !*rest) {
			log_error("usage: title STR");
			return;
		}
		snprintf(g.title_buf, sizeof(g.title_buf), "%s", rest);
		g.title = g.title_buf;
		xdg_toplevel_set_title(g.main_win.toplevel, g.title);
		wl_display_flush(g.display);
		lstart("title_set");
		lstr("title", g.title);
		lend();
	} else if (!strcmp(cmd, "quit")) {
		g.running = false;
		g.exit_reason = "quit";
	} else {
		log_error("unknown command: %s", cmd);
	}
}

static void handle_stdin(void)
{
	/* The tail of this function keeps stdin_len < sizeof - 1; restating it here
	 * lets _FORTIFY_SOURCE (GCC 15, Ubuntu default) prove the read size cannot wrap. */
	if (g.stdin_len >= sizeof(g.stdin_buf) - 1)
		g.stdin_len = 0;
	size_t room = sizeof(g.stdin_buf) - 1 - g.stdin_len;
	if (room > sizeof(g.stdin_buf) - 1)
		return;
	ssize_t n = read(STDIN_FILENO, &g.stdin_buf[g.stdin_len], room);
	if (n < 0) {
		if (errno == EINTR || errno == EAGAIN)
			return;
		log_error("stdin read: %s", strerror(errno));
		g.stdin_open = false;
		return;
	}
	if (n == 0) {
		g.stdin_open = false;
		lstart("stdin_eof");
		lend();
		return;
	}
	g.stdin_len += (size_t)n;
	g.stdin_buf[g.stdin_len] = '\0';
	char *start = g.stdin_buf;
	char *nl;
	while ((nl = strchr(start, '\n'))) {
		*nl = '\0';
		if (nl > start && nl[-1] == '\r')
			nl[-1] = '\0';
		handle_command(start);
		start = nl + 1;
	}
	size_t left = g.stdin_len - (size_t)(start - g.stdin_buf);
	memmove(g.stdin_buf, start, left);
	g.stdin_len = left;
	if (g.stdin_len == sizeof(g.stdin_buf) - 1) {
		log_error("stdin line too long; discarded");
		g.stdin_len = 0;
	}
}

/* ------------------------------------------------------------------------ */
/* CLI                                                                       */
/* ------------------------------------------------------------------------ */

static void usage(FILE *f)
{
	fprintf(f,
		"usage: plastile-fixture [options]\n"
		"  --app-id STR             xdg_toplevel app id (default plastile-fixture)\n"
		"  --title STR              title (default \"plastile-fixture <id>\")\n"
		"  --id N                   marker id (default 0)\n"
		"  --size WxH               initial size (default 400x300)\n"
		"  --min WxH / --max WxH    xdg_toplevel min/max size\n"
		"  --fixed                  min = max = initial size\n"
		"  --clamp                  clamp configured size to own min/max before commit\n"
		"  --configure-delay-ms N   delay ack+commit after each configure\n"
		"  --delay-mode latest|each (default latest)\n"
		"  --ignore-size            ack configures but keep current size\n"
		"  --parent-after-ms N      spawn transient child N ms after mapping\n"
		"  --exit-after-ms N        exit after N ms\n"
		"  --exit-on-map            send the first buffer commit and the window's destruction\n"
		"                           in one flush, then exit (window removed right after mapping)\n"
		"  --exit-after-map-ms N    exit N ms after the main window mapped (the mapping commit is\n"
		"                           flushed first; 0 = destroy right after it)\n"
		"  --late-min-size W,H,MS   MS ms after mapping, set xdg min size WxH (bufferless commit)\n"
		"  --ssd | --csd            negotiate xdg-decoration mode\n"
		"  --panel EDGE:SIZE        be a wlr-layer-shell panel instead of an xdg_toplevel:\n"
		"                           layer top, scope dock, anchored to EDGE (top|bottom|left|right)\n"
		"                           plus both perpendicular edges, exclusive_zone SIZE\n"
		"  --output NAME            panel mode: wl_output name to anchor to (default: compositor's choice)\n"
		"stdin commands: resize W H | min W H | max W H | child | close-child | title STR | quit\n"
		"                (panel mode accepts only quit)\n");
}

static bool parse_panel(const char *s, enum panel_edge *edge, int32_t *size)
{
	const char *colon = strchr(s, ':');
	if (!colon || colon == s)
		return false;
	size_t n = (size_t)(colon - s);
	if (n == 3 && !strncmp(s, "top", 3)) *edge = PANEL_TOP;
	else if (n == 6 && !strncmp(s, "bottom", 6)) *edge = PANEL_BOTTOM;
	else if (n == 4 && !strncmp(s, "left", 4)) *edge = PANEL_LEFT;
	else if (n == 5 && !strncmp(s, "right", 5)) *edge = PANEL_RIGHT;
	else return false;
	char *end;
	errno = 0;
	long v = strtol(colon + 1, &end, 10);
	if (errno || end == colon + 1 || *end || v <= 0 || v > 16384)
		return false;
	*size = (int32_t)v;
	return true;
}

static bool parse_wxh(const char *s, int32_t *w, int32_t *h)
{
	int a, b;
	char extra;
	if (sscanf(s, "%dx%d%c", &a, &b, &extra) != 2 || a < 0 || b < 0)
		return false;
	*w = a;
	*h = b;
	return true;
}

/* "W,H,MS": all non-negative, W and H at most 16384. */
static bool parse_late_min(const char *s)
{
	int a, b;
	long long ms;
	char extra;
	if (sscanf(s, "%d,%d,%lld%c", &a, &b, &ms, &extra) != 3 || a < 0 || b < 0 || a > 16384 ||
	    b > 16384 || ms < 0)
		return false;
	g.have_late_min = true;
	g.late_min_w = a;
	g.late_min_h = b;
	g.late_min_delay_ms = ms;
	return true;
}

static bool parse_i64(const char *s, int64_t *out)
{
	char *end;
	errno = 0;
	long long v = strtoll(s, &end, 10);
	if (errno || end == s || *end)
		return false;
	*out = v;
	return true;
}

static int parse_args(int argc, char **argv)
{
	enum {
		O_APPID = 256, O_TITLE, O_ID, O_SIZE, O_MIN, O_MAX, O_DELAY, O_DMODE, O_IGNORE,
		O_FIXED, O_PARENT, O_EXIT, O_SSD, O_CSD, O_CLAMP, O_PANEL, O_OUTPUT, O_HELP, O_EXITMAP,
		O_LATEMIN, O_EXITAFTERMAP
	};
	static const struct option opts[] = {
		{"app-id", required_argument, NULL, O_APPID},
		{"title", required_argument, NULL, O_TITLE},
		{"id", required_argument, NULL, O_ID},
		{"size", required_argument, NULL, O_SIZE},
		{"min", required_argument, NULL, O_MIN},
		{"max", required_argument, NULL, O_MAX},
		{"configure-delay-ms", required_argument, NULL, O_DELAY},
		{"delay-mode", required_argument, NULL, O_DMODE},
		{"ignore-size", no_argument, NULL, O_IGNORE},
		{"fixed", no_argument, NULL, O_FIXED},
		{"clamp", no_argument, NULL, O_CLAMP},
		{"parent-after-ms", required_argument, NULL, O_PARENT},
		{"exit-after-ms", required_argument, NULL, O_EXIT},
		{"exit-on-map", no_argument, NULL, O_EXITMAP},
		{"exit-after-map-ms", required_argument, NULL, O_EXITAFTERMAP},
		{"late-min-size", required_argument, NULL, O_LATEMIN},
		{"ssd", no_argument, NULL, O_SSD},
		{"csd", no_argument, NULL, O_CSD},
		{"panel", required_argument, NULL, O_PANEL},
		{"output", required_argument, NULL, O_OUTPUT},
		{"help", no_argument, NULL, O_HELP},
		{0, 0, 0, 0},
	};
	g.app_id = "plastile-fixture";
	g.title = NULL;
	g.init_w = 400;
	g.init_h = 300;
	g.parent_after_ms = -1;
	g.exit_after_ms = -1;
	g.exit_after_map_ms = -1;
	bool fixed = false;
	int c;
	while ((c = getopt_long(argc, argv, "h", opts, NULL)) != -1) {
		switch (c) {
		case O_APPID: g.app_id = optarg; break;
		case O_TITLE: g.title = optarg; break;
		case O_ID:
			if (!parse_i64(optarg, &g.id)) goto bad;
			break;
		case O_SIZE:
			if (!parse_wxh(optarg, &g.init_w, &g.init_h) || g.init_w == 0 || g.init_h == 0) goto bad;
			break;
		case O_MIN:
			if (!parse_wxh(optarg, &g.min_w, &g.min_h)) goto bad;
			g.have_min = true;
			break;
		case O_MAX:
			if (!parse_wxh(optarg, &g.max_w, &g.max_h)) goto bad;
			g.have_max = true;
			break;
		case O_DELAY:
			if (!parse_i64(optarg, &g.cfg_delay_ms) || g.cfg_delay_ms < 0) goto bad;
			break;
		case O_DMODE:
			if (!strcmp(optarg, "latest")) g.delay_mode = DELAY_LATEST;
			else if (!strcmp(optarg, "each")) g.delay_mode = DELAY_EACH;
			else goto bad;
			break;
		case O_IGNORE: g.ignore_size = true; break;
		case O_FIXED: fixed = true; break;
		case O_CLAMP: g.clamp = true; break;
		case O_PARENT:
			if (!parse_i64(optarg, &g.parent_after_ms) || g.parent_after_ms < 0) goto bad;
			break;
		case O_EXIT:
			if (!parse_i64(optarg, &g.exit_after_ms) || g.exit_after_ms < 0) goto bad;
			break;
		case O_EXITMAP: g.exit_on_map = true; break;
		case O_EXITAFTERMAP:
			if (!parse_i64(optarg, &g.exit_after_map_ms) || g.exit_after_map_ms < 0) goto bad;
			break;
		case O_LATEMIN:
			if (!parse_late_min(optarg)) goto bad;
			break;
		case O_SSD: g.deco_req = DECO_SSD; break;
		case O_CSD: g.deco_req = DECO_CSD; break;
		case O_PANEL:
			if (!parse_panel(optarg, &g.panel_edge, &g.panel_size)) goto bad;
			break;
		case O_OUTPUT: g.panel_output = optarg; break;
		case 'h':
		case O_HELP: usage(stdout); exit(0);
		default: goto bad;
		}
	}
	if (optind != argc)
		goto bad;
	if (g.panel_output && g.panel_edge == PANEL_NONE)
		goto bad; /* --output only means something for a panel */
	if (g.panel_edge != PANEL_NONE && (g.exit_on_map || g.have_late_min || g.exit_after_map_ms >= 0))
		goto bad; /* toplevel-only options */
	if ((g.exit_on_map ? 1 : 0) + (g.exit_after_map_ms >= 0 ? 1 : 0) + (g.exit_after_ms >= 0 ? 1 : 0) > 1)
		goto bad; /* one exit point at a time (the timed ones share a timer) */
	if (fixed) {
		g.have_min = g.have_max = true;
		g.min_w = g.max_w = g.init_w;
		g.min_h = g.max_h = g.init_h;
	}
	if (!g.title) {
		snprintf(g.title_buf, sizeof(g.title_buf), "plastile-fixture %" PRId64, g.id);
		g.title = g.title_buf;
	}
	return 0;
bad:
	usage(stderr);
	return -1;
}

static void log_start(int argc, char **argv)
{
	lstart("start");
	lint("pid", getpid());
	lraw(",\"args\":[");
	for (int i = 0; i < argc; i++) {
		if (i)
			lraw(",");
		lesc(argv[i]);
	}
	lraw("]");
	lstr("app_id", g.app_id);
	lint("id", g.id);
	lstr("title", g.title);
	lprintf(",\"size\":[%d,%d]", g.init_w, g.init_h);
	if (g.have_min)
		lprintf(",\"min\":[%d,%d]", g.min_w, g.min_h);
	if (g.have_max)
		lprintf(",\"max\":[%d,%d]", g.max_w, g.max_h);
	lint("configure_delay_ms", g.cfg_delay_ms);
	lstr("delay_mode", g.delay_mode == DELAY_LATEST ? "latest" : "each");
	lbool("ignore_size", g.ignore_size);
	lbool("clamp", g.clamp);
	if (g.exit_on_map)
		lbool("exit_on_map", true);
	if (g.exit_after_map_ms >= 0)
		lint("exit_after_map_ms", g.exit_after_map_ms);
	if (g.have_late_min)
		lprintf(",\"late_min_size\":[%d,%d,%lld]", g.late_min_w, g.late_min_h, (long long)g.late_min_delay_ms);
	lstr("decoration_request", g.deco_req == DECO_SSD ? "server_side"
				   : g.deco_req == DECO_CSD ? "client_side"
							    : NULL);
	if (g.panel_edge != PANEL_NONE) {
		lstr("panel_edge", panel_edge_name(g.panel_edge));
		lint("panel_size", g.panel_size);
		lstr("panel_output", g.panel_output);
	}
	lstr("log_clock", "CLOCK_MONOTONIC");
	lend();
}

/* ------------------------------------------------------------------------ */
/* Main loop                                                                 */
/* ------------------------------------------------------------------------ */

static bool check_display(void)
{
	int err = wl_display_get_error(g.display);
	if (err) {
		uint32_t code = 0, id = 0;
		const struct wl_interface *iface = NULL;
		if (err == EPROTO) {
			code = wl_display_get_protocol_error(g.display, &iface, &id);
			log_error("protocol error %u on %s@%u", code, iface ? iface->name : "?", id);
		} else {
			log_error("display error: %s", strerror(err));
		}
		g.running = false;
		g.exit_reason = "display-error";
		g.exit_code = 1;
		return false;
	}
	return true;
}

static void run_loop(void)
{
	int wl_fd = wl_display_get_fd(g.display);
	while (g.running) {
		while (wl_display_prepare_read(g.display) != 0) {
			if (wl_display_dispatch_pending(g.display) < 0)
				break;
		}
		if (!check_display()) {
			wl_display_cancel_read(g.display);
			break;
		}
		if (!g.running) {
			wl_display_cancel_read(g.display);
			break;
		}
		short wl_events = POLLIN;
		if (wl_display_flush(g.display) < 0) {
			if (errno == EAGAIN) {
				wl_events |= POLLOUT;
			} else {
				wl_display_cancel_read(g.display);
				log_error("wl_display_flush: %s", strerror(errno));
				g.exit_reason = "display-error";
				g.exit_code = 1;
				break;
			}
		}

		struct pollfd fds[8];
		int n = 0;
		int i_wl = n;
		fds[n++] = (struct pollfd){.fd = wl_fd, .events = wl_events};
		int i_sig = n;
		fds[n++] = (struct pollfd){.fd = g.sig_fd, .events = POLLIN};
		int i_exit = n;
		fds[n++] = (struct pollfd){.fd = g.exit_tfd, .events = POLLIN};
		int i_parent = n;
		fds[n++] = (struct pollfd){.fd = g.parent_tfd, .events = POLLIN};
		int i_late = n;
		fds[n++] = (struct pollfd){.fd = g.late_min_tfd, .events = POLLIN};
		int i_mcfg = n;
		fds[n++] = (struct pollfd){.fd = g.main_win.cfg_tfd, .events = POLLIN};
		int i_ccfg = -1;
		if (g.child_exists) {
			i_ccfg = n;
			fds[n++] = (struct pollfd){.fd = g.child_win.cfg_tfd, .events = POLLIN};
		}
		int i_stdin = -1;
		if (g.stdin_open) {
			i_stdin = n;
			fds[n++] = (struct pollfd){.fd = STDIN_FILENO, .events = POLLIN};
		}

		int r = poll(fds, (nfds_t)n, -1);
		if (r < 0) {
			wl_display_cancel_read(g.display);
			if (errno == EINTR)
				continue;
			log_error("poll: %s", strerror(errno));
			g.exit_reason = "poll-error";
			g.exit_code = 1;
			break;
		}
		if (fds[i_wl].revents & (POLLIN | POLLERR | POLLHUP)) {
			if (wl_display_read_events(g.display) < 0) {
				check_display();
				if (g.running) {
					log_error("wl_display_read_events: %s", strerror(errno));
					g.exit_reason = "display-error";
					g.exit_code = 1;
				}
				break;
			}
		} else {
			wl_display_cancel_read(g.display);
		}
		wl_display_dispatch_pending(g.display);
		if (!check_display())
			break;

		if (fds[i_sig].revents & POLLIN) {
			struct signalfd_siginfo si;
			if (read(g.sig_fd, &si, sizeof(si)) == (ssize_t)sizeof(si)) {
				lstart("signal");
				luint("signo", si.ssi_signo);
				lend();
				g.running = false;
				g.exit_reason = "signal";
			}
		}
		if (fds[i_exit].revents & POLLIN) {
			drain_timer(g.exit_tfd);
			g.running = false;
			g.exit_reason = g.exit_after_map_ms >= 0 ? "exit-after-map" : "exit-after";
		}
		if (g.running && (fds[i_parent].revents & POLLIN)) {
			drain_timer(g.parent_tfd);
			spawn_child();
		}
		if (g.running && (fds[i_late].revents & POLLIN)) {
			drain_timer(g.late_min_tfd);
			apply_late_min();
		}
		if (g.running && (fds[i_mcfg].revents & POLLIN))
			cfg_timer_fired(&g.main_win);
		/* The child may have been destroyed by events dispatched above. */
		if (g.running && i_ccfg >= 0 && g.child_exists && (fds[i_ccfg].revents & POLLIN))
			cfg_timer_fired(&g.child_win);
		if (g.running && i_stdin >= 0 && g.stdin_open && (fds[i_stdin].revents & (POLLIN | POLLHUP | POLLERR)))
			handle_stdin();
	}
}

int main(int argc, char **argv)
{
	setvbuf(stdout, NULL, _IOLBF, 0);
	signal(SIGPIPE, SIG_IGN);
	if (parse_args(argc, argv) < 0)
		return 2;
	log_start(argc, argv);

	sigset_t mask;
	sigemptyset(&mask);
	sigaddset(&mask, SIGINT);
	sigaddset(&mask, SIGTERM);
	sigaddset(&mask, SIGHUP);
	sigprocmask(SIG_BLOCK, &mask, NULL);
	g.sig_fd = signalfd(-1, &mask, SFD_NONBLOCK | SFD_CLOEXEC);
	g.exit_tfd = timerfd_create(CLOCK_MONOTONIC, TFD_NONBLOCK | TFD_CLOEXEC);
	g.parent_tfd = timerfd_create(CLOCK_MONOTONIC, TFD_NONBLOCK | TFD_CLOEXEC);
	g.late_min_tfd = timerfd_create(CLOCK_MONOTONIC, TFD_NONBLOCK | TFD_CLOEXEC);
	g.main_win.cfg_tfd = g.child_win.cfg_tfd = -1;
	if (g.sig_fd < 0 || g.exit_tfd < 0 || g.parent_tfd < 0 || g.late_min_tfd < 0) {
		log_error("fd setup failed: %s", strerror(errno));
		return 1;
	}

	g.display = wl_display_connect(NULL);
	if (!g.display) {
		log_error("wl_display_connect failed: %s", strerror(errno));
		return 1;
	}
	g.registry = wl_display_get_registry(g.display);
	wl_registry_add_listener(g.registry, &registry_listener, NULL);
	wl_display_roundtrip(g.display);
	log_bound();
	wl_display_roundtrip(g.display); /* shm formats, presentation clock id, wl_output names */

	g.running = true;
	g.exit_reason = "unknown";
	g.stdin_open = true;
	bool panel = g.panel_edge != PANEL_NONE;
	if (!g.compositor || !g.shm || (!panel && !g.wm_base) || (panel && !g.layer_shell)) {
		log_error("missing required global (wl_compositor, wl_shm, %s)",
			  panel ? "zwlr_layer_shell_v1" : "xdg_wm_base");
		g.exit_reason = "missing-globals";
		g.exit_code = 1;
		g.running = false;
	} else if (!g.shm_xrgb) {
		log_error("wl_shm does not advertise XRGB8888");
	}
	if (g.running && panel) {
		if (!panel_create(&g.main_win, g.panel_edge, g.panel_size, g.panel_output)) {
			g.exit_reason = "window-create-failed";
			g.exit_code = 1;
			g.running = false;
		}
	} else if (g.running && !window_create(&g.main_win, "main", false, g.title, g.init_w, g.init_h)) {
		g.exit_reason = "window-create-failed";
		g.exit_code = 1;
		g.running = false;
	}
	if (g.running && g.exit_after_ms >= 0)
		arm_timer_abs(g.exit_tfd, now_ns() + (uint64_t)g.exit_after_ms * 1000000ull);

	if (g.running)
		run_loop();

	/* Teardown: everything we created, in reverse order. */
	disarm_timer(g.exit_tfd);
	disarm_timer(g.parent_tfd);
	disarm_timer(g.late_min_tfd);
	if (g.child_exists)
		window_destroy(&g.child_win);
	if (g.main_win.surface || g.main_win.cfg_tfd >= 0)
		window_destroy(&g.main_win);
	if (g.deco_mgr)
		zxdg_decoration_manager_v1_destroy(g.deco_mgr);
	if (g.layer_shell) {
		if (g.layer_ver >= 3)
			zwlr_layer_shell_v1_destroy(g.layer_shell);
		else
			wl_proxy_destroy((struct wl_proxy *)g.layer_shell);
	}
	for (int i = 0; i < g.n_outputs; i++) {
		if (g.output_ver >= 3)
			wl_output_release(g.outputs[i].wl);
		else
			wl_proxy_destroy((struct wl_proxy *)g.outputs[i].wl);
	}
	if (g.presentation)
		wp_presentation_destroy(g.presentation);
	if (g.wm_base)
		xdg_wm_base_destroy(g.wm_base);
	if (g.shm)
		wl_shm_destroy(g.shm);
	if (g.compositor)
		wl_compositor_destroy(g.compositor);
	if (g.registry)
		wl_registry_destroy(g.registry);
	wl_display_flush(g.display);
	wl_display_disconnect(g.display);
	close(g.exit_tfd);
	close(g.parent_tfd);
	close(g.late_min_tfd);
	close(g.sig_fd);

	lstart("exit");
	lstr("reason", g.exit_reason);
	lint("code", g.exit_code);
	luint("commits", g.seq);
	lend();
	return g.exit_code;
}
