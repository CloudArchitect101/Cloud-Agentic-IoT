---
title: Developer
---

<div class="lp-hero">
<p class="lp-crumb"><a href="START-HERE.md">Start here</a> › Developer</p>
<div class="lp-head"><img src="images/icons/developer.svg" alt=""><div><p class="lp-eyebrow">Path for a developer</p><h1 class="lp-title">Run it from your laptop, then read the code</h1></div></div>
<p class="lp-lead">Your own AWS project and a free org, deployed in one run by <code>scripts/install.sh</code>. Then each part of the code, with the tests that keep it honest.</p>
</div>

<div class="lp-layout">
<div>
<h2>Your steps</h2>
<div class="lp-steps">
<div class="lp-step"><div><h4><a href="INSTALL.md#step-1">Install the tools</a></h4><p>Node 22, the Salesforce CLI, the AWS CLI and jq. arduino-cli for boards.</p><p class="lp-check">✓ Check: each tool prints its version</p></div></div>
<div class="lp-step"><div><h4><a href="INSTALL.md#step-2">Accounts, features, sign in</a></h4><p>An AWS project with a spend limit, a Developer Edition org, its features on, both CLIs signed in.</p><p class="lp-check">✓ Check: <code>aws sts get-caller-identity</code> prints your account</p></div></div>
<div class="lp-step"><div><h4><a href="INSTALL.md#step-5">Make what the deploy reads</a></h4><p>The integration certificate, user and External Client App.</p><p class="lp-check">✓ Check: both key files exist in <code>scripts/</code></p></div></div>
<div class="lp-step"><div><h4><a href="INSTALL.md#step-6">Deploy everything</a></h4><p><code>scripts/install.sh Dev</code> runs the tests, deploys AWS and Salesforce, and publishes the agent.</p><p class="lp-check">✓ Check: it prints the values for the next steps</p></div></div>
<div class="lp-step"><div><h4><a href="INSTALL.md#step-7">Connect and add a board</a></h4><p>The named credential, then a board over USB.</p><p class="lp-check">✓ Check: the Asset shows Online</p></div></div>
<div class="lp-step"><div><h4><a href="CHAPTERS.md">Read the code</a></h4><p>Fourteen chapters, each a capability with its code and its tests. <code>scripts/check.sh</code> runs them all.</p><p class="lp-check">✓ Check: <code>scripts/check.sh</code> passes</p></div></div>
</div>
<p>Each step links to its full instructions in the <a href="INSTALL.md">Quick install</a>, where the commands and the check box are.</p>
</div>
<div class="lp-side">
<div class="lp-box"><h4>Where things live</h4><ul><li><code>firmware/</code>: the ESP32 sketch</li><li><code>lambda/</code> and <code>infra/</code>: AWS</li><li><code>force-app/</code>: Salesforce and the agents</li><li><code>scripts/</code>: install, deploy, OTA</li></ul></div>
<div class="lp-box"><h4>Understand the design</h4><a href="HOW-IT-CONNECTS.md">How it connects</a>, <a href="ARCHITECTURE-OVERVIEW.md">Architecture overview</a> and the <a href="PLATFORM-PRIMER.md">Platform primer</a> for Apex and SOQL through Python.</div>
<div class="lp-box"><h4>Cost</h4>About $0.08 of AWS per device a month. See the <a href="COST-MODEL.md">Cost model</a>.</div>
</div>
</div>

Other paths: [Clinic Salesforce admin](PATH-ADMIN.md) · [Device builder](PATH-DEVICE.md) · [Pipelines team](PATH-PIPELINES.md)

---

[← Docs home](index.md) · [Start here](START-HERE.md) · [Quick install](INSTALL.md) · [Troubleshooting](TROUBLESHOOTING.md)
