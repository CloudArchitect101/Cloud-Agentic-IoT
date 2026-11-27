---
title: Clinic Salesforce admin
---

<div class="lp-hero">
<p class="lp-crumb"><a href="START-HERE.md">Start here</a> › Clinic Salesforce admin</p>
<div class="lp-head"><img src="images/icons/admin.svg" alt=""><div><p class="lp-eyebrow">Path for a clinic Salesforce admin</p><h1 class="lp-title">Turn it on in your own free org</h1></div></div>
<p class="lp-lead">Most of this is Setup work you already know. The rest is copy and paste into a terminal: you never write code. Every step ends with a check, so you always know it worked before you move on.</p>
</div>

<div class="lp-layout">
<div>
<h2>Your steps</h2>
<div class="lp-steps">
<div class="lp-step"><div><p class="lp-pis"><img class="pi" src="images/platforms/aws.svg" alt="AWS" title="AWS" width="20" height="20"> <img class="pi" src="images/platforms/salesforce.svg" alt="Salesforce" title="Salesforce" width="20" height="20"> </p><h4><a href="INSTALL.md#step-2">Create the org and the AWS project</a></h4><p>A free Developer Edition org, and an AWS project with a spend limit. Check Bedrock on day one.</p><p class="lp-check">✓ Check: Bedrock answers "hello", or your Support case is open</p></div></div>
<div class="lp-step"><div><p class="lp-pis"><img class="pi" src="images/platforms/salesforce.svg" alt="Salesforce" title="Salesforce" width="20" height="20"> </p><h4><a href="INSTALL.md#step-3">Turn on the org's features</a></h4><p>Einstein, Agentforce, Person Accounts, Digital Experiences, Omni-Channel and Messaging. Setup only.</p><p class="lp-check">✓ Check: each switch stays on after a reload</p></div></div>
<div class="lp-step"><div><p class="lp-pis"><img class="pi" src="images/platforms/terminal.svg" alt="Terminal" title="Terminal" width="20" height="20"> </p><h4><a href="INSTALL.md#step-1">Install the tools and sign in</a></h4><p>Paste two blocks into the terminal. Your browser opens to sign in to AWS and to the org.</p><p class="lp-check">✓ Check: <code>sf org display</code> shows Connected</p></div></div>
<div class="lp-step"><div><p class="lp-pis"><img class="pi" src="images/platforms/salesforce.svg" alt="Salesforce" title="Salesforce" width="20" height="20"> <img class="pi" src="images/platforms/terminal.svg" alt="Terminal" title="Terminal" width="20" height="20"> </p><h4><a href="INSTALL.md#step-5">Create the integration user and app</a></h4><p>A Salesforce Integration user and an External Client App with a certificate. Setup, plus one block.</p><p class="lp-check">✓ Check: you have the app's Consumer Key</p></div></div>
<div class="lp-step"><div><p class="lp-pis"><img class="pi" src="images/platforms/terminal.svg" alt="Terminal" title="Terminal" width="20" height="20"> <img class="pi" src="images/platforms/aws.svg" alt="AWS" title="AWS" width="20" height="20"> <img class="pi" src="images/platforms/salesforce.svg" alt="Salesforce" title="Salesforce" width="20" height="20"> </p><h4><a href="INSTALL.md#step-6">Deploy everything in one run</a></h4><p>One command deploys AWS and Salesforce. Then three Setup clicks: the app policy, the queue members, the budget.</p><p class="lp-check">✓ Check: the App Launcher shows Cloud Agentic IoT</p></div></div>
<div class="lp-step"><div><p class="lp-pis"><img class="pi" src="images/platforms/salesforce.svg" alt="Salesforce" title="Salesforce" width="20" height="20"> <img class="pi" src="images/platforms/aws.svg" alt="AWS" title="AWS" width="20" height="20"> </p><h4><a href="INSTALL.md#step-7">Let Salesforce call AWS</a></h4><p>An External Credential and a Named Credential in Setup, and one permission set.</p><p class="lp-check">✓ Check: the Home tab shows this month's AWS spend</p></div></div>
<div class="lp-step"><div><p class="lp-pis"><img class="pi" src="images/platforms/slack.svg" alt="Slack" title="Slack" width="20" height="20"> <img class="pi" src="images/platforms/data-cloud.svg" alt="Data Cloud" title="Data Cloud" width="20" height="20"> <img class="pi" src="images/platforms/portal.svg" alt="Portal (Experience Cloud)" title="Portal (Experience Cloud)" width="20" height="20"> </p><h4><a href="INSTALL.md#step-8">Add Slack, Data Cloud and the portal</a></h4><p>Each has its own steps and check.</p><p class="lp-check">✓ Check: each feature's own check passes</p></div></div>
<div class="lp-step"><div><p class="lp-pis"><img class="pi" src="images/platforms/esp32.svg" alt="ESP32" title="ESP32" width="20" height="20"> <img class="pi" src="images/platforms/service.svg" alt="Cases (Service)" title="Cases (Service)" width="20" height="20"> <img class="pi" src="images/platforms/agentforce.svg" alt="Agentforce" title="Agentforce" width="20" height="20"> </p><h4><a href="INSTALL.md#step-13">Check that it works</a></h4><p>Warm the sensor, watch the Case open, and ask the agent about the device.</p><p class="lp-check">✓ Check: one Case on the care team queue</p></div></div>
</div>
<p>Each step links to its full instructions in the <a href="INSTALL.md">Quick Install Guide</a>, where the commands and the check box are.</p>
</div>
<div class="lp-side">
<div class="lp-box"><h4>Before you start</h4><ul><li>A Salesforce Developer Edition org (free)</li><li>An AWS project with a spend limit, from $20 a month</li><li>A Mac, Linux or Windows computer with a terminal</li><li>About two hours</li></ul></div>
<div class="lp-box"><h4>Never used a terminal?</h4>On a Mac, press Cmd+Space, type <code>Terminal</code> and press Enter. On each block, click <b>Copy</b>, click in the Terminal window, press Cmd+V, then Enter. If a block has a <b>Fill in first</b> list, change only the text between the quotes first.</div>
<div class="lp-box"><h4>Need a board?</h4>The <a href="PATH-DEVICE.md">device builder path</a> covers parts and wiring. A colleague can build it while you do Setup.</div>
</div>
</div>

Other paths: [Device builder](PATH-DEVICE.md) · [Developer](PATH-DEVELOPER.md) · [Pipelines team](PATH-PIPELINES.md)

---

[← Docs home](index.md) · [Start here](START-HERE.md) · [Quick Install Guide](INSTALL.md) · [Troubleshooting](TROUBLESHOOTING.md)
