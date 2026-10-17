# Measurement-only QML module for nested-session probes. Never shipped in the
# Plastile runtime package; loaded only through QML_IMPORT_PATH in test sessions.
cmake_minimum_required(VERSION 3.21)
project(plastile_measure LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
find_package(Qt6 REQUIRED COMPONENTS Qml)
qt_standard_project_setup(REQUIRES 6.5)
qt_add_qml_module(plastile_measure
    URI Plastile.Measure
    VERSION 1.0
    PLUGIN_TARGET plastile_measure
    OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/qml/Plastile/Measure
    SOURCES monotonicclock.h monotonicclock.cpp
)
target_compile_options(plastile_measure PRIVATE -Wall -Wextra -Werror)
