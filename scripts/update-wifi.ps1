# Updates ONLY the Wi-Fi credentials on a provisioned ESP32. (Windows)
#
# Usage: .\scripts\update-wifi.ps1 -Ssid "MyNetwork" -Passphrase "secret" -Port COM5
#
# Writes the "wifi" NVS namespace only. The "identity" namespace - Thing name,
# endpoint, certificate, private key - is untouched.
#
# Do NOT use esptool erase_flash for this: it wipes NVS entirely and destroys a
# private key AWS issues exactly once. If that already happened, use the
# Re-provision button on the Asset in Salesforce, which rotates the certificate
# and preserves all device history.
param(
    [Parameter(Mandatory=$true)][string]$Ssid,
    [Parameter(Mandatory=$true)][string]$Passphrase,
    [Parameter(Mandatory=$true)][string]$Port
)

$payload = @{ ssid = $Ssid; passphrase = $Passphrase } | ConvertTo-Json -Compress

Write-Host "Port: $Port"
Write-Host "SSID: $Ssid"

$sp = New-Object System.IO.Ports.SerialPort $Port, 115200, None, 8, One
$sp.Open()
$sp.WriteLine($payload)
Start-Sleep -Seconds 1
$sp.Close()

Write-Host "Sent. The device stores it alongside any existing networks."
Write-Host "Certificate and Thing name are untouched."
