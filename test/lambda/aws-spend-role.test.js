'use strict';

// The aws-spend function reads this month's AWS spend for the Home page's
// usage card. These tests read lambda/queue-relay/cloudformation.yaml and pin
// what it may do (read budgets, ask Cost Explorer, and keep one parameter),
// that only it runs as its role, the settings it gets, and how Salesforce
// reaches it. The function's unit tests fake the AWS SDK, so none of this
// would fail anywhere but in AWS.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  resources, resource, listOf, grants, source,
} = require('../helpers/template');

const TEMPLATE = 'lambda/queue-relay/cloudformation.yaml';
const SOURCE = 'lambda/aws-spend/index.js';
const CACHE = 'arn:${AWS::Partition}:ssm:${AWS::Region}:${AWS::AccountId}:parameter/cloud-agentic-iot/cache/aws-spend';

// What AWS checks each call of the function against, by the name of its SDK
// command, as "action on resource". DescribeBudgets also needs
// aws-portal:ViewBilling in an account still on the old billing actions.
const NEEDS = {
  DescribeBudgets: [
    'budgets:ViewBudget on !Sub arn:${AWS::Partition}:budgets::${AWS::AccountId}:budget/*',
    'aws-portal:ViewBilling on *',
  ],
  GetCostAndUsage: ['ce:GetCostAndUsage on *'],
  GetParameter: [`ssm:GetParameter on !Sub ${CACHE}`],
  PutParameter: [`ssm:PutParameter on !Sub ${CACHE}`],
};

test('AwsSpendRole may make every call the aws-spend function makes, and no other', () => {
  const role = resource(TEMPLATE, 'AwsSpendRole');
  assert.deepEqual(listOf(role.Properties.ManagedPolicyArns), ['arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole']);
  const allowed = listOf(role.Properties.Policies)
    .flatMap((policy) => grants(policy.PolicyDocument, `AwsSpendRole ${policy.PolicyName}`));

  // Every name ending in Command counts, however it is used. A scan that
  // found none would let this test pass on nothing.
  const calls = [...new Set([...source(SOURCE).matchAll(/\b(\w+)Command\b/g)].map(([, operation]) => operation))];
  assert.deepEqual(calls.sort(), Object.keys(NEEDS).sort(), `${SOURCE} makes calls this test does not list. Add each to `
    + 'NEEDS, with what AWS checks it against, allow it in AwsSpendRole, and drop from both what it no longer calls.');
  assert.deepEqual(allowed.sort(), Object.values(NEEDS).flat().sort());
});

test('only the aws-spend function runs as AwsSpendRole', () => {
  const naming = [...resources(TEMPLATE)]
    .filter(([name, body]) => name !== 'AwsSpendRole' && body.some((line) => /\bAwsSpendRole\b/.test(line)))
    .map(([name]) => name);
  assert.deepEqual(naming, ['AwsSpendFunction']);
  const fn = resource(TEMPLATE, 'AwsSpendFunction').Properties;
  assert.equal(fn.FunctionName, 'cloud-agentic-iot-aws-spend');
  assert.equal(fn.Role, '!GetAtt AwsSpendRole.Arn');
});

test('the function gets exactly the settings it reads, and its cache parameter from the stack', () => {
  const variables = resource(TEMPLATE, 'AwsSpendFunction').Properties.Environment.Variables;
  assert.deepEqual(variables, {
    ACCOUNT_ID: '!Ref AWS::AccountId',
    SPEND_CACHE_PARAMETER: '!Ref AwsSpendCache',
    SPEND_CACHE_HOURS: '!Ref SpendCacheHours',
    SPEND_COST_EXPLORER: '!Ref SpendCostExplorer',
    SPEND_LIMIT_BUDGET_NAME: '!Ref SpendLimitBudgetName',
  });
  const read = [...source(SOURCE).matchAll(/\b(?:requiredEnv|numberEnv|booleanEnv)\('(\w+)'\)|process\.env\.(\w+)/g)]
    .map(([, viaHelper, direct]) => viaHelper || direct);
  assert.deepEqual([...new Set(read)].sort(), Object.keys(variables).sort());
  // The parameter is the stack's own, so no setting may name it by hand.
  assert.doesNotMatch(source(TEMPLATE), /Default: \/cloud-agentic-iot\/cache/);
});

test('AwsSpendCache is the one parameter the SSM grant names, and starts empty', () => {
  const cache = resource(TEMPLATE, 'AwsSpendCache');
  assert.equal(cache.Type, 'AWS::SSM::Parameter');
  assert.equal(cache.Properties.Name, '/cloud-agentic-iot/cache/aws-spend');
  assert.ok(CACHE.endsWith(`:parameter${cache.Properties.Name}`), 'the grant is scoped to its name');
  assert.equal(cache.Properties.Type, 'String');
  assert.equal(cache.Properties.Value, '{}');
});

test('both billing clients ask us-east-1, and Cost Explorer is never retried by the SDK', () => {
  const code = source(SOURCE);
  assert.match(code, /new BudgetsClient\(\{ region: 'us-east-1' \}\)/);
  // Each Cost Explorer request costs $0.01.
  assert.match(code, /new CostExplorerClient\(\{ region: 'us-east-1', maxAttempts: 1 \}\)/);
  const dependencies = JSON.parse(source('lambda/aws-spend/package.json')).dependencies;
  assert.deepEqual(Object.keys(dependencies).sort(),
    ['@aws-sdk/client-budgets', '@aws-sdk/client-cost-explorer', '@aws-sdk/client-ssm', '@cloud-agentic-iot/shared']);
  // The first client that sends ShowFilterExpression; an older one drops it.
  assert.equal(dependencies['@aws-sdk/client-budgets'], '^3.793.0');
});

test('until the deploy replaces it, the placeholder answers 503 with "Placeholder", which the card names', () => {
  const zip = resource(TEMPLATE, 'AwsSpendFunction').Properties.Code.ZipFile;
  assert.match(zip, /statusCode: 503/);
  assert.match(zip, /body: 'Placeholder - /);
  assert.match(source('force-app/main/default/classes/PlatformUsageController.cls'), /result\.body\.contains\('Placeholder'\)/);
});

test('Salesforce reaches the function as POST /aws-spend, signed with SigV4, with no change to its role', () => {
  const route = resource(TEMPLATE, 'AwsSpendRoute').Properties;
  assert.equal(route.ApiId, '!Ref QueueRelayApi');
  assert.equal(route.RouteKey, 'POST /aws-spend');
  assert.equal(route.AuthorizationType, 'AWS_IAM');
  assert.equal(route.Target, '!Sub integrations/${AwsSpendIntegration}');
  const integration = resource(TEMPLATE, 'AwsSpendIntegration').Properties;
  assert.equal(integration.ApiId, '!Ref QueueRelayApi');
  assert.equal(integration.IntegrationUri, '!GetAtt AwsSpendFunction.Arn');
  assert.equal(integration.IntegrationType, 'AWS_PROXY');
  assert.equal(integration.PayloadFormatVersion, '2.0');
  const permission = resource(TEMPLATE, 'AwsSpendPermission').Properties;
  assert.equal(permission.Action, 'lambda:InvokeFunction');
  assert.equal(permission.FunctionName, '!Ref AwsSpendFunction');
  assert.equal(permission.Principal, 'apigateway.amazonaws.com');
  assert.equal(permission.SourceArn, '!Sub arn:${AWS::Partition}:execute-api:${AWS::Region}:${AWS::AccountId}:${QueueRelayApi}/*');
  // The caller may already invoke every POST route of this API.
  const caller = resource(TEMPLATE, 'SalesforceCallerRole').Properties.Policies[0].PolicyDocument;
  assert.deepEqual(grants(caller, 'SalesforceCallerRole'),
    ['execute-api:Invoke on !Sub arn:${AWS::Partition}:execute-api:${AWS::Region}:${AWS::AccountId}:${QueueRelayApi}/*/POST/*']);
});

test('Dev and Prod keep Cost Explorer off, and keep a reading for a day', () => {
  for (const env of ['Dev', 'Prod']) {
    const relay = JSON.parse(source(`config/${env}.json`)).stacks['queue-relay'];
    assert.equal(relay.SpendCostExplorer, 'false', env);
    assert.equal(relay.SpendCacheHours, 24, env);
  }
});
