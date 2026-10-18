# Test-only: drives package/contents/config/main.xml + contents/ui/config.ui exactly
# as KWin's generic scripted KCM does (KConfigLoader + QUiLoader + KConfigDialogManager).
cmake_minimum_required(VERSION 3.21)
project(plastile_settings_check LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 17)
find_package(Qt6 REQUIRED COMPONENTS Widgets UiTools)
find_package(KF6Config REQUIRED)
find_package(KF6ConfigWidgets REQUIRED)
add_executable(plastile-settings-check main.cpp)
target_link_libraries(plastile-settings-check Qt6::Widgets Qt6::UiTools KF6::ConfigCore KF6::ConfigGui KF6::ConfigWidgets)
target_compile_options(plastile-settings-check PRIVATE -Wall -Wextra -Werror)
