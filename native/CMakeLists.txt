cmake_minimum_required(VERSION 3.25)

project(OpenSpeakNative VERSION 1.0.5 LANGUAGES CXX)
set(OPENSPEAK_RELEASE_VERSION "${PROJECT_VERSION}" CACHE STRING "Versão completa, incluindo sufixo de pré-release")

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_AUTOMOC ON)

option(OPENSPEAK_BUILD_CLIENT "Compila o cliente (requer libdatachannel e FFmpeg via vcpkg)" ON)
option(OPENSPEAK_BUILD_SFU "Relay de mídia (STREAM_SFU) no servidor; requer libdatachannel" ON)
option(OPENSPEAK_BUILD_TESTS "Compila os testes" ON)

if(MSVC)
    add_compile_options(/utf-8 /W3 /permissive- /Zc:__cplusplus)
    # Compila os .cpp de cada alvo em paralelo (além do paralelismo entre alvos).
    add_compile_options(/MP)
endif()

find_package(Qt6 6.8 REQUIRED COMPONENTS Core Network WebSockets HttpServer)
qt_standard_project_setup(REQUIRES 6.8)

# Cabeçalhos do Qt pré-compilados: são eles que tomam a maior parte de cada .cpp.
set(OPENSPEAK_PCH <QByteArray> <QHash> <QJsonArray> <QJsonDocument> <QJsonObject> <QList> <QMap> <QObject> <QString> <QTimer> <QVariant>)

# ---------------------------------------------------------------- libdatachannel
# No escopo raiz para que cliente, servidor e testes enxerguem os alvos importados.
# O cliente exige; o servidor só a usa no relay SFU (sem ela, compila só P2P).
if(OPENSPEAK_BUILD_CLIENT)
    find_package(LibDataChannel CONFIG REQUIRED)
elseif(OPENSPEAK_BUILD_SFU)
    find_package(LibDataChannel CONFIG QUIET)
endif()
if(TARGET LibDataChannel::LibDataChannelStatic)
    set(OPENSPEAK_LDC LibDataChannel::LibDataChannelStatic)
elseif(TARGET LibDataChannel::LibDataChannel)
    set(OPENSPEAK_LDC LibDataChannel::LibDataChannel)
endif()
if(OPENSPEAK_BUILD_SFU AND NOT OPENSPEAK_LDC)
    message(WARNING "libdatachannel não encontrada: servidor sem relay SFU (só STREAM_P2P)")
    set(OPENSPEAK_BUILD_SFU OFF)
endif()

# ---------------------------------------------------------------- common
add_library(openspeak_common INTERFACE)
target_include_directories(openspeak_common INTERFACE common)

# Versão num único .cpp gerado: o configure_file só regrava o arquivo quando o conteúdo
# muda, então trocar -Version recompila apenas Version.cpp e refaz o link.
configure_file(common/Version.cpp.in "${CMAKE_CURRENT_BINARY_DIR}/generated/Version.cpp" @ONLY)
add_library(openspeak_version STATIC "${CMAKE_CURRENT_BINARY_DIR}/generated/Version.cpp" common/Version.h)
target_include_directories(openspeak_version PUBLIC common)
target_link_libraries(openspeak_version PUBLIC Qt6::Core)
target_link_libraries(openspeak_common INTERFACE openspeak_version)

# Sessão WebRTC base + ajustes de SDP, comuns ao cliente e ao relay do servidor.
if(OPENSPEAK_LDC)
    add_library(openspeak_rtc STATIC
        common/rtc/RtcSession.cpp common/rtc/RtcSession.h
        common/rtc/SdpFilter.cpp common/rtc/SdpFilter.h
        common/rtc/RtpStatsHandler.cpp common/rtc/RtpStatsHandler.h
        common/rtc/RtpRecovery.cpp common/rtc/RtpRecovery.h)
    target_include_directories(openspeak_rtc PUBLIC common/rtc)
    target_link_libraries(openspeak_rtc PUBLIC openspeak_common Qt6::Core ${OPENSPEAK_LDC})
    if(WIN32)
        target_compile_definitions(openspeak_rtc PUBLIC NOMINMAX WIN32_LEAN_AND_MEAN)
    endif()
endif()

# ---------------------------------------------------------------- servidor
# Núcleo sem mídia (VirtualServer + interface StreamRelay): usado pelo tst_virtualserver.
add_library(openspeak_server_core STATIC
    server/VirtualServer.cpp server/VirtualServer.h server/StreamRelay.h
    server/ProfileStore.cpp server/ProfileStore.h)
target_link_libraries(openspeak_server_core PUBLIC openspeak_common Qt6::Core)
target_include_directories(openspeak_server_core PUBLIC server)
target_precompile_headers(openspeak_server_core PRIVATE ${OPENSPEAK_PCH})

# Transporte (HTTP/WebSocket) + relay de mídia opcional.
add_library(openspeak_server_host STATIC server/ServerHost.cpp server/ServerHost.h
    server/DiscordAuth.cpp server/DiscordAuth.h)
target_link_libraries(openspeak_server_host PUBLIC openspeak_server_core Qt6::Network Qt6::WebSockets Qt6::HttpServer)
target_precompile_headers(openspeak_server_host PRIVATE ${OPENSPEAK_PCH})
if(OPENSPEAK_BUILD_SFU)
    target_sources(openspeak_server_host PRIVATE
        server/SfuForwarder.cpp server/SfuForwarder.h server/SfuLayerPolicy.h
        server/SfuIngest.cpp server/SfuIngest.h
        server/SfuEgress.cpp server/SfuEgress.h
        server/SfuRelay.cpp server/SfuRelay.h
        server/SfuWsViewer.cpp server/SfuWsViewer.h)
    target_link_libraries(openspeak_server_host PUBLIC openspeak_rtc)
    target_compile_definitions(openspeak_server_host PUBLIC OPENSPEAK_HAS_SFU)
endif()

qt_add_executable(openspeak-server server/main.cpp)
target_link_libraries(openspeak-server PRIVATE openspeak_server_host)

# ---------------------------------------------------------------- cliente
if(OPENSPEAK_BUILD_CLIENT)
    find_package(Qt6 6.8 REQUIRED COMPONENTS Gui Quick QuickControls2 Multimedia)
    # FFmpeg estático do vcpkg (release/debug escolhidos por configuração).
    set(_vcpkg_root "${VCPKG_INSTALLED_DIR}/${VCPKG_TARGET_TRIPLET}")
    add_library(openspeak_ffmpeg INTERFACE)
    target_include_directories(openspeak_ffmpeg INTERFACE "${_vcpkg_root}/include")
    foreach(lib avcodec swscale swresample avutil dav1d opus openh264 vpl)
        set(_dbg ${lib})
        if(lib STREQUAL "vpl")
            set(_dbg vpld)
        endif()
        target_link_libraries(openspeak_ffmpeg INTERFACE
            "$<IF:$<CONFIG:Debug>,${_vcpkg_root}/debug/lib/${_dbg}.lib,${_vcpkg_root}/lib/${lib}.lib>")
    endforeach()
    target_link_libraries(openspeak_ffmpeg INTERFACE mfuuid ole32 strmiids user32 advapi32 bcrypt)
    add_subdirectory(client)
endif()

# ---------------------------------------------------------------- testes
if(OPENSPEAK_BUILD_TESTS)
    enable_testing()
    find_package(Qt6 REQUIRED COMPONENTS Test)
    qt_add_executable(tst_virtualserver tests/tst_virtualserver.cpp)
    target_link_libraries(tst_virtualserver PRIVATE openspeak_server_core Qt6::Test)
    add_test(NAME tst_virtualserver COMMAND tst_virtualserver)
    qt_add_executable(tst_serverhost tests/tst_serverhost.cpp)
    target_link_libraries(tst_serverhost PRIVATE openspeak_server_host Qt6::Test)
    add_test(NAME tst_serverhost COMMAND tst_serverhost)
    set_tests_properties(tst_serverhost PROPERTIES TIMEOUT 30)
    if(OPENSPEAK_LDC)
        qt_add_executable(tst_rtprecovery tests/tst_rtprecovery.cpp)
        target_link_libraries(tst_rtprecovery PRIVATE openspeak_rtc Qt6::Test)
        add_test(NAME tst_rtprecovery COMMAND tst_rtprecovery)
    endif()
    if(OPENSPEAK_BUILD_SFU)
        qt_add_executable(tst_sfuforwarder tests/tst_sfuforwarder.cpp)
        target_link_libraries(tst_sfuforwarder PRIVATE openspeak_server_host Qt6::Test)
        add_test(NAME tst_sfuforwarder COMMAND tst_sfuforwarder)
    endif()
    if(OPENSPEAK_BUILD_CLIENT)
        add_subdirectory(tests/client)
        add_test(NAME tst_windowthumbnail COMMAND tst_windowthumbnail)
        # Janela real na tela: não pode disputar o foco com os testes em paralelo.
        set_tests_properties(tst_windowthumbnail PROPERTIES TIMEOUT 15 RUN_SERIAL TRUE)
        foreach(panel setup source view-menu updates preferences profile avatar-crop profile-card changelog update-notes licenses startup login login-advanced)
            add_test(NAME ui_${panel} COMMAND OpenSpeak --ui-smoke-test --profile ui-smoke-${panel} --open ${panel})
            set_tests_properties(ui_${panel} PROPERTIES TIMEOUT 15 ENVIRONMENT "QT_FORCE_STDERR_LOGGING=1")
        endforeach()
    endif()
endif()
