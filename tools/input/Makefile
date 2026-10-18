# Test-only libei input injector for nested KWin sessions.
CFLAGS ?= -O2
CFLAGS += -std=c11 -Wall -Wextra -Werror $(shell pkg-config --cflags libei-1.0)
LDLIBS += $(shell pkg-config --libs libei-1.0)
BUILD := ../../build/input
all: $(BUILD)/plastile-input
$(BUILD)/plastile-input: plastile-input.c | $(BUILD)
	$(CC) $(CFLAGS) $< $(LDLIBS) -o $@
$(BUILD):
	mkdir -p $@
clean:
	rm -rf $(BUILD)
.PHONY: all clean
