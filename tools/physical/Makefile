# Plastile physical-session latency injector (docs/validation/PHYSICAL_RUNBOOK.md).
#   make        -> ../../build/physical/plastile-keytap     (uinput + dry backends, no dependencies)
#   make ei     -> ../../build/physical/plastile-keytap-ei  (adds the libei backend; needs libei-1.0)
#   make clean
CC ?= cc
CFLAGS ?= -O2
CFLAGS += -std=c11 -Wall -Wextra -Werror
PKG_CONFIG ?= pkg-config
BUILD := ../../build/physical

all: $(BUILD)/plastile-keytap

ei: $(BUILD)/plastile-keytap-ei

$(BUILD):
	mkdir -p $@

# Link to a temporary name and rename, so a running harness keeps a working binary.
$(BUILD)/plastile-keytap: keytap.c | $(BUILD)
	$(CC) $(CPPFLAGS) $(CFLAGS) $< $(LDFLAGS) -o $@.tmp
	mv -f $@.tmp $@

$(BUILD)/plastile-keytap-ei: keytap.c | $(BUILD)
	$(CC) $(CPPFLAGS) -DKEYTAP_LIBEI $(CFLAGS) $(shell $(PKG_CONFIG) --cflags libei-1.0) $< $(LDFLAGS) \
		$(shell $(PKG_CONFIG) --libs libei-1.0) -o $@.tmp
	mv -f $@.tmp $@

clean:
	rm -f $(BUILD)/plastile-keytap $(BUILD)/plastile-keytap-ei

.PHONY: all ei clean
