# Platform Primer: Apex, LWC and Salesforce for Python Developers

The mental-model mapping this series assumes. If you write Python and have never touched Salesforce, read this once and every code snippet in the repo will make sense. Every blog post links here instead of re-explaining.

## The big picture in one paragraph

Salesforce is a **multi-tenant** platform: your code runs on shared servers next to thousands of other companies' code. Nearly everything unusual about Apex follows from that one fact — the runtime enforces hard per-transaction quotas ("governor limits") so no tenant can starve the others, the database is reached through a restricted query language (SOQL) rather than raw SQL, and you deploy *metadata* (XML describing objects, code, config) rather than a running server.

## Concept map

| Salesforce | Nearest Python-world equivalent | The catch |
|---|---|---|
| **Apex** | Java-flavoured typed language | Compiles and runs *inside* Salesforce; there is no `pip install`, no filesystem, no threads |
| **SOQL** `[SELECT Id FROM Case WHERE ...]` | ORM query (Django `Case.objects.filter(...)`) | Embedded in the language with compile-time checking; no joins as you know them — you traverse relationships (`Wi_Fi_Network__r.SSID__c`) |
| **DML** `insert`, `update`, `delete` | `session.add` + `commit` | Counted by *statement*, not row — which is why you collect records into a `List` and insert once |
| **Governor limits** | A strict per-request quota system | 100 SOQL queries, 150 DML statements, 50 `@future` calls *per transaction*. Exceed one and the transaction dies uncatchably. This is why every trigger here is "bulkified" |
| **Bulkification** | Vectorising a loop | Triggers receive up to 200 records per invocation, so code must handle a `List`, never assume one record |
| **Trigger** | Django signal / SQLAlchemy event hook | Fires on insert/update/delete of an object; convention is one trigger per object because multiple triggers on one object run in *undefined order* |
| **`@future` / Queueable** | Celery task / `asyncio.create_task` | Async, runs later in its own transaction; required for HTTP callouts from triggers (a trigger cannot block on the network) |
| **Platform Event** `Something__e` | Kafka / SNS topic | Pub/sub inside Salesforce; publishers don't know subscribers. `__e` suffix = event, `__c` = custom object/field, `__mdt` = custom metadata |
| **Custom object** `Patient_Vitals__c` | A database table you define | Declared as XML metadata, not `CREATE TABLE` |
| **Custom Metadata** `__mdt` | Config table that deploys like code | Like feature flags/settings rows that ship through git and CI rather than being typed into prod |
| **`with sharing`** | Row-level security enforced at the ORM layer | The class only sees records the running user can see. Omit it and the class sees everything — a common audit finding |
| **`@InvocableMethod`** | Registering a function as a tool (FastAPI endpoint + schema) | Exposes Apex to Flows and to Agentforce agents as a callable action |
| **`@IsTest` classes** | pytest | Tests run in an isolated transaction that rolls back; org data is invisible to them; **75% code coverage is enforced at deploy time** |
| **`Test.setMock` / `HttpCalloutMock`** | `unittest.mock` / `responses` | Tests may not make real HTTP calls — unmocked callouts throw |
| **Named Credential** | A secrets manager entry the HTTP client uses transparently | `callout:AWS_IoT_Relay/path` — auth config lives in setup, never in code |
| **LWC (Lightning Web Component)** | Standard Web Components, closest to Lit; `@api` ≈ props | HTML template + JS class + XML manifest; reactivity is automatic for tracked fields |
| **`sf project deploy start`** | `terraform apply` for the org | Pushes the XML/code in `force-app/` into the org; `--dry-run` = `terraform plan` |
| **Org** | Your isolated tenant (database + code + config) | Dev orgs are free, full-featured, and small (~5 MB data) |

## Three idioms you will see constantly in this repo

**1. Collect-then-act (because limits count statements):**
```apex
List<Case> toInsert = new List<Case>;
for (EscalationRequest req : requests) {   // maybe 200 of them
    toInsert.add(new Case(...));           // collect - free
}
Database.insert(toInsert, false);          // ONE DML statement for the batch
```
Python instinct says `for r in requests: insert(r)` — on this platform that pattern dies at record 151.

**2. Trigger delegates to a service class:**
```apex
trigger AssetTrigger on Asset (after insert, after update) {
    DeviceProvisioningService.provisionAsync(ids);   // logic lives in the class
}
```
Triggers are like signal handlers: keep them thin, put logic where it can be tested.

**3. Async for anything that leaves the building:**
```apex
@future(callout=true)
public static void provisionAsync(Set<Id> assetIds) { ... }
```
A trigger runs inside the user's save transaction — blocking that on an HTTP call to AWS would freeze their UI and hold locks. `@future` is "run this soon, separately", like queuing a Celery task, with the same delivery caveats.

## Reading `__` suffixes at a glance

`Asset` (no suffix) = standard object • `Patient_Vitals__c` = custom object • `SSID__c` = custom field • `Wi_Fi_Network__r` = *relationship traversal* to that object • `Queue_Depth_Change__e` = platform event • `Device_Queue_Binding__mdt` = custom metadata type
