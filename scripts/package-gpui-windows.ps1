[CmdletBinding()]
param(
    [string]$Version,
    [string]$BuildDirectory = "target/release",
    [string]$OutputDirectory = "release-artifacts/windows",
    [string]$OutputName,
    [string]$IsccPath
)

$ErrorActionPreference = "Stop"
$repository = Split-Path -Parent $PSScriptRoot

if (-not $Version) {
    $Version = (Get-Content -LiteralPath (Join-Path $repository "package.json") -Raw | ConvertFrom-Json).version
}
if (-not $OutputName) {
    $OutputName = "explorie-$Version-windows-x64-setup"
}

$build = [IO.Path]::GetFullPath((Join-Path $repository $BuildDirectory))
$output = [IO.Path]::GetFullPath((Join-Path $repository $OutputDirectory))
$resources = [IO.Path]::GetFullPath((Join-Path $repository "apps/desktop/native-assets/resources"))
$definition = [IO.Path]::GetFullPath((Join-Path $repository "apps/desktop/gpui/installer/windows/explorie.iss"))

foreach ($required in @(
    (Join-Path $build "explorie-gpui.exe"),
    (Join-Path $build "rclone.exe"),
    (Join-Path $resources "winfsp-2.1.25156.msi"),
    $definition
)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "Required installer input was not found: $required"
    }
}

$icon = Get-ChildItem -LiteralPath (Join-Path $build "build") -Filter "explorie.ico" -File -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match "explorie-gpui-[^\\]+\\out\\explorie\.ico$" } |
    Sort-Object LastWriteTimeUtc -Descending |
    Select-Object -First 1
if (-not $icon) {
    throw "The generated Explorie ICO was not found below $build/build. Build explorie-gpui first."
}

if (-not $IsccPath) {
    $candidates = @(
        (Get-Command iscc.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -First 1),
        "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe",
        "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
        "$env:ProgramFiles\Inno Setup 6\ISCC.exe"
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) }
    $IsccPath = $candidates | Select-Object -First 1
}
if (-not $IsccPath -or -not (Test-Path -LiteralPath $IsccPath -PathType Leaf)) {
    throw "Inno Setup 6 compiler (ISCC.exe) was not found."
}

New-Item -ItemType Directory -Path $output -Force | Out-Null
& $IsccPath "/DAppVersion=$Version" "/DBuildDir=$build" "/DResourceDir=$resources" "/DAppIcon=$($icon.FullName)" "/DOutputDir=$output" "/DOutputName=$OutputName" $definition
if ($LASTEXITCODE -ne 0) {
    throw "Inno Setup failed with exit code $LASTEXITCODE."
}

$installer = Join-Path $output "$OutputName.exe"
if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
    throw "The Windows installer was not created: $installer"
}
Get-Item -LiteralPath $installer
