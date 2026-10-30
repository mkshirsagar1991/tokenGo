<#
.SYNOPSIS
  Builds the TokenGo (customer) and TokenGo Business (provider) Android apps as test APKs that talk to the backend running on THIS PC,
  so they can be installed on real phones that are on the same Wi-Fi/LAN.

.DESCRIPTION
  -Mode profile (default): optimized AOT build, SMALL (about 20 MB per app instead of 200+ MB) and fast, one APK per CPU type
      (one `flutter build --target-platform` run each; `--split-per-abi` is not used because Flutter rejects it on this project). Signed with the debug key. Allowed to use plain http:// only because the profile manifests say so
      (src/profile/AndroidManifest.xml); this is the INTERNAL TEST build, never give it to the public.
  -Mode debug: the old large debug build (JIT, ~200 MB, slow). Only useful when you need hot reload / breakpoints on a phone.
  Release builds are not made here: they refuse plain http://, so they need an HTTPS API (not available yet), plus a real signing key.

  The API address is compiled into the app (--dart-define=API_BASE_URL=...). If this PC's address changes, run this script again.

  Output (git-ignored), in <repo>\apk\ :
    TokenGo-customer-arm64.apk   TokenGo-business-arm64.apk     <- almost every phone made since ~2017 (default)
    -IncludeArm32    also writes ...-arm32.apk      <- only if "App not installed" appears on an older / 32-bit phone
    -IncludeEmulator also writes ...-x86_64.apk     <- for the Android emulator

.PARAMETER ApiBaseUrl
  Default: http://<this PC's IPv4 address on the interface that has the default gateway>:3000/api/v1

.PARAMETER Flutter
  Path to flutter(.bat). Default: $env:FLUTTER_BIN, then `flutter` on PATH.

.PARAMETER TempDir
  Folder for Gradle's temporary files. On this repo's dev machine the user's %TEMP% rejects Unix-domain sockets, which JDK 17's NIO selector
  needs on Windows (Gradle then fails with "Unable to establish loopback connection"); E:\tools\javatmp is used when it exists.
  See apps/mobile/README.md.

.EXAMPLE
  .\apps\mobile\tool\build-apks.ps1
  .\apps\mobile\tool\build-apks.ps1 -ApiBaseUrl http://192.168.1.20:3000/api/v1
  .\apps\mobile\tool\build-apks.ps1 -Mode debug
#>
param(
  [ValidateSet('profile', 'debug')] [string] $Mode = 'profile',
  [string] $ApiBaseUrl,
  [string] $OutDir = (Join-Path $PSScriptRoot '..\..\..\apk'),
  [string] $Flutter = $(if ($env:FLUTTER_BIN) { $env:FLUTTER_BIN } else { 'flutter' }),
  [string] $TempDir,
  [switch] $IncludeArm32,
  [switch] $IncludeEmulator
)
$ErrorActionPreference = 'Stop'

if (-not $ApiBaseUrl) {
  $cfg = Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' } | Select-Object -First 1
  if (-not $cfg) { throw 'Could not find this PC''s network address. Pass -ApiBaseUrl http://<address>:3000/api/v1 explicitly.' }
  $ApiBaseUrl = "http://$($cfg.IPv4Address.IPAddress):3000/api/v1"
}
if (-not $TempDir -and (Test-Path 'E:\tools\javatmp')) { $TempDir = 'E:\tools\javatmp' }
if ($TempDir) { $env:TEMP = $TempDir; $env:TMP = $TempDir }

$OutDir = [System.IO.Path]::GetFullPath($OutDir)
New-Item -ItemType Directory -Force $OutDir | Out-Null
$mobile = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))

Write-Host "Mode:                               $Mode"
Write-Host "API address compiled into the apps: $ApiBaseUrl"
Write-Host "Output folder:                      $OutDir"

$apps = @(
  @{ Dir = 'customer'; Name = 'TokenGo-customer' },
  @{ Dir = 'provider'; Name = 'TokenGo-business' }
)
foreach ($app in $apps) {
  $root = Join-Path $mobile $app.Dir
  $built = Join-Path $root 'build\app\outputs\flutter-apk'
  Push-Location $root
  try {
    Write-Host "`n=== $($app.Dir): stopping stale Gradle daemons, then building ($Mode)"
    try { & (Join-Path $root 'android\gradlew.bat') --stop 2>&1 | Out-Null } catch { }
    # Gradle re-packs the APK IN PLACE on every build and leaves the old bytes behind as dead space inside the file: a customer APK
    # made of 31 MB of content grew to 77 MB after a few builds. Dropping the previous output makes every APK a fresh, tight file.
    Remove-Item (Join-Path $root 'build\app\outputs') -Recurse -Force -ErrorAction SilentlyContinue
    if ($Mode -eq 'debug') {
      & $Flutter build apk --debug "--dart-define=API_BASE_URL=$ApiBaseUrl"
      if ($LASTEXITCODE -ne 0) { throw "flutter build failed for $($app.Dir) (exit $LASTEXITCODE)" }
      Copy-Item (Join-Path $built 'app-debug.apk') (Join-Path $OutDir "$($app.Name)-debug.apk") -Force
    } else {
      $targets = @(@{ Platform = 'android-arm64'; Suffix = 'arm64' })
      if ($IncludeArm32)    { $targets += @{ Platform = 'android-arm'; Suffix = 'arm32' } }
      if ($IncludeEmulator) { $targets += @{ Platform = 'android-x64'; Suffix = 'x86_64' } }
      foreach ($t in $targets) {
        Write-Host "--- $($app.Dir) / $($t.Suffix)"
        & $Flutter build apk --profile --target-platform $t.Platform "--dart-define=API_BASE_URL=$ApiBaseUrl"
        if ($LASTEXITCODE -ne 0) { throw "flutter build failed for $($app.Dir) $($t.Suffix) (exit $LASTEXITCODE)" }
        Copy-Item (Join-Path $built 'app-profile.apk') (Join-Path $OutDir "$($app.Name)-$($t.Suffix).apk") -Force
      }
    }
  } finally {
    Pop-Location
  }
}

Write-Host "`n=== Done"
Get-ChildItem $OutDir -Filter *.apk | Sort-Object Name | ForEach-Object {
  [pscustomobject]@{ File = $_.Name; MB = [math]::Round($_.Length / 1MB, 1); SHA256 = (Get-FileHash $_.FullName -Algorithm SHA256).Hash }
} | Format-Table -AutoSize | Out-String -Width 220 | Write-Host
Write-Host "Install on a phone on the same network; the backend (API :3000 + worker) must be running on this PC. Login codes (OTP) are printed in the API log."
