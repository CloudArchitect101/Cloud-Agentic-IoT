'use strict';

// The pipeline signs in to AWS as github-actions-deploy, whose rights are the
// cloud-agentic-iot-deploy policy in infra/bootstrap/github-deploy.yaml. The
// first sign of a missing right would otherwise be an AccessDenied halfway
// through a pipeline run, in an account nobody can deploy to by hand. These
// tests read the scripts the pipeline runs and the templates it deploys, and
// fail here instead. iot-operator's policy (scripts/aws-project-policy.json)
// must allow all of it too, plus the bootstrap itself, because a person proves
// a fresh account by running the same scripts as iot-operator first.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { resource, listOf, source } = require('../helpers/template');

const root = path.join(__dirname, '../..');
const BOOTSTRAP = 'infra/bootstrap/github-deploy.yaml';

// What the deploy job runs, directly or through lib/common.sh.
const PIPELINE_SCRIPTS = [
  'scripts/lib/common.sh',
  'scripts/seed-ssm.sh',
  'scripts/deploy-aws.sh',
  'scripts/index-sops.sh',
  'scripts/deploy-salesforce.sh',
  'scripts/ota.sh',
];

// CLI commands whose IAM action is not their name in PascalCase.
const ACTION_OF = {
  's3 cp': 's3:PutObject',
  's3api head-object': 's3:GetObject',
  's3api list-objects-v2': 's3:ListBucket',
  'lambda wait': 'lambda:GetFunctionConfiguration',
  'lambda invoke': 'lambda:InvokeFunction',
  'cloudformation deploy': 'cloudformation:CreateChangeSet',
  'iot list-job-executions-for-job': 'iot:ListJobExecutionsForJob',
};
// Not calls to AWS at all.
const NOT_CALLS = new Set(['configure get']);

const pascal = (command) => command.split('-').map((word) => word[0].toUpperCase() + word.slice(1)).join('');

/** Every "aws <service> <command>" a script runs, outside comments. */
function cliCalls(file) {
  const calls = new Set();
  for (const line of source(file).split('\n')) {
    if (/^\s*#/.test(line)) continue;
    for (const [, service, command] of line.matchAll(/(?:^|[\s($`])aws ([a-z0-9]+) ([a-z0-9-]+)/g)) {
      calls.add(`${service} ${command}`);
    }
  }
  return calls;
}

function actionFor(call) {
  if (ACTION_OF[call]) return ACTION_OF[call];
  const [service, command] = call.split(' ');
  return `${service === 's3api' ? 's3' : service}:${pascal(command)}`;
}

const matches = (pattern, action) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i').test(action);

/**
 * The Allow and Deny action patterns of a policy's statements. A Deny on
 * particular resources (the bootstrap stack) does not deny the action
 * everywhere, so only Denies on every resource count here.
 */
function actions(statements) {
  const allow = [];
  const deny = [];
  for (const statement of statements) {
    if (statement.Effect !== 'Deny') allow.push(...listOf(statement.Action));
    else if (listOf(statement.Resource).includes('*')) deny.push(...listOf(statement.Action));
  }
  return { allow, deny };
}

const deployPolicy = () => resource(BOOTSTRAP, 'DeployPolicy').Properties.PolicyDocument.Statement;
const operatorPolicy = () => JSON.parse(fs.readFileSync(path.join(root, 'scripts/aws-project-policy.json'), 'utf8')).Statement;

const allows = ({ allow, deny }, action) => allow.some((p) => matches(p, action)) && !deny.some((p) => matches(p, action));

test('the deploy role may run every AWS call the pipeline scripts make', () => {
  const policy = actions(deployPolicy());
  const calls = new Set(PIPELINE_SCRIPTS.flatMap((file) => [...cliCalls(file)]));
  assert.ok(calls.size > 20, `found only ${calls.size} calls; the scan is reading nothing`);
  const missing = [...calls].filter((call) => !NOT_CALLS.has(call)).map(actionFor).filter((action) => !allows(policy, action));
  assert.deepEqual(missing, [], `Add these to DeployPolicy in ${BOOTSTRAP}, and to scripts/aws-project-policy.json`);
});

test('the deploy role may create every resource type the stacks declare', () => {
  const policy = actions(deployPolicy());
  const templates = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(rel);
      else if (entry.name === 'cloudformation.yaml') templates.push(rel);
    }
  };
  walk('lambda');
  walk('infra');
  // A resource type's service, as IAM names it.
  const SERVICE = { ApiGatewayV2: 'apigateway', CloudWatch: 'cloudwatch', Logs: 'logs' };
  const types = new Set(templates.flatMap((t) => [...source(t).matchAll(/Type: AWS::(\w+)::(\w+)/g)].map(([, s, r]) => `${s}::${r}`)));
  const create = (type) => {
    const [service, kind] = type.split('::');
    if (type === 'IAM::Role') return 'iam:CreateRole';
    if (type === 'IAM::Policy') return 'iam:PutRolePolicy';
    if (type === 'Lambda::Permission') return 'lambda:AddPermission';
    if (type === 'SNS::Subscription') return 'sns:Subscribe';
    if (type === 'SQS::QueuePolicy') return 'sqs:SetQueueAttributes';
    if (type === 'S3::BucketPolicy') return 's3:PutBucketPolicy';
    if (type === 'Events::Rule') return 'events:PutRule';
    if (type === 'IoT::Policy') return 'iot:CreatePolicy';
    if (type === 'SSM::Parameter') return 'ssm:PutParameter';
    if (type === 'ApiGatewayV2::Api') return 'apigateway:POST';
    if (type.startsWith('ApiGatewayV2::')) return 'apigateway:POST';
    if (type === 'S3::Bucket') return 's3:CreateBucket';
    return `${SERVICE[service] || service.toLowerCase()}:Create${kind}`;
  };
  assert.ok(types.size > 15, `found only ${types.size} resource types`);
  const missing = [...types].map((type) => `${type} (${create(type)})`).filter((entry) => !allows(policy, entry.match(/\((.+)\)/)[1]));
  assert.deepEqual(missing, []);
});

test('the deploy role may attach only the AWS managed policies the stacks attach', () => {
  const statement = deployPolicy().find((s) => s.Sid === 'StackRolesManagedPolicies');
  const allowed = listOf(statement.Condition.ArnEquals['iam:PolicyARN'])
    .map((arn) => arn.replace(/^!Sub /, '').replace('${AWS::Partition}', 'aws'));
  const attached = new Set();
  for (const dir of ['lambda', 'infra']) {
    for (const name of fs.readdirSync(path.join(root, dir))) {
      const file = path.join(dir, name, 'cloudformation.yaml');
      if (!fs.existsSync(path.join(root, file))) continue;
      for (const [, arn] of source(file).matchAll(/- (arn:aws:iam::aws:policy\/\S+)/g)) attached.add(arn);
    }
  }
  assert.deepEqual([...attached].sort(), allowed.sort());
});

test('roles are created, changed and passed only by the name the stacks give them, and only to Lambda and AWS IoT', () => {
  for (const statement of deployPolicy()) {
    if (statement.Effect !== 'Allow' || !listOf(statement.Action).some((a) => a.startsWith('iam:'))) continue;
    assert.deepEqual(listOf(statement.Resource), ['!Sub arn:${AWS::Partition}:iam::${AWS::AccountId}:role/cloud-agentic-iot-*'], statement.Sid);
  }
  const pass = deployPolicy().find((s) => listOf(s.Action).includes('iam:PassRole'));
  assert.deepEqual(pass.Condition, { StringEquals: { 'iam:PassedToService': ['lambda.amazonaws.com', 'iot.amazonaws.com'] } });
});

test('the deploy role cannot touch users, billing, the GitHub provider or its own bootstrap stack', () => {
  const policy = actions(deployPolicy());
  for (const action of ['iam:CreateUser', 'iam:CreateAccessKey', 'iam:CreatePolicyVersion', 'iam:CreateOpenIDConnectProvider',
    'budgets:ModifyBudget', 'aws-portal:ModifyBilling', 'organizations:LeaveOrganization']) {
    assert.ok(!allows(policy, action), action);
  }
  const bootstrap = deployPolicy().find((s) => s.Sid === 'NotTheBootstrapStack');
  assert.equal(bootstrap.Effect, 'Deny');
  assert.match(bootstrap.Resource, /stack\/cloud-agentic-iot-bootstrap-\*\/\*$/);
});

test("iot-operator may do everything the deploy role may, and deploy the bootstrap stack", () => {
  const operator = actions(operatorPolicy());
  const deploy = actions(deployPolicy());
  const notCovered = deploy.allow.filter((action) => !allows(operator, action.replace(/\*$/, 'Anything')) && !allows(operator, action));
  assert.deepEqual(notCovered, []);
  for (const action of ['iam:CreateOpenIDConnectProvider', 'iam:CreatePolicy', 'iam:CreateRole', 'budgets:ModifyBudget',
    'iam:ListOpenIDConnectProviders']) {
    assert.ok(allows(operator, action), action);
  }
  const passRole = operatorPolicy().find((s) => listOf(s.Action).includes('iam:PassRole'));
  assert.ok(passRole.Condition && passRole.Condition.StringEquals, 'iot-operator may pass a role to any service');
});

test('the deploy role trusts this repository\'s GitHub Environment, in both subject forms, and nothing else', () => {
  const text = source(BOOTSTRAP).split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
  assert.match(text, /token\.actions\.githubusercontent\.com:aud: sts\.amazonaws\.com/);
  const subjects = [...text.matchAll(/!Sub '(repo:[^']+)'/g)].map(([, s]) => s);
  assert.deepEqual(subjects.sort(), [
    'repo:${GitHubOwner}/${GitHubRepoName}:environment:${Environment}',
    'repo:${GitHubOwner}/${GitHubRepoName}:environment:${Environment}',
    'repo:${GitHubOwner}@${GitHubOwnerId}/${GitHubRepoName}@${GitHubRepoId}:environment:${Environment}',
  ].sort());
  // A job that declares an environment never sends ref:refs/heads/<branch>.
  assert.doesNotMatch(text, /ref:refs\/heads/);
  assert.doesNotMatch(text, /StringLike/);
});

test('the budget is the one the Home page reads', () => {
  // Its notifications are an !If block, which test/helpers/template.js does
  // not read, so the budget's own lines are read as text.
  const text = source(BOOTSTRAP);
  const block = text.slice(text.indexOf('  MonthlyBudget:'), text.indexOf('NotificationsWithSubscribers'));
  const relay = source('lambda/queue-relay/cloudformation.yaml');
  const name = relay.match(/SpendLimitBudgetName:\n(?: {4}.*\n)*? {4}Default: (\S+)/)[1];
  assert.match(block, new RegExp(`BudgetName: ${name}\n`));
  assert.match(block, /BudgetType: COST\n/);
  assert.match(block, /TimeUnit: MONTHLY\n/);
  // The card wants every service counted, before credits, refunds and tax
  // (basisOf in lambda/aws-spend/index.js).
  assert.doesNotMatch(block, /CostFilters|FilterExpression/);
  for (const type of ['Credit', 'Refund', 'Tax']) assert.match(block, new RegExp(`Include${type}: false\n`));
});

test('deploy-aws.sh never deploys the bootstrap template', () => {
  assert.notEqual(path.basename(BOOTSTRAP), 'cloudformation.yaml');
  assert.match(source('scripts/deploy-aws.sh'), /find \. -name cloudformation\.yaml/);
  assert.match(source('scripts/check.sh'), /infra\/bootstrap/, 'check.sh must still lint it');
});
