# bootstrap/: one-time setup with placeholder values

Everything here is applied **once per org, by an admin**, and then belongs to the org. The pipeline never deploys this folder.

## Why it is not in `force-app/`

A Salesforce deploy sets every value a file names. The pipeline deploys `force-app/` on every merge, so anything there that an admin later changes in Setup is put back at the next deploy. For most metadata that is the point. For a few pieces it would break a working org:

| Piece | What an admin sets by hand | What a redeploy would do |
|---|---|---|
| External credential `AWS_IoT_Relay_Credential` | The Region, plus the access key, its secret and the IAM role ARN | Put the placeholder Region back, so AWS refuses every call |
| Named credential `AWS_IoT_Relay` | The API's URL | Point every call at the placeholder host |
| Permission set `AWS_IoT_Relay_Callers` | Nothing, but an org may add its own access to it | Replace the set whole |

So these files sit outside every package directory in `sfdx-project.json`, and one script applies them.

## How to apply it

```bash
scripts/bootstrap-salesforce.sh <org alias> --url <URL> --region <Region>
```

- It creates **only what the org does not have**. A piece that exists is never changed, so running it again is safe.
- The two options are not secrets: `scripts/install.sh` prints the URL. Leave them out and the placeholders below go in, for you to replace in Setup.
- `scripts/install.sh` runs it for you with the real values on a Quick install.
- It refuses to run in GitHub Actions, and it stops without deploying when it cannot tell whether a piece exists.

After it runs, three values are always left for a person to type into the external credential in Setup ([Quick install, step 7](../docs/INSTALL.md#step-7)): the **STS Access Key**, the **STS Access Secret**, and the **IAM Role ARN** on the principal `SalesforceCaller`. Salesforce stores them as credentials, not as metadata, so no file can carry them, and no option or environment variable in this repo ever holds them.

## The placeholders

| Placeholder | In | Replace with |
|---|---|---|
| `https://dummy-replace-me.example.com` | Named credential, URL | The stack's `QueueDepthEndpoint` ("Step 7c") |
| `us-east-1` | External credential, Region | Your project's Region |

Until they are replaced, every Salesforce to AWS call fails, which is the safe way to be wrong: nothing is sent anywhere real.

## What keeps this true

`test/config/bootstrap-placeholders.test.js` fails the checks when `bootstrap/` becomes a package directory, when a workflow or deploy script mentions it, when a credential appears in `force-app/`, or when a file here holds a real account, host or key. `test/scripts/test_bootstrap_salesforce.py` covers the script: creates what is missing, changes nothing that exists, deploys nothing when unsure.

The three files are what a retrieve of the working, hand-made pieces returned (Nov 25), with the URL and Region swapped for placeholders. Creating them in an empty org with the script has not been tried yet.

## Related one-time pieces elsewhere

They follow the same rule (apply once, outside the pipeline) and stay where their docs already point:

- [`scripts/Metadata_Deploy.permissionset-meta.xml`](../scripts/Metadata_Deploy.permissionset-meta.xml): the deploy user's permission set.
- [`infra/bootstrap/github-deploy.yaml`](../infra/bootstrap/github-deploy.yaml): the AWS role GitHub Actions deploys as (`scripts/bootstrap-aws.sh`).
- [`salesforce-templates/portal-routing/`](../salesforce-templates/portal-routing): the portal chat routing flow (`scripts/deploy-portal-routing.sh`).
- `scripts/seed-ssm.sh`: creates each AWS setting with the value `placeholder` and never overwrites one that is set.
