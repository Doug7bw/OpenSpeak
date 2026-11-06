# Configura e compila o OpenSpeak nativo e roda os testes afetados.
#   .\build.ps1                 # Release: compila e roda só os testes cujas entradas mudaram
#   .\build.ps1 -AllTests       # idem, mas roda a suíte completa
#   .\build.ps1 -DryRun         # só mostra quais testes rodariam, sem compilar
#   .\build.ps1 -ServerOnly     # só servidor e testes (sem FFmpeg; relay SFU se houver libdatachannel)
#   .\build.ps1 -Config Debug
#   .\build.ps1 -Tests 'tst_engine|ui_'   # força os testes cujo nome casa com a regex (ctest -R)
# O mapa teste -> arquivos fica em tests/TestSelection.ps1; quem passou é lembrado em build/test-cache-<Config>.json.
param(
    [string]$Config = 'Release',
    [string]$Version = '1.0.35',
    [switch]$ServerOnly,
    [string]$Tests,
    [switch]$AllTests,
    [switch]$DryRun,
    [string]$QtDir = 'C:\Qt\6.11.3\msvc2022_64',
    [string]$Vcpkg = 'D:\Dev\vcpkg',
    [string]$VcpkgInstalled = "$PSScriptRoot\vcpkg_installed"
)
# Avisos do CMake vão para stderr; não trate como erro (PowerShell 5.1).
$ErrorActionPreference = 'Continue'
$here = $PSScriptRoot
$build = "$here\build"
. "$here\tests\TestSelection.ps1"

$vs = & "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe" -latest -property installationPath
$cmakeDir = Join-Path $vs 'Common7\IDE\CommonExtensions\Microsoft\CMake'
$cmake = Join-Path $cmakeDir 'CMake\bin\cmake.exe'
$ctest = Join-Path (Split-Path $cmake) 'ctest.exe'
$ninja = Join-Path $cmakeDir 'Ninja\ninja.exe'

# Build antigo do gerador Visual Studio não serve para o Ninja.
if ((Test-Path "$build\CMakeCache.txt") -and -not (Select-String -LiteralPath "$build\CMakeCache.txt" -Pattern 'CMAKE_GENERATOR:INTERNAL=Ninja Multi-Config' -Quiet)) {
    Write-Host 'Gerador mudou: limpando build/'
    Remove-Item -LiteralPath $build -Recurse -Force
}

# Ninja precisa do ambiente do compilador. O vcvars custa ~3 s, então o resultado fica
# guardado; uma atualização do Visual Studio remove a pasta das ferramentas e invalida.
if (-not (Get-Command cl.exe -ErrorAction SilentlyContinue)) {
    $vcvarsCache = "$build\vcvars-env.txt"
    $vcEnv = if (Test-Path $vcvarsCache) { Get-Content -LiteralPath $vcvarsCache }
    $tools = ($vcEnv | Where-Object { $_ -like 'VCToolsInstallDir=*' }) -replace '^[^=]+='
    if (-not $tools -or -not (Test-Path -LiteralPath $tools)) {
        $vcEnv = cmd /c "`"$(Join-Path $vs 'VC\Auxiliary\Build\vcvars64.bat')`" >nul 2>nul && set"
        New-Item -ItemType Directory -Force $build | Out-Null
        Set-Content -LiteralPath $vcvarsCache -Value $vcEnv -Encoding utf8
    }
    $vcEnv | ForEach-Object { if ($_ -match '^([^=]+)=(.*)$') { Set-Item -LiteralPath "env:$($Matches[1])" -Value $Matches[2] } }
}

# Com o build pronto o Ninja refaz o configure sozinho quando um CMakeLists muda;
# só chamamos o cmake quando alguma opção desta linha mudou.
$client = if ($ServerOnly) { 'OFF' } else { 'ON' }
$configureArgs = @("-DCMAKE_PREFIX_PATH=$QtDir",
    "-DCMAKE_MAKE_PROGRAM=$ninja",
    "-DCMAKE_TOOLCHAIN_FILE=$Vcpkg\scripts\buildsystems\vcpkg.cmake",
    '-DVCPKG_TARGET_TRIPLET=x64-windows-static-md',
    "-DVCPKG_INSTALLED_DIR=$VcpkgInstalled",
    '-DVCPKG_MANIFEST_INSTALL=OFF',
    "-DOPENSPEAK_BUILD_CLIENT=$client",
    "-DOPENSPEAK_RELEASE_VERSION=$Version")
$configureStamp = "$build\configure-args.txt"
if (-not (Test-Path "$build\build.ninja") -or -not (Test-Path $configureStamp) -or ((Get-Content $configureStamp -Raw).Trim() -ne ($configureArgs -join "`n"))) {
    & $cmake -S $here -B $build -G 'Ninja Multi-Config' @configureArgs
    if ($LASTEXITCODE) { exit $LASTEXITCODE }
    Set-Content -LiteralPath $configureStamp -Value ($configureArgs -join "`n") -Encoding utf8
} else {
    # CMakeLists alterado: atualiza já, para a lista de testes abaixo sair certa.
    & $ninja -C $build build.ninja | Out-Null
    if ($LASTEXITCODE) { exit $LASTEXITCODE }
}

function Get-RegisteredTests([string[]]$Filter = @()) {
    $listed = & $ctest --test-dir $build -C $Config -N @Filter
    return @($listed | ForEach-Object { if ($_ -match '^\s*Test\s+#\d+: (\S+)') { $Matches[1] } })
}

$registered = Get-RegisteredTests
$root = (& git -C $here rev-parse --show-toplevel 2>$null)
$cachePath = "$build\test-cache-$Config.json"
$cache = Read-TestCache $cachePath
$fingerprints = if ($root) { Get-TestFingerprints $registered $root "$Config|$QtDir" }

if ($Tests) { $selected = Get-RegisteredTests @('-R', $Tests) }
elseif ($AllTests) { $selected = $registered }
else { $selected = @(Select-StaleTests $registered $fingerprints $cache) }

Write-Host "Testes: $($selected.Count) de $($registered.Count) a rodar"
if ($selected) { Write-Host "  $($selected -join ' ')" }
if ($DryRun) { exit 0 }

# Só os executáveis que serão usados: mudar o motor não relinka os testes que não vão rodar.
$targets = [System.Collections.Generic.List[string]]::new()
$targets.Add('openspeak-server')
if (-not $ServerOnly) { $targets.Add('OpenSpeak') }
foreach ($test in $selected) {
    if ($test -notlike 'ui_*' -and -not $targets.Contains($test)) { $targets.Add($test) }
}
& $cmake --build $build --config $Config --target @targets
if ($LASTEXITCODE) { exit $LASTEXITCODE }

if (-not $selected) { exit 0 }
$env:PATH = "$QtDir\bin;$env:PATH"
$junit = "$build\ctest-junit.xml"
Remove-Item -LiteralPath $junit -ErrorAction SilentlyContinue
& $ctest --test-dir $build -C $Config --output-on-failure --parallel 8 --output-junit $junit -R "^($($selected -join '|'))$"
$testExit = $LASTEXITCODE
Update-TestCache $cachePath $cache $fingerprints $junit
exit $testExit
