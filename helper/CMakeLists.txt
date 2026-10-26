# plastile-state: Plastile's persistence helper (ADR-020). A small session-bus service that
# stores Plastile's saved-state text in two files so KWin's compositor thread never does
# persistence file I/O. Qt6 Core + DBus only.
#
#   cmake -S helper -B build/helper -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=$HOME/.local
#   cmake --build build/helper
#   cmake --install build/helper     # or tools/install.sh install-helper
#
# Installs bin: <libexecdir>/plastile-state and the D-Bus activation file
# <PLASTILE_DBUS_SERVICE_DIR>/org.kde.plastile.State.service (Exec= the installed binary).
# Choose the prefix when configuring: the activation file's Exec= and its directory are
# fixed then, so `cmake --install --prefix` would put the binary elsewhere than both.
cmake_minimum_required(VERSION 3.21)
project(plastile_state VERSION 0.1.0 LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
include(GNUInstallDirs)
find_package(Qt6 REQUIRED COMPONENTS Core DBus)
qt_standard_project_setup(REQUIRES 6.5)

set(PLASTILE_DBUS_SERVICE_DIR "${CMAKE_INSTALL_FULL_DATADIR}/dbus-1/services" CACHE PATH
    "Directory the session bus reads activation files from (default: <datadir>/dbus-1/services)")

qt_add_executable(plastile-state main.cpp stateservice.h stateservice.cpp)
target_link_libraries(plastile-state PRIVATE Qt6::Core Qt6::DBus)
target_compile_options(plastile-state PRIVATE -Wall -Wextra -Werror)
target_compile_definitions(plastile-state PRIVATE QT_NO_CAST_FROM_ASCII QT_NO_CAST_TO_ASCII
    PLASTILE_STATE_VERSION="${PROJECT_VERSION}")

set(PLASTILE_STATE_EXEC "${CMAKE_INSTALL_FULL_LIBEXECDIR}/plastile-state")
# The session bus splits Exec= like a shell command line, so the activation file writes the path in
# double quotes (a prefix with spaces stays one argument). A path holding a character that would end
# or escape inside those quotes is refused rather than escaped.
if(PLASTILE_STATE_EXEC MATCHES "[\"\\\\$`\n]")
  message(FATAL_ERROR "The helper's install path ${PLASTILE_STATE_EXEC} contains a double quote, backslash, $, "
                      "backquote or newline, which its D-Bus activation file cannot name: choose another prefix")
endif()
configure_file(org.kde.plastile.State.service.in ${CMAKE_CURRENT_BINARY_DIR}/org.kde.plastile.State.service @ONLY)

install(TARGETS plastile-state RUNTIME DESTINATION ${CMAKE_INSTALL_LIBEXECDIR})
install(FILES ${CMAKE_CURRENT_BINARY_DIR}/org.kde.plastile.State.service DESTINATION ${PLASTILE_DBUS_SERVICE_DIR})
