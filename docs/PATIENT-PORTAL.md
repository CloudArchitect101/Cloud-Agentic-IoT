# Patient portal: a React site with Enhanced Chat and Agentforce Voice

Patients sign in to a React site on Salesforce, see what the monitor in their
room reports, and talk to a care assistant, by typing or by voice. The
assistant is an Agentforce Service Agent. It only ever sees the signed-in
patient's own devices, and it can send the care team a nurse request.

Staff keep the Patient Care Agent inside Salesforce. Which agent you reach
depends on where you are: the portal chat reaches the patient agent, and
Lightning reaches the staff agent. The patient agent never serves a staff
request. If someone in the portal chat says they are staff, the agent tells
them to use the Patient Care Agent, and it still answers only for the
signed-in account.

## What is in the repo

| Part | Where | What it does |
| --- | --- | --- |
| React site | `force-app/main/default/uiBundles/patientPortal` | Salesforce Multi-Framework (React 19, Vite, Tailwind), from the official `reactexternalapp` template. Sign-in and password pages, **My room** (`src/pages/Home.tsx`), and the chat (`src/components/PatientChat.tsx`). There is no self-registration: the care team creates each patient's user. |
| Site | `networks/`, `sites/`, `digitalExperiences/`, `digitalExperienceConfigs/` | The Experience Cloud site that hosts the React app (`appContainer: true`). Its members are holders of `Patient_Portal_User`, plus admins. |
| Who is asking | `PortalIdentityService` | Finds the patient from the signed-in user (the site) or from the verified chat (the agent). Everything below is scoped to the account it returns. |
| Patient data | `PatientDeviceService` | Patient Device Assets on that one account, and their latest readings. Never another account's devices, and never an internal board. |
| Site endpoints | `PortalDevicesResource` (`GET /portal/my-devices`), `PortalChatTokenResource` (`POST /portal/chat-token`) | Apex REST, called through the Data SDK as the patient. |
| Agent | `aiAuthoringBundles/Patient_Portal_Agent` (Agent Script), published by `scripts/publish-portal-agent.sh` | The Patient Portal Agent, built for the new Agentforce Builder: a router, the **My Room** subagent and its two Apex actions (Get My Devices, Request a Nurse), plus off-topic and ambiguous-question subagents. |
| Settings | `Patient_Portal_Setting__mdt.Default` | Certificate, key id, issuer, deployment, chat site URL, token lifetime, and the nurse request's Origin and queue. Environments differ here only. |
| Permission sets | `Patient_Portal_User`, `Patient_Portal_Agent`, `Patient_Portal_Guest_Api` | For the patients, for the agent's user, and for the site's guest user (the sign-in pages). |
| JWK helper | `scripts/portal-chat-jwk.mjs` | Turns the signing certificate into the key Messaging user verification asks for. |

## How the patient is proven, end to end

```
Patient signs in to the site ──► React app (runs as the patient)
   │  GET  /portal/my-devices      ──► PortalIdentityService.forCurrentUser()
   │                                    User.AccountId = the Person Account ──► their devices only
   │  POST /portal/chat-token      ──► JWT {iss, sub = patient's User Id, iat, exp = 5 min}
   │                                    signed RS256 in Apex with the Patient_Portal_Chat certificate
   ▼
Enhanced Chat v2 (bootstrap.js)  ──► userVerificationAPI.setIdentityToken(JWT)
   │                                    Messaging checks it against the keyset (the certificate's public key)
   │                                    end user key = v2/iamessage/AUTH/<keyset>/uid:<User Id>
   ▼
Patient Portal Agent (runs as its agent user)
   Get My Devices / Request a Nurse ──► PortalIdentityService.forMessagingSession(RoutableId)
                                         verified key? active portal user? ──► that user's AccountId
```

Why the agent cannot simply use `with sharing`: an Agentforce Service Agent
runs as its own agent user, not as the patient, so sharing rules describe the
agent user and say nothing about who is chatting. The patient comes from the
conversation itself, through the verified end user, and only if Messaging
verified the token. The model never supplies the patient. The Agent Script
binds each action's session Id input to the `RoutableId` variable
(`with messagingSessionId = @variables.RoutableId`, linked to
`@MessagingSession.Id`), so the model never fills it. Even if the model passed another session Id, it would need a live,
verified session to get anything.

Another patient's device answers "No device X is linked to your account",
the same answer as for a device that does not exist, so a patient cannot even
learn that it exists. The Apex tests prove it: `MyDevicesAgentActionTest`,
`RequestNurseAgentActionTest`, `PatientDeviceServiceTest` and
`PortalDevicesResourceTest` each use two patients.

## Why two agents and not one

The original wish was one agent that tells a staff request from a patient's.
Salesforce does not allow it: an agent has exactly one type, and the two
types run differently.

| | Patient Care Agent | Patient Portal Agent |
| --- | --- | --- |
| Type | Employee agent | Service agent |
| Runs as | The signed-in staff member | Its own agent user |
| Reached from | Salesforce and Slack | Enhanced Chat on the portal (text and voice) |
| Who sees what | The staff member's own sharing and permissions | The patient from the verified chat token, scoped in Apex to their Person Account |

An employee agent cannot sit on a public chat channel. A service agent's
sharing describes its agent user, not the person chatting, so it cannot keep
patients apart by sharing. Two agents give a hard boundary instead of a
judgement call:

- Staff never reach the portal agent from inside Salesforce.
- A staff user who signs in to the portal chat counts as unverified. They get
  no patient data, and the agent points them to the Patient Care Agent.

The Apex behind them is shared (device readings, PII masking); only the
identity check differs. One service agent for both is possible, but staff
would then run as the agent user and lose their own permissions, which is
the weaker design for a hospital.

## Why Enhanced Chat v2 and not a chat drawn in React

Agentforce Voice runs only in Salesforce's own Enhanced Chat v2 window on an
Enhanced Web Chat channel. The Help comparison table lists it as not
available for In-App or Custom Client deployments. A chat drawn in React
would talk to the Messaging REST API as a Custom Client and lose Salesforce
voice. It would have to use the browser's speech recognition instead. Vitaly
chose Enhanced Chat v2 with Agentforce Voice on Nov 9. The React site embeds
it, and every other part of the page is React.

## Licences: what each patient needs

| Need | Choice | Why |
| --- | --- | --- |
| One user per patient (Person Account) | **Customer Community**, member or login | Person Account users are supported. A patient sees only their own account's records, which is all the portal needs, so Customer Community Plus (roles, sharing rules, reports) adds nothing here. The React template's sign-in also expects a Customer Community or Customer Community Login licence. |
| API access for the site | the `ApiEnabled` permission in `Patient_Portal_User` | Without it the site's `/sf/api/` proxy answers `API_DISABLED_FOR_ORG` and the app treats the patient as signed out. |
| The agent | an Agentforce Service Agent with its own agent user | Billed per action or per voice minute (below), not per patient. |

The licence counts in a Developer Edition vary. Check what
test-cloudarchitect101 has before creating patients:

```bash
sf data query --target-org test-cloudarchitect101 \
  --query "SELECT Name, TotalLicenses, UsedLicenses FROM UserLicense WHERE Name LIKE '%Community%'"
```

Person Accounts are already on in test-cloudarchitect101 (since Nov 7). The
Apex tests use business accounts with a contact, which scope the same way, so
they pass in an org with or without Person Accounts. They do need an
Experience Cloud user licence to create a portal user.

## Costs

Full model in [COST-MODEL.md](COST-MODEL.md#7-patient-portal-react-site-enhanced-chat-and-agentforce-voice).
In short: the site and the React app cost nothing beyond the patient's
licence. The agent costs 20 Flex Credits (about $0.10) per action, and voice
costs 60 Flex Credits (about $0.30) a minute. A Developer Edition costs
nothing, within its Agentforce allowance.

## Setting it up in an org

Code first: the deploy brings everything above. These steps are the clicks
that have no metadata, in order. Each one is also in
[SETUP.md](SETUP.md#9-patient-portal).

1. **Licences.** Run the query above. You need at least one Customer
   Community (or Customer Community Login) licence per test patient.
2. **Digital Experiences.** Setup > Digital Experiences > Settings > Enable
   Digital Experiences, and pick a domain. The site's metadata deploys only
   after this. Then Setup > Digital Experiences > Settings > turn on "Allow
   using standard external profiles for self-registration, user creation, and
   login".
   Without it the portal Apex tests fail with `FIELD_INTEGRITY_EXCEPTION`
   on `ProfileId`, so the deploy fails too.
3. **Signing certificate.** Setup > Certificate and Key Management > Create
   Self-Signed Certificate: Label and Unique Name `Patient_Portal_Chat`, key
   size 2048, Exportable Private Key **off**. Download the certificate (the
   public `.crt`), then run:
   ```bash
   node scripts/portal-chat-jwk.mjs ~/Downloads/Patient_Portal_Chat.crt patient-portal-chat-1 > ~/Downloads/patient-portal-chat-key.json
   ```
   Keep the file for step 6. It is public, but it belongs in Setup, not in
   the repo.
4. **Deploy.** `SF_TARGET_ORG=test-cloudarchitect101 scripts/deploy-salesforce.sh Dev`.
   It builds the React app first (`npm ci && npm run build` in the bundle),
   then validates and deploys as usual.
5. **Messaging channel and deployment.** Turn on Omni-Channel (Omni-Channel
   Settings) and Messaging (Messaging Settings). Then Setup > Embedded Service
   Deployments > New Deployment > **Enhanced Chat** > Web. Name it
   `Patient_Portal_Chat`, set the domain to the site's domain
   (`*.my.site.com`; add a custom domain here too when it exists, and publish
   again), and let it create the Messaging channel. Open it, choose **Switch
   to V2**, and publish. In Messaging Settings, turn on **Allow Agentforce
   Voice calls in Enhanced Chat**. The channel's routing to the agent comes in
   step 7.
6. **User verification.** Setup > **Enhanced Chat User Verification** > JSON
   Web Keys > New Key: upload the `.json` file from step 3. Then JSON Web
   Keysets > **New Keyset** (a separate record: the channel lists keysets,
   not keys): name `Patient_Portal_Keyset`, issuer
   `cloud-agentic-iot-patient-portal` (the setting's `Issuer__c`), add the
   key. In Messaging Settings, open the channel from step 5: tick **Add User
   Verification** (Session-Based Chat stays off), save, then under **User
   Verification Configuration** > New choose `Patient_Portal_Keyset`. Unverified conversations now
   get nothing from the agent.
7. **The agent.** It is Agent Script, built for the new Agentforce Builder,
   so it is published rather than deployed.
   - Create its agent user: Setup > Users > New User, licence **Einstein
     Agent**, profile **Einstein Agent User**. Assign it the permission sets
     `AgentforceServiceAgentBase`, `AgentforceServiceAgentUser`,
     `EinsteinGPTPromptTemplateUser` and `Patient_Portal_Agent`.
   - Publish, with that user's username:
     ```bash
     PORTAL_AGENT_USER=<agent user's username> scripts/publish-portal-agent.sh test-cloudarchitect101
     ```
     It compiles the script (`sf agent validate authoring-bundle`), then runs
     `sf agent publish authoring-bundle`, which creates the agent. The
     username goes into the publish only; the repo keeps a placeholder.
   - Activate it: `sf agent activate --api-name Patient_Portal_Agent --target-org <org>`.
   - Route the chat to it. In Setup > Queues > Care Team Queue, Messaging
     Session must be a supported object (the deploy ships that). Then:
     ```bash
     scripts/deploy-portal-routing.sh test-cloudarchitect101
     ```
     It looks up the agent, the Messaging service channel and the queue by
     name, fills their Ids into the Omni-Channel flow
     `Route_Patient_Portal_Chat` (`salesforce-templates/portal-routing/`;
     Route Work stores Ids, so the flow cannot live in `force-app/`), and
     deploys it. Then Messaging Settings > Patient Portal Chat > Routing Type
     **Omni-Flow**, Flow `Route_Patient_Portal_Chat`, Fallback Queue **Care
     Team Queue**. (Agentforce Builder's Connections list showed no channel
     in a Developer Edition, which is why the flow does the routing.)
   - To change the agent, edit `Patient_Portal_Agent.agent` and publish again:
     each publish is a new version.
8. **Point the site at the chat.** From the deployment's code snippet, copy
   the site URL (it holds `ESW` and the deployment name). Put it in
   `Patient_Portal_Setting.Default` as `Chat_Site_Url__c`, and redeploy. Leave
   `Scrt_Url__c` blank unless the snippet's `scrt2URL` differs from your My
   Domain with `.my.salesforce-scrt.com`.
9. **Trusted sites.** Nothing to click: the deploy ships two Trusted URLs
   (`cspTrustedSites/Enhanced_Chat_SCRT*`) for `https://` and `wss://`
   `*.salesforce-scrt.com`. A Multi-Framework site has no Security & Privacy
   page in its Administration, because Experience Builder can't open it, so
   the org's Trusted URLs are where its CSP comes from. The chat's own site
   (`ESW...`) and the portal's Apex REST sit on the portal's my.site.com host,
   so they need no entry and no CORS rule. If the browser console still shows
   a "Refused to connect" or "Refused to frame" CSP error, add that host
   under Setup > Trusted URLs, and if a custom domain goes live, add it to
   the deployment's allowed domains.
10. **Guest user.** Site > Administration > Pages > Public Access: assign
    `Patient_Portal_Guest_Api` to the guest user, so the sign-in page can call
    its Apex.
11. **Patients.**
    - **A role for the account owner, once.** Salesforce enables a portal user
      only on an account whose owner has a role; otherwise it stops with
      "portal account owner must have a role". The deploy ships the role
      **Care Team Administrator** (`roles/`). Setup > Users > your user (the
      one who owns, creates and enables the patients' Person Accounts) > Edit
      > Role: **Care Team Administrator** > Save. If another user owns the
      accounts, that user needs the role. The patients' own users get no role:
      Customer Community users don't have one.
    - **The enabling user's rights.** The user who clicks Enable Customer User
      needs Manage External Users, which System Administrator has.
    - For each Person Account: Enable Customer User (profile Customer
      Community User), and assign `Patient_Portal_User`. A Patient Device
      Asset accepts only a Person Account (validation rule
      `Patient_Device_Needs_Person_Account`).
    - Attach the patient's device: its Asset's Account is
    the Person Account, record type Patient Device. For the two-patient demo:
    Test8 goes to patient A, and patient B gets a second Patient Device Asset,
    which can be a placeholder with no board.
12. **Try it.** Sign in as patient A. My room shows Test8. Ask the assistant
    "how warm is my room?", then "what does device <B's serial> say?" (it
    should answer that the device is not linked to your account). Then "I
    need a nurse": a Case with Origin Patient Portal appears on Care_Team_Queue
    and the ward board moves. Start a voice conversation from the chat window
    and ask again.

## If a step fails

| Symptom | Cause | Fix |
| --- | --- | --- |
| The React app shows the sign-in page right after a successful sign-in | The patient lacks `ApiEnabled`, so `getCurrentUser()` fails with `API_DISABLED_FOR_ORG` | Assign `Patient_Portal_User` |
| The chat bubble says "The care assistant is not available yet" | Step 8 not done: `Chat_Site_Url__c` is blank (the debug log says so; the patient sees only plain words) | Set `Chat_Site_Url__c` and redeploy |
| "The chat could not sign you in" | `Crypto.signWithCertificate` found no certificate named `Certificate_Name__c` | Create it (step 3) with exactly that Unique Name |
| The agent says "You are not signed in to the patient portal" in a signed-in chat | The keyset is not on the channel, the `kid` or `iss` differ from the key or keyset, or the token expired | Compare `Key_Id__c` and `Issuer__c` with step 6. The site refreshes an expired token on `onEmbeddedMessagingIdentityTokenExpired` |
| The agent answers but never calls an action | The agent user lacks `Patient_Portal_Agent`, so it may not run the Apex | Step 7 |
| `sf agent publish authoring-bundle` fails on the agent user | `PORTAL_AGENT_USER` is not an active Einstein Agent user, or it lacks the three Agentforce Service Agent permission sets | Step 7 |
| `sf agent validate authoring-bundle` is not a command | The Salesforce CLI is older than the Agent Script commands | `sf update` |
| No voice button in the chat | The deployment is still V1, or voice is off in Messaging Settings or on the agent's connection | Step 5 and step 7 |
| Inserting a patient's user fails: "portal account owner must have a role" | The Person Account's owner has no role | Give the owner the role Care Team Administrator (step 11), then try again |

## Sources

- [Build with React on Salesforce: Multi-Framework is GA (July 2026)](https://developer.salesforce.com/blogs/2026/07/build-with-react-on-salesforce-multi-framework-is-now-ga) and [project structure](https://developer.salesforce.com/docs/platform/multiframework/guide/mfw-project-structure.html): `Experience` target, `reactexternalapp` template.
- [What's Enhanced Chat v2](https://help.salesforce.com/s/articleView?id=service.enhanced_chat_v2_intro.htm&language=en_US&type=5) and [Compare Enhanced Chat v1 to v2](https://help.salesforce.com/s/articleView?language=en_US&id=service.enhanced_chat_feature_comparison.htm&type=5): Agentforce Voice is in v2 web channels, not Custom Client.
- [Enable Agentforce Voice in Enhanced Chat v2 (walkthrough)](https://medium.com/@marketingcloudtips/agentforce-trying-the-voice-enabled-agent-agentforce-voice-637c53685782).
- [Messaging for In-App and Web user verification (walkthrough)](https://medium.com/@anonymoususer123/messaging-for-in-app-and-web-user-verification-setup-in-salesforce-5789bd8731a4): JWK and keyset, `setIdentityToken`, the end user key built from `sub`.
- `@salesforce/platform-sdk` 12.17 docs (in the package): `sdk.fetch` for `/services/apexrest/…` on the web app surface.
