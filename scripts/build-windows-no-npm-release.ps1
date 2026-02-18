param(
    [string]$ProjectRoot = (Join-Path $PSScriptRoot ".."),
    [string]$BundleName = "Lingo-Windows-NoNpm"
)

$ErrorActionPreference = "Stop"

$projectRootPath = (Resolve-Path $ProjectRoot).Path
$vencordRoot = Join-Path $projectRootPath "Vencord"
$distDir = Join-Path $vencordRoot "dist"
$templateDir = Join-Path $projectRootPath "scripts/windows-no-npm"
$releaseDir = Join-Path $projectRootPath "release"
$bundleDir = Join-Path $releaseDir $BundleName
$zipPath = Join-Path $releaseDir "$BundleName.zip"

if (-not (Test-Path $distDir)) {
    throw "Missing Vencord dist folder at '$distDir'. Build Vencord first."
}

if (-not (Test-Path (Join-Path $distDir "renderer.js"))) {
    throw "Missing '$distDir\\renderer.js'. Run 'npm run build' in Vencord first."
}

if (-not (Test-Path $templateDir)) {
    throw "Missing release template folder at '$templateDir'."
}

$installerCandidates = @(
    (Join-Path $distDir "Installer/VencordInstallerCli.exe"),
    (Join-Path $vencordRoot "VencordInstallerCli.exe")
)
$installerPath = $installerCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $installerPath) {
    throw "Could not find VencordInstallerCli.exe in '$distDir\\Installer' or '$vencordRoot'."
}

if (Test-Path $bundleDir) {
    Remove-Item -Recurse -Force $bundleDir
}

New-Item -ItemType Directory -Path $bundleDir | Out-Null
New-Item -ItemType Directory -Path (Join-Path $bundleDir "dist") | Out-Null
Copy-Item -Path (Join-Path $distDir "*") -Destination (Join-Path $bundleDir "dist") -Recurse -Force
Copy-Item -Path $installerPath -Destination (Join-Path $bundleDir "VencordInstallerCli.exe") -Force
Copy-Item -Path (Join-Path $templateDir "install-stable.bat") -Destination (Join-Path $bundleDir "install-stable.bat") -Force
Copy-Item -Path (Join-Path $templateDir "uninstall-stable.bat") -Destination (Join-Path $bundleDir "uninstall-stable.bat") -Force
Copy-Item -Path (Join-Path $templateDir "README.txt") -Destination (Join-Path $bundleDir "README.txt") -Force

if (Test-Path $zipPath) {
    Remove-Item -Force $zipPath
}

Compress-Archive -Path (Join-Path $bundleDir "*") -DestinationPath $zipPath -CompressionLevel Optimal -Force
Get-Item $zipPath | Select-Object Name, Length, LastWriteTime
