---
title: Pipelines team
---

<div class="lp-hero">
<p class="lp-crumb"><a href="START-HERE.md">Start here</a> › Pipelines team</p>
<div class="lp-head"><img src="images/icons/pipelines.svg" alt=""><div><p class="lp-eyebrow">Path for a pipelines team</p><h1 class="lp-title">Deploy Dev and Prod with GitHub Actions</h1></div></div>
<p class="lp-lead">Two environments, each with its own branch, AWS account and Salesforce org. A push to Dev deploys Dev; a pull request into Prod deploys Prod after you approve the run.</p>
</div>

<div class="lp-layout">
<div>
<h2>Your steps</h2>
<div class="lp-steps">
<div class="lp-step"><div><p class="lp-pis"><img class="pi" src="images/platforms/salesforce.svg" alt="Salesforce" title="Salesforce" width="20" height="20"> <img class="pi" src="images/platforms/aws.svg" alt="AWS" title="AWS" width="20" height="20"> </p><h4><a href="INSTALL.md#step-13">Get it working once by hand</a></h4><p>Quick Install Guide steps 1 to 13 against one org, so you know every part works.</p><p class="lp-check">✓ Check: Quick Install Guide step 13 passes</p></div></div>
<div class="lp-step"><div><p class="lp-pis"><img class="pi" src="images/platforms/aws.svg" alt="AWS" title="AWS" width="20" height="20"> </p><h4><a href="INSTALL.md#step-14">An AWS account per environment</a></h4><p>A regular account (not a project), MFA on root, and an operator user.</p><p class="lp-check">✓ Check: the Bedrock check passes in each account</p></div></div>
<div class="lp-step"><div><p class="lp-pis"><img class="pi" src="images/platforms/aws.svg" alt="AWS" title="AWS" width="20" height="20"> <img class="pi" src="images/platforms/git.svg" alt="Git and GitHub" title="Git and GitHub" width="20" height="20"> </p><h4><a href="INSTALL.md#step-14">Deploy role and budget</a></h4><p><code>scripts/bootstrap-aws.sh</code> makes the OIDC provider, the deploy role and the budget.</p><p class="lp-check">✓ Check: <code>AWS_ROLE_ARN</code> is stored</p></div></div>
<div class="lp-step"><div><p class="lp-pis"><img class="pi" src="images/platforms/salesforce.svg" alt="Salesforce" title="Salesforce" width="20" height="20"> </p><h4><a href="INSTALL.md#step-14">Org service users</a></h4><p>A deploy user and an integration user, each with its own External Client App.</p><p class="lp-check">✓ Check: both Consumer Keys are copied</p></div></div>
<div class="lp-step"><div><p class="lp-pis"><img class="pi" src="images/platforms/git.svg" alt="Git and GitHub" title="Git and GitHub" width="20" height="20"> </p><h4><a href="CI-CD-SECRETS.md">GitHub secrets and variables</a></h4><p><code>scripts/setup-github-secrets.sh</code> asks for each value and hides secrets.</p><p class="lp-check">✓ Check: the environment lists every secret</p></div></div>
<div class="lp-step"><div><p class="lp-pis"><img class="pi" src="images/platforms/git.svg" alt="Git and GitHub" title="Git and GitHub" width="20" height="20"> <img class="pi" src="images/platforms/aws.svg" alt="AWS" title="AWS" width="20" height="20"> </p><h4><a href="DEVELOPMENT.md">First run, then Prod</a></h4><p>Run the Deploy workflow on Dev. When it's green, create Prod and repeat.</p><p class="lp-check">✓ Check: both runs are green</p></div></div>
</div>
<p>Each step links to its full instructions in the <a href="INSTALL.md">Quick Install Guide</a>, where the commands and the check box are.</p>
</div>
<div class="lp-side">
<div class="lp-box"><h4>Before you start</h4><ul><li>Two regular AWS accounts</li><li>Two Salesforce orgs</li><li>Admin on the GitHub repository</li><li>About a day</li></ul></div>
<div class="lp-box"><h4>Cutover</h4>The <a href="MIGRATION-RUNBOOK.md">Migration runbook</a> moves to Prod in phases, each with a rollback.</div>
<div class="lp-box"><h4>Why some steps stay manual</h4>Licences, terms and credentials only an admin may handle. See <a href="DEVELOPMENT.md#what-stays-manual-and-why">Development</a>.</div>
</div>
</div>

Other paths: [Clinic Salesforce admin](PATH-ADMIN.md) · [Device builder](PATH-DEVICE.md) · [Developer](PATH-DEVELOPER.md)

---

[← Docs home](index.md) · [Start here](START-HERE.md) · [Quick Install Guide](INSTALL.md) · [Troubleshooting](TROUBLESHOOTING.md)
