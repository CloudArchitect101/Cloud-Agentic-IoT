---
title: Device builder
---

<div class="lp-hero">
<p class="lp-crumb"><a href="START-HERE.md">Start here</a> › Device builder</p>
<div class="lp-head"><img src="images/icons/hardware.svg" alt=""><div><p class="lp-eyebrow">Path for a device builder</p><h1 class="lp-title">Build and connect your own monitored device</h1></div></div>
<p class="lp-lead">You'll wire an ESP32 to a temperature sensor and an alert motor, flash it once over USB, and give it its own certificate. Every update after that goes over the air.</p>
</div>

<div class="lp-layout">
<div>
<h2>Your steps</h2>
<div class="lp-steps">
<div class="lp-step"><div><h4><a href="INSTALL-GUIDE.md#what-you-need">Get the parts</a></h4><p>ESP32 (38-pin), DHT11, SG90 servo, a 10 kΩ resistor, jumper wires and a data USB cable.</p><p class="lp-check">✓ Check: plugged in, the board appears as a new port in <code>ls /dev/cu.*</code></p></div></div>
<div class="lp-step"><div><h4><a href="INSTALL.md#step-12">Wire it</a></h4><p>Sensor to 3.3V, P4 and GND with the resistor across legs 1 and 2. Motor to 5V, P5 and GND.</p><p class="lp-check">✓ Check: your six wires match the diagram</p></div></div>
<div class="lp-step"><div><h4><a href="INSTALL.md#step-12">Register the device</a></h4><p>In the app, create a Wi-Fi Network, then an Asset with the board's name as its Serial Number.</p><p class="lp-check">✓ Check: the Asset turns Provisioned with a bundle link</p></div></div>
<div class="lp-step"><div><h4><a href="INSTALL.md#step-12">Flash and provision</a></h4><p>One copy-paste block writes the certificate and Wi-Fi to the board over USB, then deletes the bundle.</p><p class="lp-check">✓ Check: within a minute or two the Asset shows Online</p></div></div>
<div class="lp-step"><div><h4><a href="INSTALL.md#step-13">Test the alert</a></h4><p>Warm the sensor to 30 C, for example under your arm. The motor turns at once, even offline.</p><p class="lp-check">✓ Check: one Case opens on the care team queue</p></div></div>
<div class="lp-step"><div><h4><a href="../hardware/cases/README.md">Print a case</a></h4><p>A wearable sensor pod and arm hub, or a desk gauge with a bell. OpenSCAD sources and STLs.</p><p class="lp-check">✓ Check: the sensor grille faces the surface you measure</p></div></div>
</div>
<p>Each step links to its full instructions in the <a href="INSTALL.md">Quick install</a>, where the commands and the check box are.</p>
</div>
<div class="lp-side">
<img src="images/wiring-monitored-device.png" alt="Wiring for the monitored device: DHT11 leg 1 to 3.3V, leg 2 to P4, leg 4 to GND with a 10 kΩ resistor across legs 1 and 2; servo orange to P5, red to 5V, brown to GND">
<div class="lp-box"><h4>Before you start</h4><ul><li>Quick install steps 1 to 7 are done, so the app can provision the board</li><li>About $37 CAD of parts</li><li>No soldering except the resistor</li></ul></div>
<div class="lp-box"><h4>Going further</h4><a href="DEVICE-IDENTITY.md">Device identity</a>: certificates and Wi-Fi that survive updates. <a href="../firmware/README.md">Firmware</a>: live mode, commands and OTA.</div>
<div class="lp-box"><h4>Stuck?</h4>Board problems and their fixes are in <a href="TROUBLESHOOTING.md#the-board-and-the-serial-scripts">Troubleshooting: the board</a>.</div>
</div>
</div>

Other paths: [Clinic Salesforce admin](PATH-ADMIN.md) · [Developer](PATH-DEVELOPER.md) · [Pipelines team](PATH-PIPELINES.md)

---

[← Docs home](index.md) · [Start here](START-HERE.md) · [Quick install](INSTALL.md) · [Troubleshooting](TROUBLESHOOTING.md)
