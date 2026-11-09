#include "AudioCapture.h"

#include <QMediaDevices>

#include <windows.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <mmdeviceapi.h>
#include <wrl/client.h>
#include <wrl/implements.h>
#include <tlhelp32.h>

#include <algorithm>
#include <iterator>

#pragma comment(lib, "mmdevapi.lib")

using Microsoft::WRL::ComPtr;

namespace openspeak {

namespace {

class ActivationHandler
    : public Microsoft::WRL::RuntimeClass<Microsoft::WRL::RuntimeClassFlags<Microsoft::WRL::ClassicCom>,
                                          Microsoft::WRL::FtmBase, IActivateAudioInterfaceCompletionHandler> {
public:
    ActivationHandler() { done = CreateEventW(nullptr, TRUE, FALSE, nullptr); }
    ~ActivationHandler() override { CloseHandle(done); }

    STDMETHOD(ActivateCompleted)(IActivateAudioInterfaceAsyncOperation *op) override
    {
        ComPtr<IUnknown> unk;
        HRESULT activateResult = E_FAIL;
        hr = op->GetActivateResult(&activateResult, &unk);
        if (SUCCEEDED(hr))
            hr = activateResult;
        if (SUCCEEDED(hr))
            hr = unk.As(&client);
        SetEvent(done);
        return S_OK;
    }

    HANDLE done = nullptr;
    HRESULT hr = E_FAIL;
    ComPtr<IAudioClient> client;
};

struct WindowSearch {
    std::wstring title;
    DWORD pid = 0;
};

BOOL CALLBACK findWindow(HWND hwnd, LPARAM param)
{
    auto *search = reinterpret_cast<WindowSearch *>(param);
    wchar_t buffer[512];
    const int len = GetWindowTextW(hwnd, buffer, 512);
    if (len > 0 && IsWindowVisible(hwnd) && search->title == std::wstring(buffer, len)) {
        GetWindowThreadProcessId(hwnd, &search->pid);
        return FALSE;
    }
    return TRUE;
}

BOOL CALLBACK findOtherProcessChild(HWND hwnd, LPARAM param)
{
    auto *pid = reinterpret_cast<DWORD *>(param);
    DWORD childPid = 0;
    GetWindowThreadProcessId(hwnd, &childPid);
    if (childPid && childPid != *pid) {
        *pid = childPid;
        return FALSE;
    }
    return TRUE;
}

QList<AudioCapture::ProcessEntry> processSnapshot()
{
    QList<AudioCapture::ProcessEntry> out;
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snap == INVALID_HANDLE_VALUE)
        return out;
    PROCESSENTRY32W pe{sizeof(pe)};
    for (BOOL ok = Process32FirstW(snap, &pe); ok; ok = Process32NextW(snap, &pe))
        out.append({pe.th32ProcessID, pe.th32ParentProcessID, QString::fromWCharArray(pe.szExeFile)});
    CloseHandle(snap);
    return out;
}

} // namespace

AudioCapture::AudioCapture(QObject *parent) : QObject(parent) {}

AudioCapture::~AudioCapture() { stop(); }

quint32 AudioCapture::pidForWindowTitle(const QString &title)
{
    WindowSearch search{title.toStdWString()};
    EnumWindows(findWindow, reinterpret_cast<LPARAM>(&search));
    return search.pid;
}

quint32 AudioCapture::familyRoot(quint32 pid, const QList<ProcessEntry> &processes)
{
    auto find = [&](quint32 p) -> const ProcessEntry * {
        for (const ProcessEntry &e : processes)
            if (e.pid == p)
                return &e;
        return nullptr;
    };
    const ProcessEntry *current = find(pid);
    for (int guard = 0; current && guard < 64; ++guard) { // PIDs reciclados podem formar ciclo
        const ProcessEntry *parent = current->parent != current->pid ? find(current->parent) : nullptr;
        if (!parent || parent->exe.compare(current->exe, Qt::CaseInsensitive) != 0)
            break;
        current = parent;
    }
    return current ? current->pid : pid;
}

quint32 AudioCapture::pidForWindow(quintptr id)
{
    const HWND hwnd = reinterpret_cast<HWND>(id);
    DWORD pid = 0;
    if (!hwnd || !GetWindowThreadProcessId(hwnd, &pid) || !pid)
        return 0;
    const QList<ProcessEntry> processes = processSnapshot();
    // App UWP: a moldura é do ApplicationFrameHost; o som sai do processo da CoreWindow filha.
    for (const ProcessEntry &e : processes)
        if (e.pid == pid && e.exe.compare(QLatin1String("ApplicationFrameHost.exe"), Qt::CaseInsensitive) == 0) {
            EnumChildWindows(hwnd, findOtherProcessChild, reinterpret_cast<LPARAM>(&pid));
            break;
        }
    return familyRoot(pid, processes);
}

bool AudioCapture::start(Mode mode, quint32 pid)
{
    stop();
    m_running = true;
    if (mode == Mode::Microphone) {
        const QAudioDevice device = QMediaDevices::defaultAudioInput();
        if (device.isNull()) {
            m_running = false;
            emit errorOccurred(QStringLiteral("nenhum microfone"));
            return false;
        }
        QAudioFormat fmt;
        fmt.setSampleRate(SampleRate);
        fmt.setChannelCount(Channels);
        fmt.setSampleFormat(QAudioFormat::Float);
        if (!device.isFormatSupported(fmt)) {
            fmt = device.preferredFormat();
            fmt.setSampleFormat(QAudioFormat::Float);
        }
        m_mic = std::make_unique<QAudioSource>(device, fmt);
        m_micDevice = m_mic->start();
        const int rate = fmt.sampleRate(), channels = fmt.channelCount();
        connect(m_micDevice, &QIODevice::readyRead, this, [this, rate, channels] {
            const QByteArray data = m_micDevice->readAll();
            if (!data.isEmpty())
                emit samplesAvailable(data, rate, channels);
        });
        return true;
    }
    m_thread = std::thread(&AudioCapture::loopbackThread, this, mode, pid);
    return true;
}

void AudioCapture::stop()
{
    m_running = false;
    if (m_thread.joinable())
        m_thread.join();
    if (m_mic) {
        m_mic->stop();
        m_mic.reset();
        m_micDevice = nullptr;
    }
}

quint32 AudioCapture::discordRootPid()
{
    static const wchar_t *const names[] = {L"Discord.exe", L"DiscordPTB.exe", L"DiscordCanary.exe", L"DiscordDevelopment.exe"};
    auto isDiscord = [](const wchar_t *exe) {
        return std::any_of(std::begin(names), std::end(names), [exe](const wchar_t *n) { return _wcsicmp(exe, n) == 0; });
    };
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snap == INVALID_HANDLE_VALUE)
        return 0;
    QList<QPair<quint32, quint32>> discord; // (pid, pai)
    PROCESSENTRY32W pe{sizeof(pe)};
    for (BOOL ok = Process32FirstW(snap, &pe); ok; ok = Process32NextW(snap, &pe))
        if (isDiscord(pe.szExeFile))
            discord.append({pe.th32ProcessID, pe.th32ParentProcessID});
    CloseHandle(snap);
    // Excluir a árvore da raiz tira também o processo filho que toca as vozes.
    return rootProcess(discord);
}

quint32 AudioCapture::rootProcess(const QList<QPair<quint32, quint32>> &processes)
{
    quint32 root = 0;
    for (const auto &[pid, parent] : processes) {
        const bool hasParentInList = std::any_of(processes.begin(), processes.end(),
                                                 [parent](const auto &p) { return p.first == parent; });
        if (!hasParentInList && (!root || pid < root))
            root = pid;
    }
    return root;
}

void AudioCapture::loopbackThread(Mode mode, quint32 pid)
{
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    auto fail = [this](const QString &what, HRESULT hr) {
        emit errorOccurred(QStringLiteral("%1 (0x%2)").arg(what).arg(quint32(hr), 8, 16, QLatin1Char('0')));
    };

    WAVEFORMATEX fmt{};
    fmt.wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
    fmt.nChannels = Channels;
    fmt.nSamplesPerSec = SampleRate;
    fmt.wBitsPerSample = 32;
    fmt.nBlockAlign = fmt.nChannels * fmt.wBitsPerSample / 8;
    fmt.nAvgBytesPerSec = fmt.nSamplesPerSec * fmt.nBlockAlign;
    HANDLE event = CreateEventW(nullptr, FALSE, FALSE, nullptr);

    // Quem sai da captura. No modo "sem Discord", reavaliado a cada segundo: se o
    // Discord abrir, fechar ou reiniciar (novo PID), a captura é recriada (~100 ms de corte).
    auto excludedTarget = [&]() -> DWORD {
        if (mode == Mode::SystemExcludingDiscord)
            if (const quint32 discord = discordRootPid())
                return discord;
        return mode == Mode::Process ? pid : GetCurrentProcessId();
    };
    QString lastExcluded;
    bool reported = false; // avisa a falha uma vez; segue tentando a cada segundo
    auto retryLater = [&](const QString &what, HRESULT hr) {
        if (!reported)
            fail(what, hr);
        reported = true;
        for (int i = 0; i < 10 && m_running; ++i)
            Sleep(100);
    };

    while (m_running) {
        const DWORD target = excludedTarget();
        if (mode == Mode::SystemExcludingDiscord) {
            const QString excluded = target == GetCurrentProcessId() ? QStringLiteral("self") : QStringLiteral("discord");
            if (excluded != lastExcluded) {
                lastExcluded = excluded;
                emit excludedChanged(excluded);
            }
        }

        AUDIOCLIENT_ACTIVATION_PARAMS params{};
        params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
        params.ProcessLoopbackParams.TargetProcessId = target;
        params.ProcessLoopbackParams.ProcessLoopbackMode = mode == Mode::Process
            ? PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE
            : PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE;
        PROPVARIANT pv{};
        pv.vt = VT_BLOB;
        pv.blob.cbSize = sizeof(params);
        pv.blob.pBlobData = reinterpret_cast<BYTE *>(&params);

        auto handler = Microsoft::WRL::Make<ActivationHandler>();
        ComPtr<IActivateAudioInterfaceAsyncOperation> op;
        HRESULT hr = ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, __uuidof(IAudioClient), &pv,
                                                 handler.Get(), &op);
        if (FAILED(hr) || WaitForSingleObject(handler->done, 5000) != WAIT_OBJECT_0 || FAILED(handler->hr)) {
            retryLater(QStringLiteral("falha ao ativar captura de áudio"), FAILED(hr) ? hr : handler->hr);
            continue;
        }
        ComPtr<IAudioClient> client = handler->client;
        hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                                200'000 /* 20 ms */, 0, &fmt, nullptr);
        ComPtr<IAudioCaptureClient> capture;
        if (SUCCEEDED(hr))
            hr = client->SetEventHandle(event);
        if (SUCCEEDED(hr))
            hr = client->GetService(IID_PPV_ARGS(&capture));
        if (SUCCEEDED(hr))
            hr = client->Start();
        if (FAILED(hr)) {
            retryLater(QStringLiteral("falha ao iniciar captura de áudio"), hr);
            continue;
        }
        reported = false;

        ULONGLONG nextCheck = GetTickCount64() + 1000;
        while (m_running) {
            if (mode == Mode::SystemExcludingDiscord && GetTickCount64() >= nextCheck) {
                nextCheck = GetTickCount64() + 1000;
                if (excludedTarget() != target)
                    break; // recria a captura com o novo alvo
            }
            if (WaitForSingleObject(event, 100) != WAIT_OBJECT_0)
                continue;
            UINT32 frames = 0;
            while (SUCCEEDED(capture->GetNextPacketSize(&frames)) && frames > 0) {
                BYTE *data = nullptr;
                DWORD flags = 0;
                if (FAILED(capture->GetBuffer(&data, &frames, &flags, nullptr, nullptr)))
                    break;
                QByteArray pcm(int(frames * fmt.nBlockAlign), Qt::Uninitialized);
                if (flags & AUDCLNT_BUFFERFLAGS_SILENT)
                    pcm.fill(0);
                else
                    memcpy(pcm.data(), data, pcm.size());
                capture->ReleaseBuffer(frames);
                emit samplesAvailable(pcm, SampleRate, Channels);
            }
        }
        client->Stop();
    }
    CloseHandle(event);
    CoUninitialize();
}

} // namespace openspeak
