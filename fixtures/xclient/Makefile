# Build the plastile-xclient X11 (xcb) test client.
#   make            -> build/plastile-xclient
#   make clean

PKG_CONFIG ?= pkg-config
CC ?= cc
CFLAGS ?= -O2
CFLAGS += -std=c11 -Wall -Wextra -Werror
CPPFLAGS += $(shell $(PKG_CONFIG) --cflags xcb xcb-icccm)
LDLIBS += $(shell $(PKG_CONFIG) --libs xcb xcb-icccm)

BUILD := build

all: $(BUILD)/plastile-xclient

$(BUILD):
	mkdir -p $@

$(BUILD)/plastile-xclient: plastile-xclient.c | $(BUILD)
	$(CC) $(CPPFLAGS) $(CFLAGS) $(LDFLAGS) $< $(LDLIBS) -o $@

clean:
	rm -rf $(BUILD)

.PHONY: all clean
