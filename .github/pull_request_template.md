## What and why

<!-- One goal per pull request. Link the issue: "Closes #123". -->

## How it was tested

<!-- Commands you ran and what they showed. scripts/check.sh needs no
credentials. Say if you also tried it on a real org, AWS account or board. -->

- [ ] `scripts/check.sh` (or the parts I touched) passes locally
- [ ] New behaviour has tests

## Checklist

- [ ] **Scalable:** works for a fleet of boards, not only one
- [ ] **Secure:** no secrets, keys, account or org IDs, or personal data; permissions stay least-privilege
- [ ] **Measurable:** KPI and cost impact described below (or "none")
- [ ] Firmware changed? `FIRMWARE_VERSION` is raised
- [ ] Docs updated, and any problem I solved is in `docs/TROUBLESHOOTING.md`
- [ ] Targets `Dev`, not `Prod`

## KPI and cost impact

<!-- e.g. "adds one Lambda call per reading, about $0.20 per 1M readings". -->

## AI assistance

<!-- Optional: did you use AI tools? That's fine. You are responsible for
reviewing what you submit. -->
