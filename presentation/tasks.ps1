# ─────────────────────────────────────────────────────────────────────────────
# Presentation task shortcuts (PowerShell)
#
# Load ONCE per terminal session from the project root:
#     . .\presentation\tasks.ps1
#
# Then run any task directly:
#     task_1   task_2   task_3   task_4   task_5
#     task_all          # run every task back-to-back
#     task_serve        # start the API server in a separate window (optional)
#     task_stop         # stop the server / throwaway mongod
#     task_menu         # show this list again
#
# Each task command runs its BEFORE → AFTER → RESULTS scripts and prints which
# doc + code file to open for the committee. The server (and, for Task 3, a
# MongoDB replica set) is started automatically if needed and stopped afterwards.
# ─────────────────────────────────────────────────────────────────────────────

$script:PresDir  = $PSScriptRoot
$script:PresRoot = Split-Path -Parent $PSScriptRoot
$script:PresRunner = Join-Path $PSScriptRoot 'run-task.js'

function Invoke-PresTask {
    param([string]$Task)
    Push-Location $script:PresRoot
    try { node $script:PresRunner $Task }
    finally { Pop-Location }
}

function task_1   { Invoke-PresTask 1 }
function task_2   { Invoke-PresTask 2 }
function task_3   { Invoke-PresTask 3 }
function task_4   { Invoke-PresTask 4 }
function task_5   { Invoke-PresTask 5 }
function task_all { Invoke-PresTask 'all' }

# Optional: start the API server in its own window so the committee can see logs.
# Tasks reuse it automatically when it is running.
function task_serve {
    $env:NODE_ENV = 'development'
    Write-Host 'Starting API server (development mode) in a new window...' -ForegroundColor Cyan
    $global:PresServer = Start-Process -FilePath 'node' -ArgumentList 'server.js' `
        -WorkingDirectory $script:PresRoot -PassThru
    Write-Host ("API server PID: {0}  (port 8000). Stop it later with: task_stop" -f $global:PresServer.Id) -ForegroundColor Green
}

# Stop the API server (:8000) and any throwaway replica set (:27018) we started.
function task_stop {
    foreach ($port in 8000, 27018) {
        $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
        if ($conns) {
            $conns | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object {
                Write-Host ("Stopping PID {0} on port {1}..." -f $_, $port) -ForegroundColor Yellow
                taskkill /PID $_ /T /F | Out-Null
            }
        } else {
            Write-Host ("Nothing listening on port {0}." -f $port) -ForegroundColor DarkGray
        }
    }
}

function task_menu {
    Write-Host ''
    Write-Host '  Presentation tasks' -ForegroundColor Cyan
    Write-Host '  ------------------'
    Write-Host '  task_1    Distributed Caching with Redis (Cache-Aside)'
    Write-Host '  task_2    Concurrency Control for Inventory (no overselling)'
    Write-Host '  task_3    Transaction Integrity (ACID checkout)'
    Write-Host '  task_4    Stress Testing (stability under load)'
    Write-Host '  task_5    Benchmarking & Bottleneck Fix (atomic write path)'
    Write-Host '  task_all  Run every task back-to-back'
    Write-Host ''
    Write-Host '  task_serve  Start the API server in a separate window (optional)'
    Write-Host '  task_stop   Stop the server / throwaway mongod'
    Write-Host ''
}

task_menu
Write-Host 'Tasks loaded. Type a command above (e.g. task_1).' -ForegroundColor Green
