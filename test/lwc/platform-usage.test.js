'use strict';

/*
 * The usage card on the Cloud Agentic IoT app's Home page
 * (force-app/main/default/lwc/platformUsageCard).
 *
 * usage.js holds everything the card works out: groups, labels, bars,
 * colours, amounts and captions. It has no imports, so Node imports its text
 * as a data: URL and these tests run on the bytes the card ships, with no
 * build step and no Jest. The last tests read the card's other files, its
 * Apex and its metadata, and pin what would otherwise only show in an org:
 * one read per page load, admins only, and on this app's Home page alone.
 */

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '../..');
const app = (file) => fs.readFileSync(path.join(root, 'force-app/main/default', file), 'utf8');

let usage;
before(async () => {
  usage = await import(`data:text/javascript,${encodeURIComponent(app('lwc/platformUsageCard/usage.js'))}`);
});

const EN = ['en-US', 'America/Toronto'];
// Newer ICU puts a narrow no-break space before AM and PM.
const plain = (text) => text.replace(/\u202f/g, ' ');

const budgetAnswer = (spent, awsLimit, notices = []) => ({
  answer: {
    month: '2026-11',
    currency: 'USD',
    spent: {
      source: 'budget', basis: 'pre-credit-pre-tax', estimated: null, asOf: '2026-11-06T17:20:05.000Z', keptUntil: null, ...spent,
    },
    limit: awsLimit,
    notices,
  },
  error: null,
  lastKnown: null,
});
const OURS = {
  amount: 20, source: 'budget', name: 'cloud-agentic-iot-monthly', chosenBy: 'name',
};

test('a bar is green below 50%, amber from 50% and red from 80%, and never wider than its track', () => {
  assert.deepEqual([0, 49, 50, 79, 80, 125].map(usage.toneOf), ['ok', 'ok', 'warn', 'warn', 'high', 'high']);
  assert.equal(usage.toneOf(null), 'none');
  assert.equal(usage.WARN_PERCENT, 50);
  assert.equal(usage.HIGH_PERCENT, 80);
  assert.deepEqual(usage.barOf(25, 20), {
    percent: 125, ariaNow: 100, shown: '125%', fillClass: 'fill fill_high', fillStyle: 'width: 100%',
  }, 'over the limit: the text says 125%, the bar and aria-valuenow stop at 100');
  assert.deepEqual(usage.barOf(1, 4), {
    percent: 25, ariaNow: 25, shown: '25%', fillClass: 'fill fill_ok', fillStyle: 'width: 25%',
  });
  assert.equal(usage.barOf(3, 10000).shown, 'under 1%', 'some use, however little, is not 0%');
  assert.equal(usage.barOf(0, 10000).shown, '0%');
  assert.equal(usage.percentOf(1, 0), null, 'a limit of 0 has no share');
  assert.equal(usage.percentOf('1', 2), null, 'only numbers count');
});

test('AWS spend against the named budget: amount, limit, bar, what it counts, and when it was read', () => {
  const view = usage.awsView(budgetAnswer({ amount: 3.42 }, OURS), ...EN);
  assert.equal(view.hasAnswer, true);
  assert.equal(view.month, 'November 2026 (UTC)');
  assert.equal(view.spent, '$3.42');
  assert.equal(view.limitText, 'of $20.00, budget cloud-agentic-iot-monthly');
  assert.deepEqual(view.bar, {
    key: 'aws',
    label: 'Spend against the limit',
    percent: 17,
    ariaNow: 17,
    shown: '17%',
    fillClass: 'fill fill_ok',
    fillStyle: 'width: 17%',
    text: '17% of the limit',
  });
  assert.equal(view.basisText, 'Before credits, refunds and tax, as a spend limit counts.');
  assert.equal(view.noLimit, null);
  assert.deepEqual(view.notices, []);
  assert.equal(plain(view.caption), 'Read at Nov 6, 12:20 PM. AWS recalculates budgets about every 8 to 12 hours.');
  assert.equal(view.error, null);
  assert.equal(view.lastKnownText, null);
});

test('the largest budget says so, and each basis and the estimated flag have their line', () => {
  const largest = usage.awsView(budgetAnswer({ amount: 41, basis: 'net' }, {
    amount: 50, source: 'budget', name: 'alerts', chosenBy: 'largest',
  }), ...EN);
  assert.equal(largest.limitText, 'of $50.00, the largest budget (alerts)');
  assert.equal(largest.basisText, 'After credits and refunds, with tax: the budget has no charge-type filter.');
  assert.equal(largest.bar.fillClass, 'fill fill_high', '82% is red');
  assert.equal(largest.bar.text, '82% of the limit');

  const unknown = usage.awsView(budgetAnswer({ amount: 12, basis: 'unknown' }, OURS), ...EN);
  assert.equal(unknown.basisText, "What this counts depends on the budget's charge-type filter.");
  assert.equal(unknown.bar.fillClass, 'fill fill_warn', '60% is amber');
  assert.equal(usage.awsView(budgetAnswer({ amount: 30 }, { ...OURS, amount: 20 }), ...EN).bar.text, '150% of the limit');

  const explorer = usage.awsView({
    answer: {
      month: '2026-11',
      currency: 'USD',
      spent: {
        amount: 3.42,
        source: 'cost-explorer',
        basis: 'pre-credit-pre-tax',
        estimated: true,
        asOf: '2026-11-06T17:20:05.000Z',
        keptUntil: '2026-11-07T17:20:05.000Z',
      },
      limit: null,
      notices: [],
    },
    error: null,
    lastKnown: null,
  }, ...EN);
  assert.equal(explorer.basisText, 'Before credits, refunds and tax, as a spend limit counts. AWS marks this figure as estimated.');
  assert.equal(plain(explorer.caption),
    'Cost Explorer reading from Nov 6, 12:20 PM, kept until Nov 7, 12:20 PM, because each read costs $0.01.');
  assert.equal(explorer.noLimit, usage.NO_LIMIT, 'an amount with no limit says where a limit comes from');
  assert.equal(explorer.bar, null);
  assert.equal(explorer.limitText, '');
});

test('no limit, no amount, no source, and several notices', () => {
  const notices = ['No monthly cost budget found, so there is no spend to show.', 'A new month began at 00:00 UTC.'];
  const none = usage.awsView({
    answer: {
      month: '2026-12',
      currency: 'USD',
      spent: {
        amount: null, source: 'none', basis: 'unknown', estimated: null, asOf: '2026-12-01T02:00:00.000Z', keptUntil: null,
      },
      limit: null,
      notices,
    },
    error: null,
    lastKnown: null,
  }, ...EN);
  assert.equal(none.spent, '—');
  assert.equal(none.bar, null);
  assert.equal(none.noLimit, null, 'the notice already says why');
  assert.deepEqual(none.notices, notices);
  assert.equal(none.caption, '');
  assert.equal(none.month, 'December 2026 (UTC)');

  const notYet = usage.awsView(budgetAnswer({ amount: null }, OURS, ["AWS has not calculated this budget's spend yet."]), ...EN);
  assert.equal(notYet.spent, '—');
  assert.equal(notYet.bar, null);
  assert.equal(notYet.limitText, 'of $20.00, budget cloud-agentic-iot-monthly');
  assert.equal(notYet.noLimit, null);
  assert.equal(notYet.notices.length, 1);

  assert.match(usage.NO_LIMIT, /^No limit found\. .*cloud-agentic-iot-monthly.*AWS Settings\.$/);
});

test('when AWS does not answer: the error, and the last spend AWS did report, with and without a limit', () => {
  const error = 'AWS did not answer. (HTTP 500: {"message":"Internal Server Error"})';
  const lastKnown = {
    month: '2026-11', spent: 19.8, limit: 20, limitName: 'cloud-agentic-iot-monthly', readAt: '2026-11-06T17:20:05.000Z',
  };
  const failed = usage.awsView({ answer: null, error, lastKnown }, ...EN);
  assert.equal(failed.hasAnswer, false);
  assert.equal(failed.error, error);
  assert.equal(plain(failed.lastKnownText), 'Last known: $19.80 of $20.00 (November 2026), read Nov 6, 12:20 PM.');
  assert.equal(failed.month, '');
  assert.equal(failed.caption, '');
  assert.equal(failed.bar, null);

  const noLimit = usage.awsView({ answer: null, error, lastKnown: { ...lastKnown, limit: null, limitName: null } }, ...EN);
  assert.equal(plain(noLimit.lastKnownText), 'Last known: $19.80 (November 2026), read Nov 6, 12:20 PM.');

  assert.equal(usage.awsView({ answer: null, error, lastKnown: null }, ...EN).lastKnownText, null, 'nothing known yet');
});

test('org limits are grouped, most used first, and a limit of 0 is left out', () => {
  const groups = usage.groupOrgLimits([
    { name: 'DailyApiRequests', used: 1234, max: 15000 },
    { name: 'DailyAsyncApexExecutions', used: 5000, max: 250000 },
    { name: 'DataStorageMB', used: 4, max: 5 },
    { name: 'DailyBulkApiBatches', used: 100, max: 15000 },
    { name: 'HourlyPublishedPlatformEvents', used: 30000, max: 50000 },
    { name: 'DailyDeliveredPlatformEvents', used: 30000, max: 50000 },
    { name: 'PrivateConnectOutboundCalloutHourlyLimitMB', used: 0, max: 0 },
    { name: 'SingleEmail', used: 1, max: 15 },
    { name: 'NotANumber', used: null, max: 10 },
  ], 'en-US');
  assert.deepEqual(groups.map((group) => group.name),
    ['Storage (data and files)', 'API', 'Apex', 'Platform events and streaming', 'Email and flows']);
  assert.deepEqual(groups[0].rows.map((row) => [row.label, row.text, row.fillClass]), [['Data Storage', '4 of 5 MB (80%)', 'fill fill_high']]);
  assert.deepEqual(groups[1].rows.map((row) => [row.label, row.text]),
    [['Daily API Requests', '1,234 of 15,000 (8%)'], ['Daily Bulk API Batches', '100 of 15,000 (1%)']]);
  assert.deepEqual(groups[2].rows.map((row) => [row.label, row.text]), [['Daily Async Apex Executions', '5,000 of 250,000 (2%)']]);
  assert.deepEqual(groups[3].rows.map((row) => row.label), ['Daily Delivered Platform Events', 'Hourly Published Platform Events'],
    'the same share: by label');
  assert.ok(groups.every((group) => group.rows.every((row) => row.key && row.label)));
});

test('every limit name Salesforce documents lands in its group', () => {
  const expected = {
    'Storage (data and files)': ['DataStorageMB', 'FileStorageMB'],
    API: ['DailyApiRequests', 'DailyBulkApiBatches', 'DailyBulkApiRequests', 'DailyBulkV2QueryFileStorageMB', 'DailyBulkV2QueryJobs',
      'DailyMetadataRetrievesWithDependencies', 'DailyFunctionsApiCallLimit', 'PermissionSets',
      'DailyDurableStreamingApiEvents', 'DailyDurableGenericStreamingApiEvents', 'DurableStreamingApiConcurrentClients',
      'DailyStreamingApiEvents', 'DailyGenericStreamingApiEvents', 'StreamingApiConcurrentClients'],
    Apex: ['DailyAsyncApexExecutions', 'DailyAsyncApexElasticExecutions', 'DailyAsyncApexTests'],
    'Platform events and streaming': ['HourlyPublishedPlatformEvents', 'HourlyPublishedStandardVolumePlatformEvents',
      'DailyStandardVolumePlatformEvents', 'DailyDeliveredPlatformEvents', 'MonthlyPlatformEventsUsageEntitlement',
      'PlatformEventTriggersWithParallelProcessing'],
    'Email and flows': ['SingleEmail', 'MassEmail', 'DailyWorkflowEmails', 'HourlyTimeBasedWorkflow', 'ScheduledFlowRunLimit', 'ScheduledPathRunLimit'],
    'Analytics and Einstein': ['AnalyticsExternalDataSizeMB', 'ConcurrentAsyncGetReportInstances', 'ConcurrentSyncReportRuns',
      'HourlyAsyncReportRuns', 'HourlySyncReportRuns', 'HourlyDashboardRefreshes', 'HourlyDashboardResults', 'HourlyDashboardStatuses',
      'DailyAnalyticsDataflowJobExecutions', 'DailyAnalyticsUploadedFilesSizeMB', 'ConcurrentEinsteinDataInsightsStoryCreation',
      'ConcurrentEinsteinDiscoveryStoryCreation', 'DailyEinsteinDataInsightsStoryCreation', 'DailyEinsteinDiscoveryPredictAPICalls',
      'DailyEinsteinDiscoveryPredictionsByCDC', 'DailyEinsteinDiscoveryOptimizationJobRuns', 'DailyEinsteinDiscoveryStoryCreation',
      'MonthlyEinsteinDiscoveryStoryCreation'],
    Other: ['HourlyODataCallout', 'HourlyLongTermIdMapping', 'HourlyShortTermIdMapping', 'PrivateConnectOutboundCalloutHourlyLimitMB',
      'ExternalServicesActiveObjects', 'ExternalServicesActiveOperations', 'ExternalServicesObjects', 'ExternalServicesObjectProperties',
      'ExternalServicesOperations', 'ExternalServicesRegistrations', 'MaxContentDocumentsLimit', 'ContentPublicationLimit',
      'ContentDistBandwidthLimitMB', 'ContentDistViewLimit', 'ActiveScratchOrgs', 'DailyScratchOrgs', 'Package2VersionCreates',
      'Package2VersionCreatesWithoutValidation'],
  };
  assert.deepEqual(Object.keys(expected), usage.GROUPS.map(([name]) => name), 'every group, in display order');
  for (const [group, names] of Object.entries(expected)) {
    for (const name of names) assert.equal(usage.groupOf(name), group, name);
  }
  assert.equal(usage.labelOf('HourlyODataCallout'), 'Hourly OData Callout');
  assert.equal(usage.labelOf('DailyBulkV2QueryJobs'), 'Daily Bulk V2 Query Jobs');
  assert.equal(usage.labelOf('DailyBulkV2QueryFileStorageMB'), 'Daily Bulk V2 Query File Storage');
});

test('what this request used is text, one line per limit, with no bar', () => {
  const view = usage.salesforceView({
    asOf: '2026-11-06T17:20:05.000Z',
    orgLimits: [],
    entitlements: { rows: [], error: null },
    thisRequest: [
      { name: 'CpuTimeMs', used: 23, max: 10000 },
      { name: 'HeapBytes', used: 48213, max: 6000000 },
      { name: 'SoqlQueries', used: 3, max: 100 },
      { name: 'QueryRows', used: 1, max: 50000 },
      { name: 'DmlStatements', used: 0, max: 150 },
      { name: 'Callouts', used: 0, max: 100 },
      { name: 'SomethingNew', used: 1, max: 2 },
    ],
  }, ...EN);
  assert.deepEqual(view.thisRequest, [
    { key: 'CpuTimeMs', text: 'CPU time, this request: 23 ms of 10,000 ms' },
    { key: 'HeapBytes', text: 'Memory (heap), this request: 48 KB of 6 MB' },
    { key: 'SoqlQueries', text: 'SOQL queries, this request: 3 of 100' },
    { key: 'QueryRows', text: 'Rows queried, this request: 1 of 50,000' },
    { key: 'DmlStatements', text: 'DML statements, this request: 0 of 150' },
    { key: 'Callouts', text: 'Callouts, this request: 0 of 100' },
  ], 'no bar fields, and a name the card does not know is left out');
  assert.equal(usage.thisRequestOf([{ name: 'HeapBytes', used: 1500000, max: 12000000 }], 'en-US')[0].text,
    'Memory (heap), this request: 1.5 MB of 12 MB');
  assert.equal(plain(view.caption), 'As of Nov 6, 12:20 PM. Salesforce updates these within about 5 minutes.');
  assert.match(usage.ORG_CPU_NOTE, /^Salesforce does not report CPU time or memory \(heap\) for the whole org, only per request\./);

  const html = app('lwc/platformUsageCard/platformUsageCard.html');
  const list = html.slice(html.indexOf('for:each={salesforce.thisRequest}'));
  assert.match(list, /^for:each=\{salesforce\.thisRequest\} for:item="item">\s*<li key=\{item\.key\}>\{item\.text\}<\/li>/);
  assert.match(html, /\{orgCpuNote\}/);
});

test('usage-based entitlements show as bars, and an error names its type', () => {
  const view = usage.salesforceView({
    orgLimits: [{ name: 'DailyApiRequests', used: 1, max: 15000 }],
    entitlements: {
      rows: [
        { name: 'Einstein Requests', used: 120, max: 1000, frequency: 'Monthly' },
        { name: 'Nothing allowed', used: 0, max: 0, frequency: 'Once' },
      ],
      error: null,
    },
  }, ...EN);
  assert.equal(view.hasEntitlements, true);
  assert.deepEqual(view.entitlements.map((row) => [row.key, row.label, row.text, row.fillClass]),
    [['entitlement-0', 'Einstein Requests (Monthly)', '120 of 1,000 (12%)', 'fill fill_ok']]);
  assert.equal(view.entitlementsError, null);
  assert.deepEqual(view.groups.map((group) => group.name), ['API']);

  const refused = usage.salesforceView({ entitlements: { rows: [], error: 'QueryException' } }, ...EN);
  assert.equal(refused.hasEntitlements, false);
  assert.equal(refused.entitlementsError, 'QueryException');
  const html = app('lwc/platformUsageCard/platformUsageCard.html');
  assert.match(html, /Entitlements could not be read \(\{salesforce\.entitlementsError\}\)\./);
  assert.match(html, /\{entitlementsCaption\}/);
  assert.match(html, /\{tokensNote\}/);
  assert.match(usage.TOKENS_NOTE, /Data 360/);
  assert.equal(usage.ENTITLEMENTS_CAPTION, 'Usage-based entitlements, as Setup shows them under Company Information.');
});

test("amounts and times follow the user's locale, and a locale the browser does not know still shows them", () => {
  const french = usage.awsView(budgetAnswer({ amount: 1234.5 }, null), 'fr-CA', 'America/Toronto');
  assert.equal(french.month, 'novembre 2026 (UTC)');
  assert.match(french.spent, /^1\s234,50\s\$\s?US$/);
  const unknown = usage.awsView(budgetAnswer({ amount: 3.42 }, OURS), 'not a locale', 'Not/AZone');
  assert.equal(unknown.spent, 'US$3.42');
  assert.equal(unknown.limitText, 'of US$20.00, budget cloud-agentic-iot-monthly');
  assert.equal(unknown.month, '2026-11 (UTC)');
  assert.match(unknown.caption, /^Read at .+\. AWS recalculates budgets about every 8 to 12 hours\.$/);
  const limits = usage.salesforceView({ asOf: '2026-11-06T17:20:05.000Z', orgLimits: [{ name: 'DailyApiRequests', used: 1234, max: 15000 }] },
    'not a locale', 'Not/AZone');
  assert.equal(limits.groups[0].rows[0].text, '1234 of 15000 (8%)');
  assert.match(limits.caption, /^As of .+\. Salesforce/);
});

test('the card asks once per page load and never polls, and its Apex is never cached', () => {
  const card = app('lwc/platformUsageCard/platformUsageCard.js');
  assert.doesNotMatch(card, /setInterval|setTimeout|refreshApex|@wire|\bwire\b/);
  assert.equal(card.match(/await readSalesforceLimits\(\)/g).length, 1);
  assert.equal(card.match(/await readAwsSpend\(\)/g).length, 1);
  assert.ok(card.indexOf('await readSalesforceLimits()') < card.indexOf('await readAwsSpend()'),
    'one after the other: two calls started together travel as one request');
  assert.match(card, /connectedCallback\(\) \{\n\s+if \(this\.allowed\) \{\n\s+this\.load\(\);/);
  assert.doesNotMatch(card, /localStorage|sessionStorage/, 'the last known spend comes from Salesforce, not the browser');
  assert.doesNotMatch(app('classes/PlatformUsageController.cls'), /cacheable/);
});

test('costs are for admins: the card checks the custom permission, the Apex checks it and View Setup', () => {
  const controller = app('classes/PlatformUsageController.cls');
  assert.match(controller, /VIEW_PERMISSION = 'View_Platform_Usage'/);
  assert.match(controller, /FeatureManagement\.checkPermission\(VIEW_PERMISSION\)\s*&&\s*\[SELECT COUNT\(\) FROM PermissionSetAssignment/);
  assert.match(controller, /PermissionSet\.PermissionsViewSetup = true/);
  assert.equal(controller.match(/requireViewer\(\);/g).length, 2, 'both methods check first');
  assert.match(app('lwc/platformUsageCard/platformUsageCard.js'), /import CAN_VIEW from '@salesforce\/customPermission\/View_Platform_Usage';/);
  assert.equal(usage.NOT_ALLOWED, 'Costs and limits are for admins. Ask an admin for the Platform Usage Viewer permission set.');
  assert.ok(controller.includes(`'${usage.NOT_ALLOWED}'`), 'the card and the Apex say the same');

  const viewer = app('permissionsets/Platform_Usage_Viewer.permissionset-meta.xml');
  assert.match(viewer, /<apexClass>PlatformUsageController<\/apexClass>/);
  assert.match(viewer, /<name>View_Platform_Usage<\/name>/);
  for (const file of fs.readdirSync(path.join(root, 'force-app/main/default/permissionsets'))) {
    if (file === 'Platform_Usage_Viewer.permissionset-meta.xml') continue;
    assert.doesNotMatch(app(`permissionsets/${file}`), /View_Platform_Usage|PlatformUsageController/, file);
  }
  const deviceAdmin = app('permissionsets/Device_Platform_Admin.permissionset-meta.xml');
  assert.doesNotMatch(deviceAdmin, /PlatformUsageController/, 'device operators never see costs');
  assert.doesNotMatch(deviceAdmin, /View_Platform_Usage/, 'device operators never see costs');
});

test('the headline: rings for storage and API, the most used limits first, and how many are past half', () => {
  const view = usage.salesforceView({ orgLimits: [
    { name: 'DataStorageMB', used: 3, max: 5 },
    { name: 'DailyApiRequests', used: 100, max: 15000 },
    { name: 'DailyAsyncApexExecutions', used: 9000, max: 10000 },
    { name: 'SingleEmail', used: 0, max: 15 },
  ] }, ...EN);
  const h = usage.highlightsOf(view, 3);
  assert.deepEqual(h.storage, { key: 'DataStorageMB', title: 'Data storage', shown: '60%', text: '3 of 5 MB (60%)', ringClass: 'ring ring_warn', ringStyle: '--p: 60' });
  assert.equal(h.api.ringClass, 'ring ring_ok');
  assert.deepEqual(h.watch.map((row) => [row.key, row.pillClass]),
    [['DailyAsyncApexExecutions', 'pill pill_high'], ['DataStorageMB', 'pill pill_warn'], ['DailyApiRequests', 'pill pill_ok']]);
  assert.equal(h.nearEdge, 2);
  assert.equal(h.nearEdgeText, '2 of 4 limits are at least half used.');
  assert.equal(usage.highlightsOf(usage.salesforceView({ orgLimits: [{ name: 'SingleEmail', used: 0, max: 15 }] }, ...EN)).nearEdgeText,
    'All 1 limits are under half used.');
  assert.equal(usage.highlightsOf(view).storage.key, 'DataStorageMB');
  assert.equal(usage.highlightsOf(usage.salesforceView({ orgLimits: [] }, ...EN)).storage, null, 'no ring for a limit the org lacks');

  const aws = usage.awsView(budgetAnswer({ amount: 15 }, { amount: 20, name: 'cloud-agentic-iot-monthly' }), ...EN);
  assert.deepEqual(usage.awsRingOf(aws), { shown: '75%', ringClass: 'ring ring_warn', ringStyle: '--p: 75' });
  assert.equal(usage.awsRingOf(usage.awsView(budgetAnswer({ amount: 15 }, null), ...EN)), null);
});

test("the card is this app's Home page, on desktop, and nowhere else", () => {
  assert.deepEqual([...app('lwc/platformUsageCard/platformUsageCard.js-meta.xml').matchAll(/<target>(.+?)<\/target>/g)].map(([, t]) => t), ['lightning__HomePage']);
  const page = app('flexipages/Cloud_Agentic_IoT_Home.flexipage-meta.xml');
  assert.match(page, /<type>HomePage<\/type>/);
  assert.match(page, /<name>home:desktopTemplate<\/name>/);
  assert.deepEqual([...page.matchAll(/<componentName>(.+?)<\/componentName>/g)].map(([, c]) => c),
    ['desktopDashboards:embeddedDashboard', 'platformUsageCard'], 'the Business Value KPIs first, then cost and limits');
  assert.match(page, /<name>dashboardName<\/name>\s*<value>Business_Value<\/value>/);
  const overrides = [...app('applications/Cloud_Agentic_IoT.app-meta.xml').matchAll(/<actionOverrides>([\s\S]*?)<\/actionOverrides>/g)]
    .map(([, body]) => body).filter((body) => body.includes('<actionName>Tab</actionName>'));
  assert.equal(overrides.length, 1);
  assert.match(overrides[0], /<content>Cloud_Agentic_IoT_Home<\/content>/);
  assert.match(overrides[0], /<formFactor>Large<\/formFactor>/);
  assert.match(overrides[0], /<pageOrSobjectType>standard-home<\/pageOrSobjectType>/);
});
