# Contributing

Thanks for looking at Cloud-Agentic-IoT. Issues and pull requests are welcome.

## How this project was built

This project was written with AI coding assistants. Every change was reviewed,
tested and deployed by the maintainer, [@CloudArchitect101](https://github.com/CloudArchitect101),
who checks the code, the security model and the architecture before anything
merges. Contributions go through the same review: nothing reaches `Dev` or
`Prod` without the maintainer's approval and green checks.

You are welcome to use AI tools for your contribution too. You are responsible
for what you submit: read it, run the checks, and be ready to explain it.

## Ways to contribute

- **Report a bug** or **suggest an improvement**: open an
  [issue](../../issues/new/choose) with one of the templates.
- **Fix something**: comment on the issue first for anything larger than a
  typo, so we agree on the approach before you spend time on it.
- **Security problems**: do not open a public issue. Follow
  [SECURITY.md](SECURITY.md).

## Sending a pull request

1. Fork the repository and branch from `Dev`, the default branch. `Prod` only
   takes pull requests from `Dev`.
2. Make your change. Keep one goal per pull request.
3. Run the checks on your laptop. They need no AWS account, org or board:

   ```bash
   scripts/check.sh                   # every part
   scripts/check.sh lambda firmware   # only the parts you touched
   ```

4. Open the pull request into `Dev` and fill in the template.

The pull request checks run the same `scripts/check.sh`. Because your pull
request comes from a fork, a maintainer approves the first run, and the checks
never receive the project's AWS or Salesforce credentials.

## What a change needs to merge

Every change in this project is held to four things. The template asks about
each one:

| | What it means here |
|---|---|
| **Scalable** | Works for a fleet, not just one board. See [docs/SCALING.md](docs/SCALING.md). |
| **Test-covered** | New behaviour has a test under `test/`, Apex tests, or firmware unit tests. |
| **Secure** | No secrets, keys, account IDs, org IDs or personal data in code, logs or docs. Least-privilege IAM and permission sets. |
| **Measurable** | Say what it does to the KPIs and to cost. See [docs/BUSINESS-VALUE.md](docs/BUSINESS-VALUE.md) and [docs/COST-MODEL.md](docs/COST-MODEL.md). |

Project rules the checks enforce:

- A firmware change must raise `FIRMWARE_VERSION`, or the boards never get it.
- New Agentforce agents use the new Agentforce Builder format (Agent Script,
  `AiAuthoringBundle`), not the legacy Bot or GenAiPlanner metadata.
- More conventions are in [docs/CI-CD-SECRETS.md](docs/CI-CD-SECRETS.md#conventions-the-pipelines-enforce).
- If you hit a problem and solve it, add it to
  [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

## Review

The maintainer reviews every pull request and decides whether it fits the
project. A change can be declined even when it works, for example when it adds
cost or scope the project does not need. You will get a reason either way.

By contributing, you agree that your contribution is licensed under the
[MIT License](LICENSE) and that you follow the [Code of Conduct](CODE_OF_CONDUCT.md).
