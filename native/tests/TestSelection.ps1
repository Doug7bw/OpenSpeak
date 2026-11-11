# Seleção de testes do build.ps1: cada teste tem uma lista de entradas (arquivos de que
# depende) e só roda se elas mudaram desde a última vez que ele passou.
#   - Arquivo que nenhuma regra conhece (novo .cpp, CMakeLists, vcpkg.json...) entra em todos.
#   - Teste sem entrada aqui (recém-criado) roda sempre.
# Os dois casos erram para o lado de rodar mais; ajuste o mapa quando ficar amplo demais.

# Regex sobre o caminho relativo à raiz do repositório.
# Definição do build: afeta tudo de propósito, não merece aviso.
$script:BuildInputs = '(^|/)CMakeLists\.txt$|^native/vcpkg\.json$'
$script:IgnoredInputs = @(
    '^native/(installer|portable)/',
    '^native/(build|package)\.ps1$',
    '^native/tests/TestSelection\.ps1$',
    '^native/common/Version\.',           # versão: só muda o texto exibido
    '^native/\.gitignore$',
    '\.md$'                               # exceto os embutidos no app, mapeados abaixo
)

$protocol = '^native/common/Protocol\.h$'
$commonRtc = '^native/common/rtc/'
# A captura real de janela tem teste próprio e não participa dos e2e (usam o padrão de teste).
$engine = '^native/client/(core|media|mesh|rtc|video)/(?!WindowGrabber\.)'
$server = '^native/server/'
$qml = { param($names) '^native/client/qml/(' + ($names -join '|') + ')\.(qml|js)$' }

# Entradas de cada teste, além do próprio arquivo tst_<nome>.cpp.
$script:TestInputs = @{
    tst_virtualserver   = @($protocol, '^native/server/(VirtualServer|ProfileStore|StreamRelay)\.')
    tst_serverhost      = @($protocol, $commonRtc, $server)
    tst_rtprecovery     = @($commonRtc)
    tst_sfuforwarder    = @($commonRtc, '^native/server/Sfu')
    tst_updates         = @('^native/client/core/(AutoUpdater|UpdatePolicy|Settings)\.')
    tst_cloudconnection = @($protocol, '^native/client/core/ServerConnection\.')
    tst_windowgrabber   = @('^native/client/media/WindowGrabber\.')
    tst_windowthumbnail = @('^native/client/WindowThumbnail\.')
    tst_engine          = @($protocol, $commonRtc, $engine)
    tst_mesh_e2e        = @($protocol, $commonRtc, $engine)
    tst_p2p_e2e         = @($protocol, $commonRtc, $engine, $server)
    tst_sfu_e2e         = @($protocol, $commonRtc, $engine, $server)
}

# Painéis: arquivos que cada ui_<painel> realmente valida.
$script:PanelInputs = @{
    'setup'          = @((& $qml @('SetupStreamDialog', 'AppSlider')), '^native/client/WindowThumbnail\.', '^native/client/media/')
    'source'         = @((& $qml @('SetupStreamDialog', 'AppSlider')), '^native/client/WindowThumbnail\.', '^native/client/media/')
    'view-menu'      = @((& $qml @('StreamArea', 'StreamTile', 'VolumeSlider', 'ViewerCount', 'ViewersPanel', 'StatsPanel', 'StatGraph', 'ChannelTree')))
    'updates'        = @((& $qml @('SettingsDialog')), '^native/client/core/(AutoUpdater|UpdatePolicy)\.')
    'preferences'    = @((& $qml @('SettingsDialog', 'AppearanceSettings', 'AppSlider', 'PasswordField')))
    'profile'        = @((& $qml @('SettingsDialog', 'Avatar', 'ProfileBanner', 'PasswordField')))
    'avatar-crop'    = @((& $qml @('SettingsDialog', 'AvatarCropDialog', 'AppSlider', 'Avatar')))
    'profile-card'   = @((& $qml @('ProfileCard', 'ChannelTree', 'Avatar', 'ProfileBanner')))
    'changelog'      = @((& $qml @('SettingsDialog')), '^native/CHANGELOG\.md$')
    'licenses'       = @((& $qml @('SettingsDialog')), '^THIRD_PARTY_LICENSES\.md$')
    'startup'        = @()
    'login'          = @((& $qml @('LoginView', 'PasswordField')))
    'login-advanced' = @((& $qml @('LoginView', 'PasswordField')))
}
# A casca que todo painel carrega: mudou, todos validam.
$script:UiShell = @((& $qml @('Main', 'MainView')), '^native/client/main\.cpp$')
# Peças visuais usadas em toda parte: uma amostra dos painéis basta para ver que o app abre.
$script:UiSampled = @('startup', 'login', 'setup', 'preferences')
$script:UiSampledInputs = @((& $qml @('Theme', 'Icon', 'I18n', 'Toasts', 'ResizeHandles')),
    '^native/client/(AppIcon|TrayIcon|NativeWindow|NvidiaProfile|SoundEffects)\.', '^native/client/assets/', $engine)

foreach ($panel in @($script:PanelInputs.Keys)) {
    $inputs = @($script:PanelInputs[$panel]) + $script:UiShell
    if ($script:UiSampled -contains $panel) { $inputs += $script:UiSampledInputs }
    $script:TestInputs["ui_$panel"] = $inputs
}

function Get-InputHashes([string]$Root) {
    $hashes = @{}
    foreach ($f in @(& git -C $Root ls-files --cached --others --exclude-standard -- native THIRD_PARTY_LICENSES.md | Sort-Object -Unique)) {
        $path = Join-Path $Root $f
        # Arquivo apagado continua na lista: a remoção também muda a impressão digital.
        $hashes[$f] = if (Test-Path -LiteralPath $path) { (Get-FileHash -LiteralPath $path -Algorithm SHA1).Hash } else { 'apagado' }
    }
    return $hashes
}

# Impressão digital de cada teste. $null = sem git: o chamador roda todos.
function Get-TestFingerprints([string[]]$Tests, [string]$Root, [string]$Salt) {
    $hashes = Get-InputHashes $Root
    if (-not $hashes.Count) { return $null }
    $known = @($script:TestInputs.Values | ForEach-Object { $_ }) + '^native/tests/(client/)?tst_[^/]+\.cpp$' + $script:IgnoredInputs
    $knownRegex = ($known | Sort-Object -Unique) -join '|'
    $unknown = @($hashes.Keys | Where-Object { $_ -notmatch $knownRegex } | Sort-Object)
    foreach ($f in $unknown) { if ($f -notmatch $script:BuildInputs) { Write-Host "testes: $f fora do mapa; entra em todos" } }

    $fingerprints = @{}
    $sha = [System.Security.Cryptography.SHA1]::Create()
    foreach ($test in $Tests) {
        $regex = (@($script:TestInputs[$test]) + "/$test\.cpp$") -join '|'
        $inputs = $unknown + @($hashes.Keys | Where-Object { $_ -match $regex })
        $lines = @($Salt) + @($inputs | Sort-Object -Unique | ForEach-Object { "$_=$($hashes[$_])" })
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($lines -join "`n")
        $fingerprints[$test] = [System.BitConverter]::ToString($sha.ComputeHash($bytes))
    }
    return $fingerprints
}

function Read-TestCache([string]$Path) {
    $cache = @{}
    if (Test-Path -LiteralPath $Path) {
        $json = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
        foreach ($p in $json.PSObject.Properties) { $cache[$p.Name] = $p.Value }
    }
    return $cache
}

# Testes cuja última passagem não foi com exatamente estas entradas.
function Select-StaleTests([string[]]$Tests, $Fingerprints, $Cache) {
    if (-not $Fingerprints) { return $Tests }
    # Teste sem mapa não tem como ser dado por validado.
    return @($Tests | Where-Object { -not $script:TestInputs.ContainsKey($_) -or $Cache[$_] -ne $Fingerprints[$_] })
}

# Grava quem passou, a partir do relatório JUnit do ctest; quem falhou sai do cache.
function Update-TestCache([string]$Path, $Cache, $Fingerprints, [string]$Junit) {
    if (-not $Fingerprints -or -not (Test-Path -LiteralPath $Junit)) { return }
    foreach ($case in ([xml](Get-Content -LiteralPath $Junit -Raw)).testsuite.testcase) {
        if ($case.status -eq 'run') { $Cache[$case.name] = $Fingerprints[$case.name] }
        else { $Cache.Remove($case.name) }
    }
    $Cache | ConvertTo-Json | Set-Content -LiteralPath $Path -Encoding utf8
}
