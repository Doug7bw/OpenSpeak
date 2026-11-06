# Monta as edições lite (OpenSpeak-Setup-<versão>.exe, padrão) e completa
# (OpenSpeak-Full-Setup-<versão>.exe), com instalador, ZIP e exe portáteis.
#   .\package.ps1                # só a edição lite (instalador), compila Release antes
#   .\package.ps1 -Full          # também a edição completa
#   .\package.ps1 -Portable      # também ZIP e exe portáteis das edições geradas
#   .\package.ps1 -AllTests      # roda a suíte completa em vez de só os testes afetados
#   .\package.ps1 -SkipBuild
param(
    [string]$Version = '1.0.37',
    [switch]$SkipBuild,
    [switch]$AllTests,
    [switch]$Full,
    [switch]$Portable,
    [string]$QtDir = 'C:\Qt\6.11.3\msvc2022_64'
)
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$release = Join-Path $here 'build\Release'

if (-not $SkipBuild) {
    & (Join-Path $here 'build.ps1') -Version $Version -AllTests:$AllTests
    if ($LASTEXITCODE) { Write-Error 'build/testes falharam'; exit 1 }
}

# Edições: lite (padrão; só o cliente do servidor, P2P ou SFU) e completa (com Tailscale,
# sala web e servidor dedicado). As duas usam o mesmo OpenSpeak.exe; edition.txt define a edição.
$vs = & "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe" -latest -property installationPath
$crt = Get-ChildItem (Join-Path $vs 'VC\Redist\MSVC') -Directory | Sort-Object Name -Descending |
    ForEach-Object { Get-ChildItem (Join-Path $_.FullName 'x64') -Directory -Filter 'Microsoft.VC*.CRT' -ErrorAction SilentlyContinue } | Select-Object -First 1
$iscc = @("$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe", "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe") |
    Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $iscc) { Write-Error 'Inno Setup 6 não encontrado (winget install JRSoftware.InnoSetup)'; exit 1 }
$deploy = Join-Path $QtDir 'bin\windeployqt.exe'
$cmake = Join-Path $vs 'Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe'

function Build-Edition([string]$Edition) {
    $full = $Edition -eq 'full'
    # O ZIP portátil exige a pasta raiz "OpenSpeak".
    $staging = if ($full) { Join-Path $here 'dist\OpenSpeak' } else { Join-Path $here 'dist\lite\OpenSpeak' }
    $prefix = if ($full) { 'OpenSpeak-Full' } else { 'OpenSpeak' }

    # 1) Executáveis + dependências do Qt (windeployqt)
    if (Test-Path $staging) {
        $resolvedStaging = (Resolve-Path -LiteralPath $staging).Path
        if (-not $resolvedStaging.StartsWith([System.IO.Path]::GetFullPath((Join-Path $here 'dist')))) { throw 'Diretório de staging inesperado' }
        Remove-Item -LiteralPath $resolvedStaging -Recurse -Force
    }
    New-Item -ItemType Directory -Force $staging | Out-Null
    Copy-Item (Join-Path $release 'OpenSpeak.exe') $staging
    & $deploy --release --no-translations --no-compiler-runtime --no-system-d3d-compiler --no-system-dxc-compiler --qmldir (Join-Path $here 'client\qml') (Join-Path $staging 'OpenSpeak.exe') | Out-Null
    if ($LASTEXITCODE) { throw 'windeployqt do cliente falhou' }
    if ($full) {
        Copy-Item (Join-Path $release 'openspeak-server.exe') $staging
        & $deploy --release --no-translations --no-compiler-runtime (Join-Path $staging 'openspeak-server.exe') | Out-Null
        if ($LASTEXITCODE) { throw 'windeployqt do servidor falhou' }
        # Cliente web (servido pelo servidor dedicado)
        Copy-Item -Recurse (Join-Path $here '..\public') (Join-Path $staging 'public')
    }
    Set-Content -LiteralPath (Join-Path $staging 'edition.txt') -Value $Edition -NoNewline -Encoding ascii

    # 2) Runtime do Visual C++ ao lado do .exe (dispensa o vc_redist)
    Copy-Item (Join-Path $crt.FullName '*.dll') $staging

    # 3) Licenças: AGPL do OpenSpeak + textos das dependências do vcpkg
    Copy-Item (Join-Path $here '..\LICENSE'), (Join-Path $here '..\THIRD_PARTY_LICENSES.md') $staging
    $licenses = Join-Path $staging 'licenses'
    New-Item -ItemType Directory -Force $licenses | Out-Null
    Get-ChildItem (Join-Path $here 'vcpkg_installed\x64-windows-static-md\share') -Directory |
        Where-Object { Test-Path (Join-Path $_.FullName 'copyright') } |
        ForEach-Object { Copy-Item (Join-Path $_.FullName 'copyright') (Join-Path $licenses "$($_.Name).txt") }

    # 4) Instalador
    & $iscc "/DAppVersion=$Version" "/DEdition=$Edition" "/DStaging=$staging" (Join-Path $here 'installer\OpenSpeak.iss') | Out-Null
    if ($LASTEXITCODE) { throw "Inno Setup falhou ($Edition)" }
    # Nome fixo para /releases/latest/download/<prefixo>-Setup.exe; publique em cada release.
    Copy-Item (Join-Path $here "dist\$prefix-Setup-$Version.exe") (Join-Path $here "dist\$prefix-Setup.exe") -Force

    if (-not $Portable) { return }
    # 5) Distribuição portátil com as mesmas dependências do instalador.
    $zip = Join-Path $here "dist\$prefix-$Version-portable.zip"
    Compress-Archive -Path $staging -DestinationPath $zip -Force

    # 6) Um único exe: launcher nativo com o ZIP embutido e runtime estático.
    $portableBuild = Join-Path $here "build\portable-$Edition"
    & $cmake -S (Join-Path $here 'portable') -B $portableBuild -G 'Visual Studio 18 2026' -A x64 "-DPAYLOAD_ZIP=$zip" | Out-Null
    if ($LASTEXITCODE) { throw 'Configuração do launcher portátil falhou' }
    & $cmake --build $portableBuild --config Release --parallel | Out-Null
    if ($LASTEXITCODE) { throw 'Build do launcher portátil falhou' }
    Copy-Item (Join-Path $portableBuild 'Release\OpenSpeakPortable.exe') (Join-Path $here "dist\$prefix-Portable-$Version.exe") -Force
}

Build-Edition 'lite'
if ($Full) { Build-Edition 'full' }
exit 0
