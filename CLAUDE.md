# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

OpenSpeak is a P2P video streaming app (screen/window/camera with audio) modeled on TeamSpeak 6's streaming engine and UI. Docs, comments, changelog and UI strings are in Portuguese (pt-BR); keep new ones in Portuguese. Analysis of the original TS client: `docs/ANALISE_TEAMSPEAK_P2P.md`.

## Two implementations, one protocol

1. **Web client + Node server** (repo root): `server/` (signaling, `virtualServer.js`), `public/js/` (browser WebRTC client; phones and tablets get the watch-only `ui/MobileApp.js`, `?mobile=1` forces it), `api/` + `vercel.json` (Vercel deployment: `/ws` → `api/ws.js`, with `server/cloudRoom.js` + `redisRoomStore.js` for room state).
2. **Native Windows app** (`native/`, C++ / Qt 6 QML / libdatachannel / FFmpeg+NVENC): client `OpenSpeak.exe` (`native/client/`) and server `openspeak-server.exe` (`native/server/`). Shared wire protocol in `native/common/Protocol.h`.

Native and browser clients speak the **same protocol** and can watch each other — a protocol change must be mirrored in `server/protocol.js`/`server/virtualServer.js` and `native/common/Protocol.h`/`native/server/VirtualServer.cpp`.

Command names deliberately match TeamSpeak 6 (`setupstream`, `joinstreamrequest`, `respondjoinstreamrequest`, `streamsignaling`). Flow: streamer `setupstream` → viewer `joinstreamrequest` (with decodable codecs) → privacy check (Public/Contacts/Private) → streamer creates a `SessionOutbound` and offers → SDP/ICE over `streamsignaling` → media peer-to-peer (DTLS-SRTP). Class names mirror TS too: `ScreenshareManager`, `StreamBase`, `SessionOutbound`/`SessionInbound`, `StatsCollector` (same thresholds as TS).

The native server additionally implements SFU mode (`STREAM_SFU`): `native/server/Sfu*.cpp` (ingest, forwarder, egress, relay, and a WebSocket viewer fallback `SfuWsViewer`). The web server only announces `STREAM_P2P`.

Profiles (capability `PROFILES`, not on the Vercel room): a nickname becomes a profile when it gets a password (`setprofilepassword`); `login` then requires `profilePassword`, and `updateprofile` edits display name, color, description and avatar, which go out in `publicClient`. Heavy media (capability `PROFILE_MEDIA`: banner and the GIF `avatarAnimated`, whose first frame is the static `avatar`) stays out of `publicClient`, which only carries `mediaTag`; clients fetch it with `profilemedia` when a card opens and cache by tag. Stored in a JSON file shared by `server/profileStore.js` and `native/server/ProfileStore.cpp` (`OPENSPEAK_PROFILES_FILE`).

## Commands

Web/Node:
```bash
npm install
npm start                               # http://localhost:9988 ; ?profile=a&debug for a 2nd profile + test-pattern source
npm test                                # node --test "test/*.test.js"
node --test test/server.test.js         # single test file
```
Env: `PORT`, `HOST`, `OPENSPEAK_NAME`, `OPENSPEAK_PROFILES_FILE`, `OPENSPEAK_ICE` (JSON iceServers), `OPENSPEAK_CERT`/`OPENSPEAK_KEY` (HTTPS, needed off-localhost for capture).

Native (Windows, PowerShell; toolchain paths are hardcoded defaults in the scripts: VS 2026, Qt `C:\Qt\6.11.3\msvc2022_64`, vcpkg `D:\Dev\vcpkg`, triplet `x64-windows-static-md`, deps in `native/vcpkg_installed`):
```bash
powershell -ExecutionPolicy Bypass -File native/build.ps1               # Release build (Ninja) + only the tests whose inputs changed
powershell -ExecutionPolicy Bypass -File native/build.ps1 -AllTests     # same, full suite
powershell -ExecutionPolicy Bypass -File native/build.ps1 -DryRun       # print the test selection, build nothing
powershell -ExecutionPolicy Bypass -File native/build.ps1 -ServerOnly   # server + tests only
powershell -ExecutionPolicy Bypass -File native/build.ps1 -Tests 'tst_engine|ui_'   # force tests by ctest -R regex
powershell -ExecutionPolicy Bypass -File native/package.ps1             # Lite installer only (default) into native/dist
powershell -ExecutionPolicy Bypass -File native/package.ps1 -Full -Portable   # also Full edition and portable ZIP/exe
```
**Packaging rule (user preference):** build/package **only the Lite installer** (plain `package.ps1`, no flags). Do **not** pass `-Full` or `-Portable` unless the user explicitly asks for the Full edition or the portable builds in that request. When publishing a Lite-only release, upload just `OpenSpeak-Setup-<versão>.exe`, `OpenSpeak-Setup.exe` and the `SHA256SUMS-<versão>.txt` covering them.
Test selection lives in `native/tests/TestSelection.ps1`: each test lists its input files, and `build.ps1` runs it only if their hash differs from its last pass (`build/test-cache-<Config>.json`; a failed test stays pending). Unmapped files and tests fall back to running everything, so add new ones to the map. `build.ps1` builds only the test executables it will run, plus `OpenSpeak` and `openspeak-server`; tests run with `ctest --parallel 8` (`RUN_SERIAL` for real-window tests, `RESOURCE_LOCK e2e` for e2e). `package.ps1` uses the same selection; pass `-AllTests` to force the full suite.
Single native test: `ctest --test-dir native/build -C Release -R tst_virtualserver --output-on-failure` (Qt `bin` must be on PATH). Tests: `tst_virtualserver`, `tst_windowthumbnail`, and `ui_<panel>` smoke tests that run `OpenSpeak --ui-smoke-test --open <panel>`.

## Releases / editions

- Version is set in **both** `native/build.ps1` and `native/package.ps1` (`-Version` default) and passed to CMake as `OPENSPEAK_RELEASE_VERSION`, which only feeds the generated `build/generated/Version.cpp` (`native/common/Version.cpp.in` → `openspeak::version()` in `common/Version.h`; never reintroduce a version compile definition, so a version bump only recompiles that file + relinks); add a `native/CHANGELOG.md` entry per release. Installer script: `native/installer/OpenSpeak.iss` (Inno Setup 6).
- Two editions share one `OpenSpeak.exe`; `edition.txt` selects it. **Lite** (default, `OpenSpeak-Setup.exe`): server client only (P2P or SFU). **Full** (`OpenSpeak-Full-Setup.exe`): adds Tailnet mode, web room and the dedicated server. Auto-update logic: `native/client/core/AutoUpdater.*`, `UpdatePolicy.*`; see `docs/ATUALIZACOES.md`.

## Production / monitoring

Default server `wss://openspeak.duckdns.org/ws` runs the native server on an Oracle VM behind Caddy. `monitor/` is a stdlib-only Python dashboard (`monitor.py`, tests in `monitor/test_monitor.py`) reading the snapshot the native server writes when `OPENSPEAK_METRICS_FILE` is set; it listens on `127.0.0.1:9990` only and must not be exposed. Snapshot fields (IPs, User-Agent, etc.) must never be added to the public room list.

`discord-bot/` is a standalone Node bot (own `package.json`, `npm test` there) that polls `GET /api/live` (both servers: `liveSnapshot()`) and announces live streams in a voice channel status, a text channel and its presence. Streams carry `announce` (default true, "Mostrar ao vivo no bot do Discord" in the advanced stream settings) and `app` (native client: window's program name); `/api/live` must only expose public fields. With `OPENSPEAK_LIVE_WEBHOOK` (+ `_SECRET`) the servers also POST that snapshot to the bot when it changes (VirtualServer live-changed callback, debounced 300 ms).

License: AGPL-3.0-or-later; update `THIRD_PARTY_LICENSES.md` when adding dependencies.
