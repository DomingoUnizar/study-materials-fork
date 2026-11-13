# Packages and verifies the Windows x64 build produced by `pnpm tauri build --bundles nsis`.
#
#   artifacts/HGhub_<version>_x64-setup.exe      NSIS installer, exactly as Tauri built it
#   artifacts/HGhub_<version>_x64_portable.zip   HGhub.exe + README.txt + LICENSE.txt
#   artifacts/HGhub_<version>_x64_SHA256SUMS.txt
#
# Checks: the app binary is an x64 PE32+ image and imports no redistributable runtime DLL
# (so the portable exe needs nothing but Windows and the WebView2 Runtime), the zip round-trips
# byte-for-byte, and size, SHA-256 and Authenticode status of every file are reported.
#
# Used by .github/workflows/windows-x64.yml. Run from the repository root; works in
# PowerShell 7 and Windows PowerShell 5.1. Keep this file ASCII-only.
param(
  [string]$Version = $env:VERSION,
  [string]$MainBinary = $env:MAIN_BINARY
)
$ErrorActionPreference = 'Stop'

if (-not $Version) { throw 'Version is empty (pass -Version or set VERSION)' }
if (-not $MainBinary) { $MainBinary = 'huangguo-client' }
$v       = $Version
$rel     = 'src-tauri/target/release'
$utf8    = New-Object System.Text.UTF8Encoding($false)
$utf8Bom = New-Object System.Text.UTF8Encoding($true)
if ($PSScriptRoot) { $here = $PSScriptRoot } else { $here = Join-Path (Get-Location).ProviderPath 'scripts' }
if ($env:RUNNER_TEMP) { $tmpRoot = $env:RUNNER_TEMP } else { $tmpRoot = [System.IO.Path]::GetTempPath() }
if ($env:GITHUB_SERVER_URL -and $env:GITHUB_REPOSITORY) { $repoUrl = "$env:GITHUB_SERVER_URL/$env:GITHUB_REPOSITORY" } else { $repoUrl = '(local build)' }
if ($env:GITHUB_RUN_ID -and $repoUrl -ne '(local build)') { $runUrl = "$repoUrl/actions/runs/$env:GITHUB_RUN_ID" } else { $runUrl = '(local build)' }
if ($env:GITHUB_SHA) { $commit = $env:GITHUB_SHA } else { $commit = '(local build)' }

# Minimal PE reader: machine type, PE32/PE32+, subsystem, imported DLL names, certificate table size.
function Get-PeInfo([string]$Path) {
  $b = [System.IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $Path).ProviderPath)
  if ($b.Length -lt 0x40 -or [BitConverter]::ToUInt16($b, 0) -ne 0x5A4D) { throw "Not an MZ executable: $Path" }
  $pe = [BitConverter]::ToInt32($b, 0x3C)
  if ($pe -le 0 -or ($pe + 24) -gt $b.Length -or [BitConverter]::ToUInt32($b, $pe) -ne 0x4550) { throw "PE signature not found: $Path" }
  $machine   = [int][BitConverter]::ToUInt16($b, $pe + 4)
  $nSections = [int][BitConverter]::ToUInt16($b, $pe + 6)
  $optSize   = [int][BitConverter]::ToUInt16($b, $pe + 20)
  $opt       = $pe + 24
  $magic     = [int][BitConverter]::ToUInt16($b, $opt)
  $subsystem = [int][BitConverter]::ToUInt16($b, $opt + 68)
  if ($magic -eq 0x20B) { $dd = $opt + 112 } elseif ($magic -eq 0x10B) { $dd = $opt + 96 } else { throw ('Unknown optional header magic 0x{0:X} in {1}' -f $magic, $Path) }
  $nDirs = [int64][BitConverter]::ToUInt32($b, $dd - 4)

  $sections = @()
  $secTable = $opt + $optSize
  for ($i = 0; $i -lt $nSections; $i++) {
    $o = $secTable + 40 * $i
    $sections += [pscustomobject]@{
      VA    = [int64][BitConverter]::ToUInt32($b, $o + 12)
      RSize = [int64][BitConverter]::ToUInt32($b, $o + 16)
      RPtr  = [int64][BitConverter]::ToUInt32($b, $o + 20)
    }
  }
  $toOffset = {
    param([int64]$rva)
    foreach ($s in $sections) {
      if ($rva -ge $s.VA -and $rva -lt ($s.VA + $s.RSize)) { return [int64]($rva - $s.VA + $s.RPtr) }
    }
    return [int64]-1
  }
  $readName = {
    param([int64]$rva)
    $off = & $toOffset $rva
    if ($off -lt 0 -or $off -ge $b.Length) { return $null }
    $end = [Array]::IndexOf($b, [byte]0, [int]$off)
    if ($end -lt 0) { $end = $b.Length }
    return [System.Text.Encoding]::ASCII.GetString($b, [int]$off, [int]($end - $off))
  }

  # Import directory (data directory #1): 20-byte descriptors, DLL name RVA at +12.
  $imports = New-Object System.Collections.Generic.List[string]
  $impRva = [int64]0
  if ($nDirs -gt 1) { $impRva = [int64][BitConverter]::ToUInt32($b, $dd + 8) }
  if ($impRva -ne 0) {
    $o = & $toOffset $impRva
    while ($o -ge 0 -and ($o + 20) -le $b.Length) {
      $oft  = [BitConverter]::ToUInt32($b, $o)
      $name = [int64][BitConverter]::ToUInt32($b, $o + 12)
      $iat  = [BitConverter]::ToUInt32($b, $o + 16)
      if ($oft -eq 0 -and $name -eq 0 -and $iat -eq 0) { break }
      $n = & $readName $name
      if ($n) { $imports.Add($n) }
      $o += 20
    }
  }
  # Delay-load import directory (data directory #13): 32-byte descriptors, DLL name RVA at +4.
  $delay = New-Object System.Collections.Generic.List[string]
  $delayRva = [int64]0
  if ($nDirs -gt 13) { $delayRva = [int64][BitConverter]::ToUInt32($b, $dd + 8 * 13) }
  if ($delayRva -ne 0) {
    $o = & $toOffset $delayRva
    while ($o -ge 0 -and ($o + 32) -le $b.Length) {
      $name = [int64][BitConverter]::ToUInt32($b, $o + 4)
      if ($name -eq 0) { break }
      $n = & $readName $name
      if ($n) { $delay.Add($n) }
      $o += 32
    }
  }
  # Certificate table (data directory #4): a non-zero size means an embedded Authenticode signature.
  $certSize = [int64]0
  if ($nDirs -gt 4) { $certSize = [int64][BitConverter]::ToUInt32($b, $dd + 8 * 4 + 4) }

  switch ($machine) {
    0x8664  { $machineName = 'x64 (AMD64, 0x8664)' }
    0x014C  { $machineName = 'x86 (I386, 0x014C)' }
    0xAA64  { $machineName = 'ARM64 (0xAA64)' }
    default { $machineName = ('unknown (0x{0:X4})' -f $machine) }
  }
  if ($magic -eq 0x20B) { $format = 'PE32+ (64-bit image)' } else { $format = 'PE32 (32-bit image)' }
  switch ($subsystem) {
    2       { $subName = 'Windows GUI' }
    3       { $subName = 'Windows console' }
    default { $subName = "subsystem $subsystem" }
  }
  return [pscustomobject]@{
    MachineId     = $machine
    Machine       = $machineName
    Magic         = $magic
    Format        = $format
    Subsystem     = $subName
    Imports       = @($imports | Sort-Object -Unique)
    DelayImports  = @($delay | Sort-Object -Unique)
    CertTableSize = $certSize
  }
}

function Get-Sha256([string]$Path) {
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-SignatureText([string]$Path, $Pe) {
  $s = Get-AuthenticodeSignature -LiteralPath $Path
  $t = [string]$s.Status
  if ($s.SignerCertificate) { $t += ' / ' + $s.SignerCertificate.Subject }
  return ('{0} (PE certificate table: {1} bytes)' -f $t, $Pe.CertTableSize)
}

function Format-Size([long]$n) {
  return ('{0:N0} bytes ({1:N2} MiB)' -f $n, ($n / 1MB))
}

# ---- 1. Locate build outputs ---------------------------------------------------------------
$nsisDir = Join-Path $rel 'bundle/nsis'
if (-not (Test-Path -LiteralPath $nsisDir -PathType Container)) { throw "NSIS bundle directory not found: $nsisDir" }
$setups = @(Get-ChildItem -LiteralPath $nsisDir -Filter '*-setup.exe' -File)
if ($setups.Count -ne 1) { throw "Expected exactly one *-setup.exe in $nsisDir, found $($setups.Count)" }
$setupSrc = $setups[0].FullName
$binSrc = Join-Path $rel ($MainBinary + '.exe')
if (-not (Test-Path -LiteralPath $binSrc -PathType Leaf)) {
  Get-ChildItem -LiteralPath $rel -Filter '*.exe' -File | ForEach-Object { Write-Host "  present: $($_.Name)" }
  throw "Main binary not found: $binSrc"
}
$binSrc = (Resolve-Path -LiteralPath $binSrc).ProviderPath
Write-Host "Installer built by Tauri : $setupSrc"
Write-Host "App binary               : $binSrc"

# ---- 2. Architecture -----------------------------------------------------------------------
$binPe   = Get-PeInfo $binSrc
$setupPe = Get-PeInfo $setupSrc
Write-Host "App binary : $($binPe.Machine), $($binPe.Format), $($binPe.Subsystem)"
Write-Host "Installer  : $($setupPe.Machine), $($setupPe.Format), $($setupPe.Subsystem)  (NSIS installer stubs are 32-bit x86 by design)"
if ($binPe.MachineId -ne 0x8664 -or $binPe.Magic -ne 0x20B) {
  throw "App binary is not an x64 PE32+ image: $($binPe.Machine), $($binPe.Format)"
}

# ---- 3. Runtime DLL dependencies of the app binary -----------------------------------------
# Redistributable runtimes (VC++ runtime, WebView2Loader, MinGW runtime) must not be imported:
# the portable zip ships a single exe and its README says nothing else has to be installed.
# A DLL that is neither an API set nor present in System32 of this machine is reported as a warning.
$redist = '^(vcruntime\d+(_\d+)?d?|msvcp\d+\w*|msvcr\d+d?|vccorlib\d+\w*|concrt\d+\w*|vcomp\d+\w*|ucrtbased|webview2loader|libgcc[\w-]*|libstdc\+\+[\w-]*|libwinpthread[\w-]*)\.dll$'
$allImports = @($binPe.Imports) + @($binPe.DelayImports)
if ($allImports.Count -eq 0) { throw 'Import table of the app binary could not be read' }
$sys32 = Join-Path $env:SystemRoot 'System32'
$blocked = New-Object System.Collections.Generic.List[string]
$unknown = New-Object System.Collections.Generic.List[string]
foreach ($d in $allImports) {
  if ($d -match '^(api-ms-win-|ext-ms-)') { continue }
  if ($d -match $redist) { $blocked.Add($d); continue }
  if (-not (Test-Path -LiteralPath (Join-Path $sys32 $d) -PathType Leaf)) { $unknown.Add($d) }
}
Write-Host ('Imported DLLs ({0}): {1}' -f $allImports.Count, ($allImports -join ', '))
foreach ($d in $unknown) { Write-Host "::warning title=Unrecognised DLL import::$MainBinary.exe imports $d, which is not in System32 on the build machine" }
if ($blocked.Count -gt 0) {
  throw "$MainBinary.exe imports redistributable runtime DLL(s): $($blocked -join ', '). The portable build would need extra components; expected a statically linked VC runtime and WebView2 loader."
}
Write-Host 'No redistributable runtime DLL imports: the exe needs only Windows itself plus the WebView2 Runtime.'

# ---- 4. Installer + portable zip -----------------------------------------------------------
$outDir = Join-Path (Get-Location).ProviderPath 'artifacts'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$setupName = "HGhub_${v}_x64-setup.exe"
$setupPath = Join-Path $outDir $setupName
Copy-Item -LiteralPath $setupSrc -Destination $setupPath -Force

$stage = Join-Path $tmpRoot 'hghub-portable-stage'
if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $stage | Out-Null
Copy-Item -LiteralPath $binSrc -Destination (Join-Path $stage 'HGhub.exe')
Copy-Item -LiteralPath 'LICENSE' -Destination (Join-Path $stage 'LICENSE.txt')

$exeHash = Get-Sha256 $binSrc
$exeLen  = (Get-Item -LiteralPath $binSrc).Length

# README.txt comes from a UTF-8 template next to this script (keeps this file ASCII-only).
$readme = [System.IO.File]::ReadAllText((Join-Path $here 'windows-portable-readme.txt'), $utf8)
$fields = @{
  '{{VERSION}}'    = $v
  '{{COMMIT}}'     = $commit
  '{{RUN_URL}}'    = $runUrl
  '{{REPO_URL}}'   = $repoUrl
  '{{EXE_SHA256}}' = $exeHash
}
foreach ($k in $fields.Keys) { $readme = $readme.Replace($k, [string]$fields[$k]) }
if ($readme -match '\{\{[A-Z0-9_]+\}\}') { throw "Unreplaced placeholder in windows-portable-readme.txt: $($Matches[0])" }
$readme = ($readme -replace "`r`n", "`n") -replace "`n", "`r`n"
[System.IO.File]::WriteAllText((Join-Path $stage 'README.txt'), $readme, $utf8Bom)

$zipName = "HGhub_${v}_x64_portable.zip"
$zipPath = Join-Path $outDir $zipName
if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zipPath -CompressionLevel Optimal

# Round trip: what comes out of the zip must be byte-identical to what was built.
$check = Join-Path $tmpRoot 'hghub-portable-check'
if (Test-Path -LiteralPath $check) { Remove-Item -LiteralPath $check -Recurse -Force }
Expand-Archive -LiteralPath $zipPath -DestinationPath $check
$zipEntries = @(Get-ChildItem -LiteralPath $check -Recurse -File | ForEach-Object { $_.Name } | Sort-Object)
Write-Host ('Portable zip entries: {0}' -f ($zipEntries -join ', '))
if (($zipEntries -join ',') -ne 'HGhub.exe,LICENSE.txt,README.txt') { throw "Unexpected portable zip contents: $($zipEntries -join ', ')" }
if ((Get-Sha256 (Join-Path $check 'HGhub.exe')) -ne $exeHash) { throw 'HGhub.exe extracted from the portable zip differs from the built binary' }

# ---- 5. Hashes, signatures, sums file ------------------------------------------------------
$setupHash = Get-Sha256 $setupPath
$zipHash   = Get-Sha256 $zipPath
$setupLen  = (Get-Item -LiteralPath $setupPath).Length
$zipLen    = (Get-Item -LiteralPath $zipPath).Length
$sigExe    = Get-SignatureText $binSrc $binPe
$sigSetup  = Get-SignatureText $setupPath $setupPe

$sumsName = "HGhub_${v}_x64_SHA256SUMS.txt"
$sumsPath = Join-Path $outDir $sumsName
$sums = "$setupHash  $setupName`n$zipHash  $zipName`n"
[System.IO.File]::WriteAllText($sumsPath, $sums, $utf8)
$sumsHash = Get-Sha256 $sumsPath

Write-Host ''
Write-Host "== $setupName"
Write-Host "   size      : $(Format-Size $setupLen)"
Write-Host "   sha256    : $setupHash"
Write-Host "   signature : $sigSetup"
Write-Host "== $zipName"
Write-Host "   size      : $(Format-Size $zipLen)"
Write-Host "   sha256    : $zipHash"
Write-Host "== HGhub.exe (inside the zip; built as $MainBinary.exe)"
Write-Host "   size      : $(Format-Size $exeLen)"
Write-Host "   sha256    : $exeHash"
Write-Host "   signature : $sigExe"

# ---- 6. Release profile actually used ------------------------------------------------------
$cargoToml = Get-Content -LiteralPath 'src-tauri/Cargo.toml' -Raw
$m = [regex]::Match($cargoToml, '(?ms)^\[profile\.release\][^\n]*\n(.*?)(?=^\[|\z)')
if ($m.Success) { $profileText = ($m.Groups[1].Value -replace "`r", '').Trim() } else { $profileText = '(no [profile.release] section: Cargo defaults, opt-level = 3)' }
$overrides = @(Get-ChildItem env: | Where-Object { $_.Name -like 'CARGO_PROFILE_RELEASE_*' -or $_.Name -like '*RUSTFLAGS' } | ForEach-Object { "$($_.Name)=$($_.Value)" })
if ($overrides.Count -eq 0) { $overrideText = 'none' } else { $overrideText = $overrides -join '; ' }
Write-Host ''
Write-Host '== [profile.release] in src-tauri/Cargo.toml'
Write-Host $profileText
Write-Host "== release-profile / RUSTFLAGS overrides in the environment: $overrideText"

# ---- 7. Step summary + outputs (GitHub Actions only) ---------------------------------------
if ($unknown.Count -eq 0) { $depText = 'none (Windows system DLLs only; the WebView2 Runtime is loaded at run time)' } else { $depText = 'not in System32 on the runner: ' + ($unknown -join ', ') }
$md = New-Object System.Collections.Generic.List[string]
$md.Add("## HGhub $v - Windows x64 (Release)")
$md.Add('')
$md.Add('| | Installer (NSIS) | Portable |')
$md.Add('|---|---|---|')
$md.Add(('| File | `{0}` | `{1}` |' -f $setupName, $zipName))
$md.Add(('| Size | {0} | {1} |' -f (Format-Size $setupLen), (Format-Size $zipLen)))
$md.Add(('| SHA-256 | `{0}` | `{1}` |' -f $setupHash, $zipHash))
$md.Add(('| Authenticode | {0} | exe inside: {1} |' -f $sigSetup, $sigExe))
$md.Add('')
$md.Add('### App binary')
$md.Add('')
$md.Add('| | |')
$md.Add('|---|---|')
$md.Add(('| Name | `HGhub.exe` in the zip (built as `{0}.exe`) |' -f $MainBinary))
$md.Add(('| Architecture | {0}, {1}, {2} |' -f $binPe.Machine, $binPe.Format, $binPe.Subsystem))
$md.Add(('| Size | {0} |' -f (Format-Size $exeLen)))
$md.Add(('| SHA-256 | `{0}` |' -f $exeHash))
$md.Add(('| Extra runtime DLLs | {0} |' -f $depText))
$md.Add(('| Installer stub | {0}, {1} (NSIS stubs are 32-bit by design) |' -f $setupPe.Machine, $setupPe.Format))
$md.Add(('| Portable zip contents | {0} |' -f ($zipEntries -join ', ')))
$md.Add('')
$md.Add('<details><summary>Imported DLLs</summary>')
$md.Add('')
$md.Add('```')
$md.Add(($allImports -join "`n"))
$md.Add('```')
$md.Add('')
$md.Add('</details>')
$md.Add('')
$md.Add('<details><summary>Release profile (src-tauri/Cargo.toml)</summary>')
$md.Add('')
$md.Add('```toml')
$md.Add($profileText)
$md.Add('```')
$md.Add('')
$md.Add("Release-profile / RUSTFLAGS overrides in the environment: $overrideText")
$md.Add('')
$md.Add('</details>')
$md.Add('')
if ($env:GITHUB_STEP_SUMMARY) {
  [System.IO.File]::AppendAllText($env:GITHUB_STEP_SUMMARY, (($md -join "`n") + "`n"), $utf8)
}
if ($env:GITHUB_OUTPUT) {
  $out = @(
    "setup_name=$setupName",
    "zip_name=$zipName",
    "sums_name=$sumsName",
    "setup_sha256=$setupHash",
    "zip_sha256=$zipHash",
    "sums_sha256=$sumsHash",
    "exe_sha256=$exeHash"
  ) -join "`n"
  [System.IO.File]::AppendAllText($env:GITHUB_OUTPUT, ($out + "`n"), $utf8)
}
