# Security policy

## Reporting a vulnerability

Please do not report security problems in public issues, discussions or pull
requests.

Report them privately through GitHub:
[**Report a vulnerability**](../../security/advisories/new) (Security tab,
"Report a vulnerability"). Only the maintainer sees the report.

Include what you found, where (file, workflow, endpoint or metadata), how to
reproduce it, and what an attacker could do with it.

You can expect an acknowledgement within 5 business days, and an update on the
fix plan after the maintainer has confirmed the problem.

## Scope

In scope: the code and configuration in this repository, including the GitHub
Actions workflows, the CloudFormation templates and IAM policies, the Lambda
functions, the Salesforce metadata and Apex, the patient portal, and the ESP32
firmware and OTA process.

Out of scope: problems in AWS, Salesforce, GitHub or other vendors' services
themselves (report those to the vendor), and deployments other people run from
this code.

## How the project protects its credentials

- Pull request checks run without any secrets. Workflows that use AWS or
  Salesforce credentials run only on pushes to `Dev` and `Prod` or when the
  maintainer starts them by hand, never on a pull request.
- AWS access from GitHub uses short-lived OIDC credentials; no AWS keys are
  stored in the repository or in GitHub.
- The `Prod` deploy waits for the maintainer's approval.
- `test/config/contribution-safety.test.js` fails the checks if a workflow
  change would expose secrets to pull requests.

If you ever find a secret, key or account identifier committed in this
repository, report it privately as above.
