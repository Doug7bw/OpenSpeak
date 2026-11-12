
# ---------------------------------------------------------------- motor
# Biblioteca separada da UI para os testes poderem usá-la.
find_package(Qt6 REQUIRED COMPONENTS MultimediaPrivate)
add_library(openspeak_engine STATIC
    core/ServerConnection.cpp core/ServerConnection.h
    core/ConnectionHandler.cpp core/ConnectionHandler.h
    core/ClientLog.cpp core/ClientLog.h
    core/Settings.cpp core/Settings.h
    core/AutoUpdater.cpp core/AutoUpdater.h core/UpdatePolicy.cpp core/UpdatePolicy.h
    mesh/PeerDirectory.cpp mesh/PeerDirectory.h
    mesh/MeshConnection.cpp mesh/MeshConnection.h
    media/VideoSource.cpp media/VideoSource.h
    media/WindowGrabber.cpp media/WindowGrabber.h
    media/SourceThumbnails.cpp media/SourceThumbnails.h
    media/VideoEncoder.cpp media/VideoEncoder.h
    media/VideoDecoder.cpp media/VideoDecoder.h
    media/AudioCodec.cpp media/AudioCodec.h
    media/AudioCapture.cpp media/AudioCapture.h
    media/AudioPlayer.cpp media/AudioPlayer.h
    rtc/SessionOutbound.cpp rtc/SessionOutbound.h
    rtc/SessionInbound.cpp rtc/SessionInbound.h
    video/Presets.h
    video/StreamStats.cpp video/StreamStats.h
    video/Layout.cpp video/Layout.h
    video/ScreenshareManager.cpp video/ScreenshareManager.h
)
target_include_directories(openspeak_engine PUBLIC core media mesh rtc video)
target_link_libraries(openspeak_engine PUBLIC
    openspeak_common
    openspeak_rtc
    Qt6::Core Qt6::Gui Qt6::Multimedia Qt6::WebSockets
    openspeak_ffmpeg
    ole32 mmdevapi d3d11 dxgi dwmapi gdi32 user32 shell32 version
)
target_link_libraries(openspeak_engine PRIVATE Qt6::MultimediaPrivate dwmapi)
target_compile_definitions(openspeak_engine PUBLIC NOMINMAX WIN32_LEAN_AND_MEAN)
target_precompile_headers(openspeak_engine PRIVATE ${OPENSPEAK_PCH})

# ---------------------------------------------------------------- app
find_package(Qt6 REQUIRED COMPONENTS MultimediaPrivate)
find_package(Qt6 REQUIRED COMPONENTS Widgets Network GuiPrivate)
qt_add_executable(OpenSpeak WIN32 main.cpp WindowThumbnail.cpp WindowThumbnail.h TrayIcon.cpp TrayIcon.h AppIcon.cpp AppIcon.h NativeWindow.cpp NativeWindow.h NvidiaProfile.cpp NvidiaProfile.h SoundEffects.cpp SoundEffects.h assets/OpenSpeak.rc)
qt_add_resources(OpenSpeak app_icon PREFIX "/" FILES assets/openspeak.ico)
# O compilador de recursos não declara o .ico como dependência: sem isto, trocar o
# ícone não refaz o .res e o .exe (menu Iniciar, atalhos) continua com o antigo.
set_source_files_properties(assets/OpenSpeak.rc PROPERTIES OBJECT_DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/assets/openspeak.ico")
# Efeitos sonoros (gerados por scripts/gen_sounds.py), servidos em qrc:/sounds/<tema>/<evento>.wav.
file(GLOB OPENSPEAK_SOUNDS RELATIVE "${CMAKE_CURRENT_SOURCE_DIR}" CONFIGURE_DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/assets/sounds/*/*.wav")
qt_add_resources(OpenSpeak app_sounds PREFIX "/" BASE assets FILES ${OPENSPEAK_SOUNDS})
# Novidades da versão (Atualizações › Novidades), em qrc:/changelog.md.
set_source_files_properties(../CHANGELOG.md PROPERTIES QT_RESOURCE_ALIAS changelog.md)
qt_add_resources(OpenSpeak app_changelog PREFIX "/" FILES ../CHANGELOG.md)
# Licenças de terceiros (Preferências › Licenças e créditos), em qrc:/licenses.md.
set_source_files_properties(../../THIRD_PARTY_LICENSES.md PROPERTIES QT_RESOURCE_ALIAS licenses.md)
qt_add_resources(OpenSpeak app_licenses PREFIX "/" FILES ../../THIRD_PARTY_LICENSES.md)
set_target_properties(OpenSpeak PROPERTIES OUTPUT_NAME "OpenSpeak")

set_source_files_properties(qml/Theme.qml PROPERTIES QT_QML_SINGLETON_TYPE TRUE)
qt_add_qml_module(OpenSpeak
    URI OpenSpeak
    VERSION 1.0
    QML_FILES
        qml/Main.qml
        qml/Avatar.qml
        qml/AvatarCropDialog.qml
        qml/ChangelogDialog.qml
        qml/PasswordField.qml
        qml/ProfileBanner.qml
        qml/ProfileCard.qml
        qml/LoginView.qml
        qml/MainView.qml
        qml/ChannelTree.qml
        qml/StreamArea.qml
        qml/StreamTile.qml
        qml/SetupStreamDialog.qml
        qml/ViewersPanel.qml
        qml/StatsPanel.qml
        qml/StatGraph.qml
        qml/Toasts.qml
        qml/Theme.qml
        qml/Icon.qml
        qml/ViewerCount.qml
        qml/VolumeSlider.qml
        qml/AppSlider.qml
        qml/ResizeHandles.qml
        qml/AppearanceSettings.qml
        qml/SettingsDialog.qml
        qml/I18n.js
)

# Widgets: QSystemTrayIcon/QMenu do ícone na bandeja. Network: QLocalServer (instância única).
target_link_libraries(OpenSpeak PRIVATE openspeak_engine Qt6::Quick Qt6::QuickControls2 Qt6::Widgets Qt6::Network Qt6::GuiPrivate Qt6::MultimediaPrivate dwmapi shell32)

if(OPENSPEAK_BUILD_TESTS)
    find_package(Qt6 REQUIRED COMPONENTS Test)
    qt_add_executable(tst_windowthumbnail ../tests/client/tst_windowthumbnail.cpp WindowThumbnail.cpp WindowThumbnail.h)
    target_include_directories(tst_windowthumbnail PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}")
    target_compile_definitions(tst_windowthumbnail PRIVATE NOMINMAX WIN32_LEAN_AND_MEAN)
    target_link_libraries(tst_windowthumbnail PRIVATE Qt6::Quick Qt6::MultimediaPrivate Qt6::Test dwmapi)
endif()

# Copia as DLLs do Qt ao lado do .exe (executável autônomo).
find_program(WINDEPLOYQT windeployqt HINTS "${Qt6_DIR}/../../../bin")
if(WINDEPLOYQT)
    add_custom_command(TARGET OpenSpeak POST_BUILD
        COMMAND "${WINDEPLOYQT}" --no-translations --no-system-d3d-compiler --qmldir "${CMAKE_CURRENT_SOURCE_DIR}/qml" "$<TARGET_FILE:OpenSpeak>"
        COMMENT "windeployqt OpenSpeak")
endif()
