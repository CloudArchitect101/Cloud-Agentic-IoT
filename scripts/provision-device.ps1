# Sends a provisioning bundle to an ESP32 in provisioning mode. (Windows)
#
# Usage: .\scripts\provision-device.ps1 -Bundle .\bundle.json -Port COM5
#
# Deliberately does not erase flash: that would wipe the NVS partition holding
# the device identity we want to survive firmware updates.
param(
    [Parameter(Mandatory=$true)][string]$Bundle,
    [Parameter(Mandatory=$true)][string]$Port
)

if (-not (Test-Path $Bundle)) { throw "Bundle not found: $Bundle" }

$json    = Get-Content $Bundle -Raw | ConvertFrom-Json
$payload = $json | ConvertTo-Json -Compress -Depth 10

Write-Host "Port:  $Port"
Write-Host "Thing: $($json.thingName)"
Write-Host "Sending bundle..."

$sp = New-Object System.IO.Ports.SerialPort $Port, 115200, None, 8, One
$sp.Open()
$sp.WriteLine($payload)
Start-Sleep -Seconds 2
$sp.Close()

Write-Host "Sent. The device stores it in NVS and reboots."
Write-Host ""
Write-Host "Delete the bundle now - it contains the device private key:"
Write-Host "  Remove-Item $Bundle"
