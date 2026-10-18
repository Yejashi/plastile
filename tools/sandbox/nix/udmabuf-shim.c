/* Userspace stand-in for /dev/udmabuf, for test machines whose kernel has neither a
 * DRM render node nor CONFIG_UDMABUF (e.g. CI containers and microVMs).
 *
 * KWin 6.8 removed QPainter compositing; without a render node its only renderer is
 * Mesa's software device (llvmpipe), which KWin creates only when /dev/udmabuf opens
 * (KWin v6.8.0 src/core/gpumanager.cpp, GpuManager::GpuManager). env.nix preloads this
 * library into kwin_wayland only when /dev/udmabuf and /dev/dri/renderD* are both
 * absent. It emulates the udmabuf ioctls by handing back a duplicate of the sealed
 * memfd, which llvmpipe maps like a dma-buf:
 *
 *  - open("/dev/udmabuf") returns a descriptor on /dev/null that is remembered;
 *  - UDMABUF_CREATE and single-item UDMABUF_CREATE_LIST on it return dup(memfd) when
 *    the kernel would accept the request and the range starts at offset 0 (a
 *    whole-file duplicate cannot express a non-zero offset, so those fail with EINVAL
 *    and KWin falls back to copying, as it does for any udmabuf error);
 *  - the kernel's checks are kept: memfd sealed against shrinking and not against
 *    writing, page-aligned offset and size, range inside the file.
 *
 * Differences from a real dma-buf: DMA_BUF_IOCTL_SYNC fails with ENOTTY (KWin ignores
 * the result) and there are no implicit fences. Test infrastructure, not Plastile code.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/udmabuf.h>
#include <stdarg.h>
#include <stdint.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <unistd.h>

#define MAX_FDS 4096
static unsigned char shim_fds[MAX_FDS];
static dev_t null_rdev;

static int is_udmabuf_path(const char *path)
{
    return path && strcmp(path, "/dev/udmabuf") == 0;
}

static int open_stand_in(int flags)
{
    static int (*real_open)(const char *, int, ...);
    struct stat st;
    if (!real_open)
        real_open = (int (*)(const char *, int, ...))dlsym(RTLD_NEXT, "open");
    int fd = real_open("/dev/null", O_RDWR | (flags & O_CLOEXEC));
    if (fd >= 0 && fd < MAX_FDS && fstat(fd, &st) == 0) {
        null_rdev = st.st_rdev;
        shim_fds[fd] = 1;
    }
    return fd;
}

/* A remembered descriptor counts only while it still refers to /dev/null: close() is
 * not interposed, so a number reused for another file is never intercepted. */
static int is_stand_in(int fd)
{
    struct stat st;
    if (fd < 0 || fd >= MAX_FDS || !shim_fds[fd])
        return 0;
    if (fstat(fd, &st) == 0 && S_ISCHR(st.st_mode) && st.st_rdev == null_rdev)
        return 1;
    shim_fds[fd] = 0;
    return 0;
}

#define OPEN_WRAPPER(name)                                                            \
    int name(const char *path, int flags, ...)                                       \
    {                                                                                 \
        static int (*real)(const char *, int, ...);                                   \
        mode_t mode = 0;                                                              \
        if (flags & (O_CREAT | O_TMPFILE)) {                                          \
            va_list ap;                                                               \
            va_start(ap, flags);                                                      \
            mode = va_arg(ap, mode_t);                                                \
            va_end(ap);                                                               \
        }                                                                             \
        if (is_udmabuf_path(path))                                                    \
            return open_stand_in(flags);                                              \
        if (!real)                                                                    \
            real = (int (*)(const char *, int, ...))dlsym(RTLD_NEXT, #name);          \
        return real(path, flags, mode);                                               \
    }
OPEN_WRAPPER(open)
OPEN_WRAPPER(open64)

#define OPENAT_WRAPPER(name)                                                          \
    int name(int dirfd, const char *path, int flags, ...)                            \
    {                                                                                 \
        static int (*real)(int, const char *, int, ...);                              \
        mode_t mode = 0;                                                              \
        if (flags & (O_CREAT | O_TMPFILE)) {                                          \
            va_list ap;                                                               \
            va_start(ap, flags);                                                      \
            mode = va_arg(ap, mode_t);                                                \
            va_end(ap);                                                               \
        }                                                                             \
        if (is_udmabuf_path(path))                                                    \
            return open_stand_in(flags);                                              \
        if (!real)                                                                    \
            real = (int (*)(int, const char *, int, ...))dlsym(RTLD_NEXT, #name);     \
        return real(dirfd, path, flags, mode);                                        \
    }
OPENAT_WRAPPER(openat)
OPENAT_WRAPPER(openat64)

/* _FORTIFY_SOURCE variants (no O_CREAT, so no mode argument). */
int __open_2(const char *path, int flags) { return open(path, flags); }
int __open64_2(const char *path, int flags) { return open64(path, flags); }
int __openat_2(int dirfd, const char *path, int flags) { return openat(dirfd, path, flags); }
int __openat64_2(int dirfd, const char *path, int flags) { return openat64(dirfd, path, flags); }

static int create_one(int memfd, uint32_t flags, uint64_t offset, uint64_t size)
{
    const uint64_t page = (uint64_t)sysconf(_SC_PAGESIZE);
    struct stat st;
    int seals = fcntl(memfd, F_GET_SEALS);
    if (seals < 0 || !(seals & F_SEAL_SHRINK) || (seals & F_SEAL_WRITE)) {
        errno = EINVAL;
        return -1;
    }
    if (offset % page || size % page || size == 0 || fstat(memfd, &st) != 0 ||
        offset + size > (uint64_t)st.st_size) {
        errno = EINVAL;
        return -1;
    }
    if (offset != 0) {
        errno = EINVAL; /* not expressible as a whole-file duplicate */
        return -1;
    }
    return fcntl(memfd, (flags & UDMABUF_FLAGS_CLOEXEC) ? F_DUPFD_CLOEXEC : F_DUPFD, 0);
}

int ioctl(int fd, unsigned long request, ...)
{
    static int (*real)(int, unsigned long, ...);
    va_list ap;
    va_start(ap, request);
    void *arg = va_arg(ap, void *);
    va_end(ap);
    if (request == UDMABUF_CREATE && is_stand_in(fd)) {
        const struct udmabuf_create *c = arg;
        return create_one((int)c->memfd, c->flags, c->offset, c->size);
    }
    if (request == UDMABUF_CREATE_LIST && is_stand_in(fd)) {
        const struct udmabuf_create_list *l = arg;
        if (l->count != 1) {
            errno = EINVAL;
            return -1;
        }
        return create_one((int)l->list[0].memfd, l->flags, l->list[0].offset, l->list[0].size);
    }
    if (!real)
        real = (int (*)(int, unsigned long, ...))dlsym(RTLD_NEXT, "ioctl");
    return real(fd, request, arg);
}
