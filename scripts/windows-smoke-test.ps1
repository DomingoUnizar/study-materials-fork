# Informational smoke test for the Windows x64 build, run on the GitHub-hosted build runner:
#   1. extracts the portable zip and starts HGhub.exe (process stays alive, main window, WebView2 child);
#   2. installs the NSIS setup silently (/S, per-user) and checks the uninstall entry and installed exe.
# The runner is a Windows Server VM, so this is NOT a Windows 11 device test.
# Used by .github/workflows/windows-x64.yml with continue-on-error. Keep this file ASCII-only.
$ErrorActionPreference = 'Stop'
$utf8  = New-Object System.Text.UTF8Encoding($false)
$state = @{ Failed = $false }
$md    = New-Object System.Collections.Generic.List[string]
$md.Add('### Launch smoke test on the build runner (informational)')
$md.Add('')
$md.Add("Runner image: $env:ImageOS $env:ImageVersion (Windows Server VM). **Not** a Windows 11 device test: it only shows that the files start and install on the runner.")
$md.Add('')

function Add-Result([string]$Name, [bool]$Ok, [string]$Detail) {
  if ($Ok) { $mark = 'PASS' } else { $mark = 'FAIL' }
  Write-Host "[$mark] $Name - $Detail"
  $md.Add("- **$mark** $Name - $Detail")
  if (-not $Ok) { $state.Failed = $true }
}

function Get-WebView2Version {
  foreach ($k in @(
      'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
      'HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
      'HKCU:\Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}')) {
    if (-not (Test-Path -LiteralPath $k)) { continue }
    $item = Get-ItemProperty -LiteralPath $k -ErrorAction SilentlyContinue
    if ($item -and $item.PSObject.Properties['pv'] -and $item.pv -and $item.pv -ne '0.0.0.0') { return [string]$item.pv }
  }
  return $null
}

try {
  $wv2 = Get-WebView2Version
  if ($wv2) { $wv2Text = "WebView2 Runtime $wv2" } else { $wv2Text = 'no WebView2 Runtime registered' }
  Write-Host "Runner: $wv2Text"
  $md.Add("- Runner: $wv2Text")

  # ---- 1. portable zip: extract and launch ----
  $work = Join-Path $env:RUNNER_TEMP 'hghub-smoke-portable'
  if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force }
  Expand-Archive -LiteralPath (Join-Path 'artifacts' $env:ZIP_NAME) -DestinationPath $work
  $exe = Join-Path $work 'HGhub.exe'
  $p = Start-Process -FilePath $exe -WorkingDirectory $work -PassThru
  $null = $p.Handle
  $hasWindow = $false
  $deadline = (Get-Date).AddSeconds(60)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    $p.Refresh()
    if ($p.HasExited) { break }
    if ($p.MainWindowHandle -ne [IntPtr]::Zero) { $hasWindow = $true; break }
  }
  # Let the webview finish starting; a crash during startup shows up as an exited process.
  if (-not $p.HasExited) { Start-Sleep -Seconds 12; $p.Refresh() }
  if (-not $p.HasExited) {
    if ($p.MainWindowHandle -ne [IntPtr]::Zero) { $hasWindow = $true }
    $title = [string]$p.MainWindowTitle
    $children = @(Get-CimInstance Win32_Process -Filter "Name = 'msedgewebview2.exe'" | Where-Object { $_.ParentProcessId -eq $p.Id })
    $ws = [math]::Round($p.WorkingSet64 / 1MB, 1)
    Add-Result 'Portable HGhub.exe starts' $true "process still running after startup (pid $($p.Id), working set $ws MiB)"
    Add-Result 'Main window created' ($hasWindow -and $title -eq 'HGhub') "main window title '$title'"
    Add-Result 'WebView2 attached' ($children.Count -ge 1) "$($children.Count) msedgewebview2.exe child process(es)"
    Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
    $null = $p.WaitForExit(15000)
    foreach ($c in $children) { Stop-Process -Id ([int]$c.ProcessId) -Force -ErrorAction SilentlyContinue }
  } else {
    Add-Result 'Portable HGhub.exe starts' $false "process exited during startup with exit code $($p.ExitCode)"
  }

  # ---- 2. installer: silent per-user install ----
  $setup = (Resolve-Path -LiteralPath (Join-Path 'artifacts' $env:SETUP_NAME)).ProviderPath
  $inst = Start-Process -FilePath $setup -ArgumentList '/S' -PassThru
  $null = $inst.Handle
  if (-not $inst.WaitForExit(300000)) {
    Stop-Process -Id $inst.Id -Force -ErrorAction SilentlyContinue
    Add-Result 'Installer silent install (/S)' $false 'did not finish within 5 minutes'
  } else {
    Add-Result 'Installer silent install (/S)' ($inst.ExitCode -eq 0) "exit code $($inst.ExitCode)"
    $entry = $null
    foreach ($root in @(
        'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
        'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
        'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')) {
      if (-not (Test-Path -LiteralPath $root)) { continue }
      $entry = Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue |
        ForEach-Object { Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue } |
        Where-Object { $_.PSObject.Properties['DisplayName'] -and $_.DisplayName -eq 'HGhub' } |
        Select-Object -First 1
      if ($entry) { break }
    }
    $dir = $null
    if ($entry) {
      $ver = ''
      if ($entry.PSObject.Properties['DisplayVersion']) { $ver = [string]$entry.DisplayVersion }
      Add-Result 'Uninstall entry registered' $true "DisplayName HGhub, DisplayVersion $ver, key $($entry.PSChildName)"
      if ($entry.PSObject.Properties['InstallLocation'] -and $entry.InstallLocation) { $dir = ([string]$entry.InstallLocation).Trim().Trim('"') }
    } else {
      Add-Result 'Uninstall entry registered' $false 'no Uninstall registry entry with DisplayName HGhub'
    }
    if (-not $dir) { $dir = Join-Path $env:LOCALAPPDATA 'HGhub' }
    $exes = @(Get-ChildItem -LiteralPath $dir -Filter '*.exe' -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -notmatch '^uninstall' })
    $match = $null
    foreach ($e in $exes) {
      if ((Get-FileHash -LiteralPath $e.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -eq $env:EXE_SHA256) { $match = $e; break }
    }
    if ($match) {
      Add-Result 'Installed app exe is the x64 binary that was built' $true "$($match.FullName) has the same SHA-256 as HGhub.exe in the portable zip"
    } elseif ($exes.Count -gt 0) {
      Add-Result 'Installed app exe is the x64 binary that was built' $false "exe(s) in ${dir}: $(($exes | ForEach-Object { $_.Name }) -join ', '), none matches the built binary"
    } else {
      Add-Result 'Installed app exe is the x64 binary that was built' $false "no app exe found in $dir"
    }
    $files = @(Get-ChildItem -LiteralPath $dir -File -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Name) ($($_.Length) bytes)" })
    Write-Host "Installed files in ${dir}: $($files -join ', ')"
    $md.Add("- Installed files in ``$dir``: $($files -join ', ')")
  }
} catch {
  Add-Result 'Smoke test script' $false ('unexpected error: ' + $_.Exception.Message)
} finally {
  $md.Add('')
  if ($env:GITHUB_STEP_SUMMARY) {
    [System.IO.File]::AppendAllText($env:GITHUB_STEP_SUMMARY, (($md -join "`n") + "`n"), $utf8)
  }
}
if ($state.Failed) {
  Write-Host '::warning title=Smoke test::At least one launch/install check failed on the runner; see the job summary. The uploaded artifacts are unaffected.'
  exit 1
}
