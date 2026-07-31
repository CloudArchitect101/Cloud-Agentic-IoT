# setup-device.ps1 - first-time setup for one ESP32, start to finish. (Windows)
#
# Usage: .\scripts\setup-device.ps1
#        .\scripts\setup-device.ps1 -CertDir C:\Users\me\Downloads -Port COM5
#
# Asks, line by line, for the WiFi network and the files you downloaded from
# AWS IoT Core. Then it compiles the firmware, flashes it over USB, and sends
# the credentials to the device, which stores them in NVS flash.
#
# Why flashing comes first: a blank ESP32 has no WiFi stack, no TLS, and no
# idea that AWS exists. Its ROM bootloader speaks serial and nothing else, so
# it cannot fetch its own firmware. OTA only works once our firmware is already
# running - see docs/DEVICE-IDENTITY.md.
param(
    [string]$CertDir = "",
    [string]$Port    = ""
)

$ErrorActionPreference = "Stop"

$Fqbn      = "esp32:esp32:esp32doit-devkit-v1"
$Repo      = Split-Path -Parent $PSScriptRoot
$DeviceCpp = Join-Path $Repo "firmware\libraries\CloudAgenticDevice\src\CloudAgenticDevice.cpp"

# The bundle holds a private key, so it goes to a temp file that is deleted in
# the finally block no matter how this script ends.
$Bundle = [System.IO.Path]::GetTempFileName()

function Write-Step($text) { Write-Host "`n$text" -ForegroundColor White }
function Ask($prompt, $default = "") {
    if ($default) {
        $reply = Read-Host "  $prompt [$default]"
        if ([string]::IsNullOrWhiteSpace($reply)) { return $default }
        return $reply
    }
    do { $reply = Read-Host "  $prompt" } while ([string]::IsNullOrWhiteSpace($reply))
    return $reply
}

try {
    # ------------------------------------------------------------ 1. the files
    Write-Step "Step 1 of 5 - the files you downloaded from AWS IoT Core"
    Write-Host "Put the certificate, the private key, and Amazon Root CA 1 in one folder."

    if (-not $CertDir) { $CertDir = Ask "Folder holding those files" "$HOME\Downloads" }
    if (-not (Test-Path $CertDir)) { throw "No such folder: $CertDir" }

    Write-Host ""
    Write-Host "Files in ${CertDir}:"
    Get-ChildItem -File $CertDir | ForEach-Object { Write-Host "    $($_.Name)" }
    Write-Host ""

    # AWS uses predictable download names, so offer them as defaults.
    function Guess($pattern) {
        $hit = Get-ChildItem -File $CertDir | Where-Object { $_.Name -match $pattern } | Select-Object -First 1
        if ($hit) { return $hit.Name } else { return "" }
    }

    $CertFile = Ask "Certificate file"    (Guess 'certificate\.pem\.crt$|\.crt$')
    $KeyFile  = Ask "Private key file"    (Guess 'private\.pem\.key$|\.key$')
    $CaFile   = Ask "Amazon Root CA file" (Guess 'AmazonRootCA1?\.pem$|root.*ca.*\.pem$')

    $CertPath = Join-Path $CertDir $CertFile
    $KeyPath  = Join-Path $CertDir $KeyFile
    $CaPath   = Join-Path $CertDir $CaFile
    foreach ($p in @($CertPath, $KeyPath, $CaPath)) {
        if (-not (Test-Path $p)) { throw "Not found: $p" }
    }

    # Catch the classic mix-up - cert and key swapped - before it turns into an
    # opaque TLS handshake failure hours later.
    $certText = Get-Content $CertPath -Raw
    $keyText  = Get-Content $KeyPath  -Raw
    $caText   = Get-Content $CaPath   -Raw
    if ($certText -notmatch "BEGIN CERTIFICATE") { throw "$CertFile is not a certificate." }
    if ($keyText  -notmatch "PRIVATE KEY")       { throw "$KeyFile is not a private key." }
    if ($caText   -notmatch "BEGIN CERTIFICATE") { throw "$CaFile is not a certificate." }

    # --------------------------------------------------------- 2. the identity
    Write-Step "Step 2 of 5 - which Thing is this?"
    $ThingName = Ask "Thing name (exactly as in AWS IoT Core)"

    # The endpoint is per account and region, identical for every device in it.
    $EndpointGuess = ""
    if (Get-Command aws -ErrorAction SilentlyContinue) {
        $EndpointGuess = (aws iot describe-endpoint --endpoint-type iot:Data-ATS `
                            --query endpointAddress --output text 2>$null)
        if ($EndpointGuess -eq "None") { $EndpointGuess = "" }
    }
    $Endpoint = Ask "AWS IoT data endpoint" $EndpointGuess

    # ------------------------------------------------------------- 3. the wifi
    Write-Step "Step 3 of 5 - the WiFi network"
    Write-Host "This is the only part you can change later without a rebuild:"
    Write-Host "scripts\update-wifi.ps1 replaces it, and NVS remembers up to 3 networks."
    Write-Host ""

    $WifiSsid   = Ask "WiFi SSID"
    $securePass = Read-Host "  WiFi passphrase (hidden)" -AsSecureString
    $WifiPass   = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto(
                    [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePass))

    # --------------------------------------------------------- 4. the firmware
    Write-Step "Step 4 of 5 - build and flash"

    $sketches = Get-ChildItem -Directory (Join-Path $Repo "firmware") |
                Where-Object { $_.Name -ne "libraries" } | Sort-Object Name
    if (-not $sketches) { throw "No sketches found under firmware\" }

    Write-Host "Device types available:"
    $sketches | ForEach-Object { Write-Host "    $($_.Name)" }
    $Sketch = Ask "Which one is this device" $sketches[0].Name
    $SketchPath = Join-Path $Repo "firmware\$Sketch"
    if (-not (Test-Path $SketchPath)) { throw "No sketch named '$Sketch'." }

    if (-not $Port) {
        $portGuess = [System.IO.Ports.SerialPort]::GetPortNames() | Select-Object -First 1
        $Port = Ask "Serial port" $portGuess
    }

    # The Root CA is the one credential that IS compiled in: the same public
    # certificate for every device in every AWS account, so it is not a secret.
    $cppText = Get-Content $DeviceCpp -Raw
    if ($cppText -match "PASTE AMAZON ROOT CA 1 HERE") {
        Write-Host "  Root CA placeholder found in firmware - filling it in from $CaFile"

        # Anchor on both raw-string delimiters so a bad match cannot silently
        # eat surrounding code, then verify before writing anything back.
        $ca      = $caText.Trim()
        $pattern = '(?s)(R"EOF_CA\().*?(\)EOF_CA")'
        $patched = [regex]::Replace($cppText, $pattern, { param($m)
            $m.Groups[1].Value + "`n" + $ca + "`n" + $m.Groups[2].Value
        }, 1)

        if ($patched -match "PASTE AMAZON ROOT CA 1 HERE") { throw "Root CA substitution failed." }
        if (([regex]::Matches($patched, [regex]::Escape('R"EOF_CA('))).Count -ne 1 -or
            ([regex]::Matches($patched, [regex]::Escape(')EOF_CA"'))).Count -ne 1) {
            throw "Raw string delimiters were damaged - aborting."
        }
        Set-Content -Path $DeviceCpp -Value $patched -NoNewline
        Write-Host "  Root CA written into CloudAgenticDevice.cpp"
    }

    if (Get-Command arduino-cli -ErrorAction SilentlyContinue) {
        Write-Host "  Compiling $Sketch..."
        arduino-cli compile --fqbn $Fqbn --libraries (Join-Path $Repo "firmware\libraries") $SketchPath
        if ($LASTEXITCODE -ne 0) { throw "Compile failed." }
        Write-Host "  Flashing over USB..."
        arduino-cli upload -p $Port --fqbn $Fqbn $SketchPath
        if ($LASTEXITCODE -ne 0) { throw "Upload failed." }
    } else {
        Write-Warning "arduino-cli not found - skipping build and flash."
        Write-Warning "The firmware must already be running, or the next step has"
        Write-Warning "nothing listening on the serial port. See firmware\README.md."
    }

    # ------------------------------------------------------ 5. the credentials
    Write-Step "Step 5 of 5 - sending credentials to the device"

    # Built as an ordered hashtable rather than string concatenation so the PEM
    # newlines become proper \n escapes instead of breaking the JSON.
    $payload = [ordered]@{
        ssid           = $WifiSsid
        passphrase     = $WifiPass
        thingName      = $ThingName
        endpoint       = $Endpoint
        certificatePem = $certText
        privateKey     = $keyText
    } | ConvertTo-Json -Compress -Depth 10

    Set-Content -Path $Bundle -Value $payload -NoNewline

    # Opening the port toggles DTR, which resets the ESP32 - so wait for it to
    # boot into provisioning mode before writing, otherwise the bundle arrives
    # while the bootloader is still running and is lost.
    $sp = New-Object System.IO.Ports.SerialPort $Port, 115200, None, 8, One
    $sp.ReadTimeout = 1000
    $sp.Open()
    Write-Host "  Waiting for the device to boot..."
    Start-Sleep -Seconds 4

    $sp.WriteLine($payload)

    Write-Host "  Sent. Device says:"
    Write-Host "  ----------------------------------------------------------------"
    $deadline = (Get-Date).AddSeconds(8)
    while ((Get-Date) -lt $deadline) {
        try { $line = $sp.ReadLine(); if ($line) { Write-Host "  $line" } }
        catch [TimeoutException] { }
    }
    $sp.Close()
    Write-Host "  ----------------------------------------------------------------"

    Write-Step "Done"
    Write-Host @"
The device stored its identity in NVS and rebooted. It should now connect to
WiFi and to AWS IoT on its own - watch it with:

    arduino-cli monitor -p $Port -c baudrate=115200

The credentials bundle was a temp file and has been deleted. The downloaded
private key in $CertDir is still on disk, and AWS issues it exactly once -
keep it somewhere safe or delete it, but do not leave it in Downloads.

Do this next: add your phone hotspot as the second network.

    .\scripts\update-wifi.ps1 "<hotspot-SSID>" "<hotspot-passphrase>"

NVS has 3 slots and only the third one ever rotates, so the first two are
permanent anchors. The network you just provisioned took slot 0; a hotspot in
slot 1 means the device can reach AWS from almost anywhere, which is what lets
the third slot be updated remotely later - no USB, no rebuild.

From here on, firmware updates are over the air too: NVS is a separate
partition, so WiFi and certificate survive every update.
"@
}
finally {
    if (Test-Path $Bundle) { Remove-Item $Bundle -Force }
}
