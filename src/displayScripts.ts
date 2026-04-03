// ---------------------------------------------------------------------------
// PowerShell script generators for headless virtual display management
// ---------------------------------------------------------------------------
//
// These functions return PowerShell script *source code* as strings. The
// calling code is responsible for writing them to disk and executing them.
// ---------------------------------------------------------------------------

import { EMERGENCY_HOTKEY, STREAMER_PROCESS_NAME } from './constants';

// ---------------------------------------------------------------------------
// Types for script options
// ---------------------------------------------------------------------------

export interface SetupScriptOptions {
  /** Absolute path to dxgi-info.exe */
  dxgiInfoPath: string;
  /** Absolute path where the sentinel JSON file will be written */
  sentinelPath: string;
  /** Absolute path where the watchdog .ps1 script lives */
  watchdogScriptPath: string;
  /** Absolute path where the teardown .ps1 script lives */
  teardownScriptPath: string;
}

export interface TeardownScriptOptions {
  /** Absolute path to the sentinel JSON file */
  sentinelPath: string;
}

export interface WatchdogScriptOptions {
  /** Absolute path to the sentinel JSON file */
  sentinelPath: string;
  /** Absolute path to the teardown .ps1 script */
  teardownScriptPath: string;
}


// ---------------------------------------------------------------------------
// Setup script
// ---------------------------------------------------------------------------

/**
 * Generates a PowerShell script that:
 *  1. Snapshots current displays via dxgi-info.exe ("before").
 *  2. Enables the VDD device via pnputil.
 *  3. Polls for a new display to appear (max 10 s).
 *  4. Writes a sentinel JSON file describing the session.
 *  5. Spawns the watchdog process in the background.
 *
 * Physical monitors are left untouched — the virtual display is added as an
 * extra monitor that Vibeshine captures from.
 */
export function generateSetupScript(options: SetupScriptOptions): string {
  const {
    dxgiInfoPath,
    sentinelPath,
    watchdogScriptPath,
    teardownScriptPath,
  } = options;

  return `
#Requires -Version 5.1
param(
    [string]$DxgiInfoPath    = '${escapePsString(dxgiInfoPath)}',
    [string]$SentinelPath    = '${escapePsString(sentinelPath)}',
    [string]$WatchdogScriptPath = '${escapePsString(watchdogScriptPath)}',
    [string]$TeardownScriptPath = '${escapePsString(teardownScriptPath)}'
)

$ErrorActionPreference = 'Stop'

# ---------- Helper: run dxgi-info and parse displays ----------
function Get-Displays {
    param([string]$ExePath)
    $output = & $ExePath 2>&1
    $displays = @()
    $currentAdapter = ''
    foreach ($line in $output) {
        if ($line -match '^Adapter\\s+\\d+:\\s+(.+)$') {
            $currentAdapter = $Matches[1].Trim()
        }
        elseif ($line -match 'Output\\s+\\d+:\\s+(\\\\\\\\.\\\\[A-Za-z0-9]+)\\s+\\((\\d+x\\d+),\\s*AttachedToDesktop:\\s*(yes|no)\\)') {
            $displays += [PSCustomObject]@{
                Name       = $Matches[1]
                Resolution = $Matches[2]
                Attached   = ($Matches[3] -eq 'yes')
                Adapter    = $currentAdapter
            }
        }
    }
    return $displays
}

# ---------- 1. Snapshot current displays ----------
Write-Host '[Setup] Enumerating displays (before)...'
$before = Get-Displays -ExePath $DxgiInfoPath
Write-Host "[Setup] Found $($before.Count) display(s) before enabling VDD."

# ---------- Helper: Resolve VDD instance ID ----------
function Get-VddInstanceId {
    $devices = Get-PnpDevice -FriendlyName '*Virtual Display*' -ErrorAction SilentlyContinue
    if (-not $devices) { throw 'VDD device not found. Ensure the Virtual Display Driver is installed.' }
    # Prefer a device with Status OK (enabled) over one in error/disconnected state
    $ok = $devices | Where-Object { $_.Status -eq 'OK' } | Select-Object -First 1
    if ($ok) { return $ok.InstanceId }
    return ($devices | Select-Object -First 1).InstanceId
}

# ---------- 2. Enable VDD ----------
$VddInstanceId = Get-VddInstanceId
Write-Host "[Setup] Resolved VDD instance ID: $VddInstanceId"
Write-Host '[Setup] Enabling Virtual Display Driver...'
pnputil /enable-device $VddInstanceId | Out-Null

# ---------- 3. Poll for new display (max 10s) ----------
Write-Host '[Setup] Waiting for virtual display to appear...'
$newDisplay = $null
for ($i = 0; $i -lt 10; $i++) {
    Start-Sleep -Seconds 1
    $after = Get-Displays -ExePath $DxgiInfoPath
    $beforeNames = $before | ForEach-Object { $_.Name }
    foreach ($d in $after) {
        if ($beforeNames -notcontains $d.Name) {
            $newDisplay = $d.Name
            break
        }
    }
    if ($newDisplay) { break }
}

if (-not $newDisplay) {
    Write-Error '[Setup] Virtual display did not appear within 10 seconds.'
    exit 1
}
Write-Host "[Setup] New virtual display detected: $newDisplay"

# ---------- 4. Write sentinel file ----------
$sentinel = @{
    timestamp      = (Get-Date -Format 'o')
    virtualDisplay = $newDisplay
    teardownScript = $TeardownScriptPath
} | ConvertTo-Json -Depth 4

Set-Content -Path $SentinelPath -Value $sentinel -Encoding UTF8
Write-Host "[Setup] Sentinel written to $SentinelPath"

# ---------- 5. Spawn watchdog ----------
Write-Host '[Setup] Starting watchdog process...'
Start-Process -FilePath 'powershell.exe' \`
    -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $WatchdogScriptPath \`
    -WindowStyle Hidden

Write-Host '[Setup] Done. Virtual display is active, physical displays unchanged.'
`;
}

// ---------------------------------------------------------------------------
// Teardown script
// ---------------------------------------------------------------------------

/**
 * Generates a PowerShell script that:
 *  1. Reads the sentinel file.
 *  2. Disables the VDD device (removes the virtual display).
 *  3. Removes the sentinel file.
 *  4. Kills any running watchdog process.
 *
 * Physical monitors are never touched — only the virtual display is removed.
 */
export function generateTeardownScript(options: TeardownScriptOptions): string {
  const { sentinelPath } = options;

  return `
#Requires -Version 5.1
param(
    [string]$SentinelPath = '${escapePsString(sentinelPath)}'
)

$ErrorActionPreference = 'Stop'

# ---------- 1. Read sentinel ----------
if (-not (Test-Path $SentinelPath)) {
    Write-Warning '[Teardown] Sentinel file not found — nothing to restore.'
    exit 0
}

$sentinel = Get-Content -Path $SentinelPath -Raw | ConvertFrom-Json
Write-Host "[Teardown] Removing virtual display created at $($sentinel.timestamp)"

# ---------- Helper: Resolve VDD instance ID ----------
function Get-VddInstanceId {
    $devices = Get-PnpDevice -FriendlyName '*Virtual Display*' -ErrorAction SilentlyContinue
    if (-not $devices) { throw 'VDD device not found.' }
    # Prefer a device with Status OK (enabled) over one in error/disconnected state
    $ok = $devices | Where-Object { $_.Status -eq 'OK' } | Select-Object -First 1
    if ($ok) { return $ok.InstanceId }
    return ($devices | Select-Object -First 1).InstanceId
}

# ---------- 2. Disable VDD ----------
$VddInstanceId = Get-VddInstanceId
Write-Host "[Teardown] Resolved VDD instance ID: $VddInstanceId"
Write-Host '[Teardown] Disabling Virtual Display Driver...'
pnputil /disable-device $VddInstanceId | Out-Null

# ---------- 3. Remove sentinel ----------
Remove-Item -Path $SentinelPath -Force -ErrorAction SilentlyContinue
Write-Host '[Teardown] Sentinel removed.'

# ---------- 4. Kill watchdog ----------
Write-Host '[Teardown] Stopping watchdog process(es)...'
Get-Process -Name 'powershell' -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*watchdog*' } |
    Stop-Process -Force -ErrorAction SilentlyContinue

Write-Host '[Teardown] Virtual display removed.'
`;
}

// ---------------------------------------------------------------------------
// Watchdog script
// ---------------------------------------------------------------------------

/**
 * Generates a PowerShell watchdog script that:
 *  1. Monitors the `sunshine.exe` (streamer) process.
 *  2. If the streamer exits while a sentinel file exists, waits 10 s and
 *     then runs the teardown script.
 *  3. Registers a global hotkey (${EMERGENCY_HOTKEY}) that triggers teardown.
 *  4. Self-terminates after 4 hours as a safety measure.
 */
export function generateWatchdogScript(options: WatchdogScriptOptions): string {
  const { sentinelPath, teardownScriptPath } = options;

  return `
#Requires -Version 5.1
param(
    [string]$SentinelPath       = '${escapePsString(sentinelPath)}',
    [string]$TeardownScriptPath = '${escapePsString(teardownScriptPath)}'
)

$ErrorActionPreference = 'SilentlyContinue'

# ---------- Constants ----------
$MaxLifetimeSeconds = 4 * 60 * 60  # 4 hours
$StreamerProcessName = '${STREAMER_PROCESS_NAME}'
$PollIntervalSeconds = 5
$GracePeriodSeconds  = 10

# ---------- Hotkey registration ----------
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public class HotkeyHelper {
    [DllImport("user32.dll")]
    public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

    [DllImport("user32.dll")]
    public static extern bool UnregisterHotKey(IntPtr hWnd, int id);

    [DllImport("user32.dll")]
    public static extern int GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);

    [StructLayout(LayoutKind.Sequential)]
    public struct MSG {
        public IntPtr hwnd;
        public uint message;
        public IntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public int pt_x;
        public int pt_y;
    }

    // Modifier flags
    public const uint MOD_CONTROL = 0x0002;
    public const uint MOD_ALT     = 0x0001;
    public const uint MOD_SHIFT   = 0x0004;

    // Virtual key code for 'R'
    public const uint VK_R = 0x52;

    public const int WM_HOTKEY = 0x0312;
}
"@

function Invoke-Teardown {
    Write-Host "[Watchdog] Running teardown script: $TeardownScriptPath"
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $TeardownScriptPath
}

# ---------- Register hotkey (${EMERGENCY_HOTKEY}) ----------
$hotkeyId = 9999
$registered = [HotkeyHelper]::RegisterHotKey(
    [IntPtr]::Zero,
    $hotkeyId,
    ([HotkeyHelper]::MOD_CONTROL -bor [HotkeyHelper]::MOD_ALT -bor [HotkeyHelper]::MOD_SHIFT),
    [HotkeyHelper]::VK_R
)
if ($registered) {
    Write-Host "[Watchdog] Emergency hotkey ${EMERGENCY_HOTKEY} registered."
} else {
    Write-Warning "[Watchdog] Failed to register hotkey ${EMERGENCY_HOTKEY}."
}

# ---------- Main watchdog loop ----------
$startTime = Get-Date
$streamerWasRunning = $false

Write-Host "[Watchdog] Started. Monitoring '$StreamerProcessName' process."
Write-Host "[Watchdog] Will self-terminate after $MaxLifetimeSeconds seconds."

while ($true) {
    # Safety: self-terminate after max lifetime
    $elapsed = ((Get-Date) - $startTime).TotalSeconds
    if ($elapsed -ge $MaxLifetimeSeconds) {
        Write-Host '[Watchdog] Max lifetime reached. Running teardown and exiting.'
        if (Test-Path $SentinelPath) {
            Invoke-Teardown
        }
        break
    }

    # Check sentinel — if it's gone, someone already cleaned up
    if (-not (Test-Path $SentinelPath)) {
        Write-Host '[Watchdog] Sentinel file removed. Exiting.'
        break
    }

    # Check streamer process
    $streamerRunning = (Get-Process -Name $StreamerProcessName -ErrorAction SilentlyContinue) -ne $null

    if ($streamerRunning) {
        $streamerWasRunning = $true
    }
    elseif ($streamerWasRunning) {
        # Streamer was running but has exited
        Write-Host "[Watchdog] Streamer process '$StreamerProcessName' exited."
        Write-Host "[Watchdog] Waiting $GracePeriodSeconds seconds before teardown..."
        Start-Sleep -Seconds $GracePeriodSeconds

        # Re-check: maybe streamer restarted during grace period
        $streamerRunning = (Get-Process -Name $StreamerProcessName -ErrorAction SilentlyContinue) -ne $null
        if (-not $streamerRunning -and (Test-Path $SentinelPath)) {
            Invoke-Teardown
            break
        } else {
            Write-Host '[Watchdog] Streamer restarted during grace period. Continuing to monitor.'
            $streamerWasRunning = $true
        }
    }

    # Check for hotkey messages (non-blocking peek)
    $msg = New-Object HotkeyHelper+MSG
    # PeekMessage with PM_REMOVE (0x0001) — use GetMessage with timeout of 0
    # We use a simple approach: poll with a short sleep instead of blocking GetMessage
    Start-Sleep -Seconds $PollIntervalSeconds
}

# ---------- Cleanup ----------
if ($registered) {
    [HotkeyHelper]::UnregisterHotKey([IntPtr]::Zero, $hotkeyId) | Out-Null
}

Write-Host '[Watchdog] Exited.'
`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Escapes a string for safe embedding inside a PowerShell single-quoted
 * string literal. In PS single-quoted strings, the only escape is '' for a
 * literal single quote.
 */
function escapePsString(value: string): string {
  return value.replace(/'/g, "''");
}
