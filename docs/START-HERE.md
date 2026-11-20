---
title: Start here
---

<div class="lp-hero">
<p class="lp-eyebrow">Cloud-Agentic-IoT</p>
<h1 class="lp-title">Start here</h1>
<p class="lp-lead">Pick the card that sounds like you. Each path lists your steps, a check after each one, and where to look when something fails. Every page links back here.</p>
</div>

<div class="lp-cards">
<div class="lp-card"><img src="images/icons/admin.svg" alt=""><h3>Clinic Salesforce admin</h3><p>Turn it on in a free org: Setup clicks you know, copy-paste for the rest, and a check after every step.</p><a class="lp-go" href="PATH-ADMIN.md">Admin path →</a><p class="lp-meta">About 2 hours · no code to write</p></div>
<div class="lp-card"><img src="images/icons/hardware.svg" alt=""><h3>Device builder</h3><p>Parts, wiring, firmware, the device's own certificate, and printable cases for your own board.</p><a class="lp-go" href="PATH-DEVICE.md">Device path →</a><p class="lp-meta">About 20 minutes per board</p></div>
<div class="lp-card"><img src="images/icons/developer.svg" alt=""><h3>Developer</h3><p>Deploy AWS and Salesforce in one run from your laptop, then read the code behind each part.</p><a class="lp-go" href="PATH-DEVELOPER.md">Developer path →</a><p class="lp-meta">About 2 hours</p></div>
<div class="lp-card"><img src="images/icons/pipelines.svg" alt=""><h3>Pipelines team</h3><p>Separate Dev and Prod accounts and orgs, deployed by GitHub Actions with an approval for Prod.</p><a class="lp-go" href="PATH-PIPELINES.md">Pipelines path →</a><p class="lp-meta">About a day</p></div>
</div>

Only want to see what it does first? Watch the [step-by-step walkthrough](process/) (no install), then read [How it connects](HOW-IT-CONNECTS.md).

## The install at a glance

The [Quick install](INSTALL.md) is the one path everyone follows. The other install pages explain it, they do not replace it:

| Page | Use it for |
|---|---|
| [Quick install](INSTALL.md) | The steps, in order, with a check after each one |
| [Install guide](INSTALL-GUIDE.md) | Why each step is done that way, and what to look at when one fails |
| [Try it](TRY-IT.md) | The demos to run once it works: warm the sensor, the saga, Slack |
| [Setup](SETUP.md) | Accounts, licences and secrets in detail, for the Dev and Prod pipelines |
| [Troubleshooting](TROUBLESHOOTING.md) | Every problem met so far, with its cause and fix |

## What success looks like

The app's Home tab after step 7 (sample data):

![The Home tab's cost and limits card: AWS spend this month against the budget, and the org's most used limits](images/home-cost-card-preview.png)

The board after step 12: an ESP32 with a DHT11 temperature sensor and an SG90 servo. The servo turns while the temperature is at or above 30 C.

![Monitored device wiring, drawn from the real parts: the ESP32 held with its printed pin names facing you (USB down, 3.3V top right). DHT11 leg 1 to 3.3V (red), leg 2 to P4 (yellow), leg 4 to GND (black), 10 kΩ resistor soldered across legs 1 and 2. Servo orange to P5, red to 5V, brown to GND through 3 male-to-female jumpers](images/wiring-monitored-device.svg)

The Business Value card in Data Cloud after step 9 (sample data) is in [Business value](BUSINESS-VALUE.md).

---

[Docs home](index.md) · [Quick install →](INSTALL.md)
