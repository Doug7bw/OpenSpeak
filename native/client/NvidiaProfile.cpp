#include "NvidiaProfile.h"

#include <QDebug>
#include <memory>
#include <thread>

#ifdef Q_OS_WIN
#include <windows.h>
#include <cstdint>
#include <cstring>
#include <cwchar>
#endif

namespace openspeak {

#ifdef Q_OS_WIN
namespace {

// Pedaços do NVAPI SDK (NVIDIA/nvapi, MIT): nvapi.h, nvapi_interface.h e NvApiDriverSettings.h.
using NvStatus = int32_t;
using NvSession = void *;
using NvProfile = void *;
using NvUnicode = wchar_t[2048]; // NvAPI_UnicodeString (NvU16; wchar_t tem 2 bytes no Windows)

constexpr NvStatus NVAPI_OK = 0;
constexpr NvStatus NVAPI_SETTING_NOT_FOUND = -160;
constexpr NvStatus NVAPI_PROFILE_NOT_FOUND = -163;
constexpr NvStatus NVAPI_EXECUTABLE_NOT_FOUND = -166;
constexpr NvStatus NVAPI_INVALID_USER_PRIVILEGE = -137;

constexpr uint32_t VRR_APP_OVERRIDE_ID = 0x10A879CF;               // "G-SYNC - Application State"
constexpr uint32_t VRR_APP_OVERRIDE_REQUEST_STATE_ID = 0x10A879AC; // "G-SYNC - Application Requested State"
constexpr uint32_t VRR_APP_OVERRIDE_FORCE_OFF = 1;

constexpr uint32_t NVDRS_DWORD_TYPE = 0;
constexpr uint32_t NVDRS_CURRENT_PROFILE_LOCATION = 0;

#pragma pack(push, 4)
struct NvdrsBinary { uint32_t length; uint8_t data[4096]; };
struct NvdrsSetting { // NVDRS_SETTING_V1
    uint32_t version;
    NvUnicode settingName;
    uint32_t settingId;
    uint32_t settingType;
    uint32_t settingLocation;
    uint32_t isCurrentPredefined;
    uint32_t isPredefinedValid;
    union { uint32_t u32; NvdrsBinary bin; NvUnicode wsz; uint64_t u64; float f32; } predefined;
    union { uint32_t u32; NvdrsBinary bin; NvUnicode wsz; uint64_t u64; float f32; } current;
};
#pragma pack(pop)
struct NvdrsApplication { // NVDRS_APPLICATION_V4
    uint32_t version;
    uint32_t isPredefined;
    NvUnicode appName, userFriendlyName, launcher, fileInFolder;
    uint32_t flags; // isMetro:1, isCommandLine:1
    NvUnicode commandLine;
};
struct NvdrsProfile { // NVDRS_PROFILE_V1
    uint32_t version;
    NvUnicode profileName;
    uint32_t gpuSupport;
    uint32_t isPredefined, numOfApps, numOfSettings;
};

template <typename T> constexpr uint32_t nvVersion(uint32_t v) { return uint32_t(sizeof(T)) | (v << 16); }
static_assert(sizeof(NvdrsSetting) == 12320, "NVDRS_SETTING_V1 com o tamanho do SDK");

struct Nvapi {
    HMODULE dll = nullptr;
    void *(*query)(uint32_t) = nullptr;
    template <typename F> F fn(uint32_t id) const { return reinterpret_cast<F>(query(id)); }
    ~Nvapi() { if (dll) FreeLibrary(dll); }
};

void copyName(NvUnicode &dst, const wchar_t *src) { wcsncpy_s(dst, 2048, src, _TRUNCATE); }

} // namespace

GsyncResult disableGsyncForThisApp()
{
    GsyncResult r;
    Nvapi api;
    // Só o do sistema (o driver instala em System32); nunca um nvapi64.dll ao lado do .exe.
    api.dll = LoadLibraryExW(L"nvapi64.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
    if (!api.dll) return r; // sem driver NVIDIA
    api.query = reinterpret_cast<void *(*)(uint32_t)>(GetProcAddress(api.dll, "nvapi_QueryInterface"));
    if (!api.query) return r;

    using FInit = NvStatus (*)();
    using FCreateSession = NvStatus (*)(NvSession *);
    using FSession = NvStatus (*)(NvSession);
    using FFindApp = NvStatus (*)(NvSession, const wchar_t *, NvProfile *, NvdrsApplication *);
    using FFindProfile = NvStatus (*)(NvSession, const wchar_t *, NvProfile *);
    using FCreateProfile = NvStatus (*)(NvSession, NvdrsProfile *, NvProfile *);
    using FCreateApp = NvStatus (*)(NvSession, NvProfile, NvdrsApplication *);
    using FGetSetting = NvStatus (*)(NvSession, NvProfile, uint32_t, NvdrsSetting *);
    using FSetSetting = NvStatus (*)(NvSession, NvProfile, NvdrsSetting *);

    const auto init = api.fn<FInit>(0x0150E828);
    const auto unload = api.fn<FInit>(0xD22BDD7E);
    const auto createSession = api.fn<FCreateSession>(0x0694D52E);
    const auto destroySession = api.fn<FSession>(0xDAD9CFF8);
    const auto loadSettings = api.fn<FSession>(0x375DBD6B);
    const auto saveSettings = api.fn<FSession>(0xFCBC7E14);
    const auto findApp = api.fn<FFindApp>(0xEEE566B2);
    const auto findProfile = api.fn<FFindProfile>(0x7E4A9A0B);
    const auto createProfile = api.fn<FCreateProfile>(0xCC176068);
    const auto createApp = api.fn<FCreateApp>(0x4347A9DE);
    const auto getSetting = api.fn<FGetSetting>(0x73BF8338);
    const auto setSetting = api.fn<FSetSetting>(0x577DD202);
    if (!init || !createSession || !destroySession || !loadSettings || !saveSettings || !findApp || !findProfile
        || !createProfile || !createApp || !getSetting || !setSetting) {
        r.status = GsyncResult::Failed;
        r.detail = QStringLiteral("nvapi sem as funções de perfil");
        return r;
    }
    if (init() != NVAPI_OK) return r; // DLL presente, mas sem GPU NVIDIA ativa

    r.status = GsyncResult::Failed;
    auto fail = [&r](const char *step, NvStatus s) {
        r.detail = QStringLiteral("%1: erro %2%3").arg(QLatin1String(step)).arg(s)
                       .arg(s == NVAPI_INVALID_USER_PRIVILEGE ? QStringLiteral(" (precisa de administrador)") : QString());
    };

    NvSession session = nullptr;
    if (NvStatus s = createSession(&session); s != NVAPI_OK) {
        fail("CreateSession", s);
        if (unload) unload();
        return r;
    }
    [&] {
        if (NvStatus s = loadSettings(session); s != NVAPI_OK) return fail("LoadSettings", s);

        // Nome do executável (o driver casa o perfil pelo nome, sem diferenciar maiúsculas).
        wchar_t path[MAX_PATH]{};
        GetModuleFileNameW(nullptr, path, MAX_PATH);
        const wchar_t *exe = wcsrchr(path, L'\\');
        exe = exe ? exe + 1 : path;
        NvUnicode exeName{};
        copyName(exeName, exe);
        _wcslwr_s(exeName, 2048);

        NvProfile profile = nullptr;
        auto app = std::make_unique<NvdrsApplication>();
        std::memset(app.get(), 0, sizeof(NvdrsApplication));
        app->version = nvVersion<NvdrsApplication>(4);
        NvStatus s = findApp(session, exeName, &profile, app.get());
        bool created = false;
        if (s == NVAPI_EXECUTABLE_NOT_FOUND) {
            NvUnicode profileName{};
            copyName(profileName, L"OpenSpeak");
            s = findProfile(session, profileName, &profile);
            if (s == NVAPI_PROFILE_NOT_FOUND) {
                auto info = std::make_unique<NvdrsProfile>();
                std::memset(info.get(), 0, sizeof(NvdrsProfile));
                info->version = nvVersion<NvdrsProfile>(1);
                copyName(info->profileName, L"OpenSpeak");
                s = createProfile(session, info.get(), &profile);
                if (s != NVAPI_OK) return fail("CreateProfile", s);
            } else if (s != NVAPI_OK) {
                return fail("FindProfileByName", s);
            }
            std::memset(app.get(), 0, sizeof(NvdrsApplication));
            app->version = nvVersion<NvdrsApplication>(4);
            copyName(app->appName, exeName);
            copyName(app->userFriendlyName, L"OpenSpeak");
            s = createApp(session, profile, app.get());
            if (s != NVAPI_OK) return fail("CreateApplication", s);
            created = true;
        } else if (s != NVAPI_OK) {
            return fail("FindApplicationByName", s);
        }

        // Já desligado no próprio perfil (desta ou de uma abertura anterior): nada a gravar.
        auto setting = std::make_unique<NvdrsSetting>();
        bool changed = created;
        for (uint32_t id : {VRR_APP_OVERRIDE_ID, VRR_APP_OVERRIDE_REQUEST_STATE_ID}) {
            std::memset(setting.get(), 0, sizeof(NvdrsSetting));
            setting->version = nvVersion<NvdrsSetting>(1);
            s = getSetting(session, profile, id, setting.get());
            if (s == NVAPI_OK && setting->settingLocation == NVDRS_CURRENT_PROFILE_LOCATION
                && setting->current.u32 == VRR_APP_OVERRIDE_FORCE_OFF)
                continue;
            if (s != NVAPI_OK && s != NVAPI_SETTING_NOT_FOUND) return fail("GetSetting", s);
            std::memset(setting.get(), 0, sizeof(NvdrsSetting));
            setting->version = nvVersion<NvdrsSetting>(1);
            setting->settingId = id;
            setting->settingType = NVDRS_DWORD_TYPE;
            setting->current.u32 = VRR_APP_OVERRIDE_FORCE_OFF;
            s = setSetting(session, profile, setting.get());
            if (s != NVAPI_OK) return fail("SetSetting", s);
            changed = true;
        }
        if (!changed) {
            r.status = GsyncResult::AlreadyOff;
            r.detail = QString::fromWCharArray(exeName);
            return;
        }
        if (s = saveSettings(session); s != NVAPI_OK) return fail("SaveSettings", s);
        r.status = GsyncResult::TurnedOff;
        r.detail = QString::fromWCharArray(exeName);
    }();
    destroySession(session);
    if (unload) unload();
    return r;
}

#else
GsyncResult disableGsyncForThisApp() { return {}; }
#endif

void disableGsyncInBackground()
{
    std::thread([] {
        const GsyncResult r = disableGsyncForThisApp();
        switch (r.status) {
        case GsyncResult::NoNvidia: break;
        case GsyncResult::AlreadyOff: qInfo().noquote() << "G-Sync: já desligado no perfil NVIDIA de" << r.detail; break;
        case GsyncResult::TurnedOff: qInfo().noquote() << "G-Sync: desligado no perfil NVIDIA de" << r.detail; break;
        case GsyncResult::Failed: qWarning().noquote() << "G-Sync: não deu para ajustar o perfil NVIDIA:" << r.detail; break;
        }
    }).detach();
}

} // namespace openspeak
