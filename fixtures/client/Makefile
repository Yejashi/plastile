# Build the plastile-fixture Wayland test client.
#   make            -> build/plastile-fixture
#   make clean

PKG_CONFIG ?= pkg-config
WAYLAND_SCANNER ?= $(shell $(PKG_CONFIG) --variable=wayland_scanner wayland-scanner 2>/dev/null || echo wayland-scanner)
WL_PROTOCOLS := $(shell $(PKG_CONFIG) --variable=pkgdatadir wayland-protocols)

CC ?= cc
CFLAGS ?= -O2
CFLAGS += -std=c11 -Wall -Wextra -Werror
CPPFLAGS += -Ibuild $(shell $(PKG_CONFIG) --cflags wayland-client)
LDLIBS += $(shell $(PKG_CONFIG) --libs wayland-client)

BUILD := build
PROTOCOLS := \
	xdg-shell:$(WL_PROTOCOLS)/stable/xdg-shell/xdg-shell.xml \
	presentation-time:$(WL_PROTOCOLS)/stable/presentation-time/presentation-time.xml \
	xdg-decoration-unstable-v1:$(WL_PROTOCOLS)/unstable/xdg-decoration/xdg-decoration-unstable-v1.xml

proto_name = $(word 1,$(subst :, ,$(1)))
proto_xml = $(word 2,$(subst :, ,$(1)))
PROTO_NAMES := $(foreach p,$(PROTOCOLS),$(call proto_name,$(p)))
PROTO_HEADERS := $(PROTO_NAMES:%=$(BUILD)/%-client-protocol.h)
PROTO_SOURCES := $(PROTO_NAMES:%=$(BUILD)/%-protocol.c)
OBJS := $(BUILD)/plastile-fixture.o $(PROTO_SOURCES:.c=.o)

all: $(BUILD)/plastile-fixture

$(BUILD):
	mkdir -p $@

define proto_rules
$(BUILD)/$(call proto_name,$(1))-client-protocol.h: $(call proto_xml,$(1)) | $(BUILD)
	$(WAYLAND_SCANNER) client-header $$< $$@
$(BUILD)/$(call proto_name,$(1))-protocol.c: $(call proto_xml,$(1)) | $(BUILD)
	$(WAYLAND_SCANNER) private-code $$< $$@
endef
$(foreach p,$(PROTOCOLS),$(eval $(call proto_rules,$(p))))

$(BUILD)/%.o: $(BUILD)/%.c $(PROTO_HEADERS)
	$(CC) $(CPPFLAGS) $(CFLAGS) -c $< -o $@

$(BUILD)/plastile-fixture.o: plastile-fixture.c $(PROTO_HEADERS) | $(BUILD)
	$(CC) $(CPPFLAGS) $(CFLAGS) -c $< -o $@

$(BUILD)/plastile-fixture: $(OBJS)
	$(CC) $(LDFLAGS) $^ $(LDLIBS) -o $@

clean:
	rm -rf $(BUILD)

.PHONY: all clean
