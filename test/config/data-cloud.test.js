'use strict';

// What Data Cloud may do in AWS (docs/DATA-CLOUD.md): read the CSV copy of
// the readings under datacloud/ in the archive bucket, as a role in a regular
// account or as a hand-made IAM user in a spend-limited AWS project, and
// nothing else. A wider grant would still work, so nothing at run time would
// say it had grown; these checks do. They also keep the folder the function
// writes, the folder the grants name and the folder the docs give Data Cloud
// the same.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { resources, source } = require('../helpers/template');

const root = path.join(__dirname, '../..');
const TEMPLATE = 'lambda/patient-vitals/cloudformation.yaml';
const template = source(TEMPLATE);
const body = (name) => {
  const lines = resources(TEMPLATE).get(name);
  assert.ok(lines, `${TEMPLATE} declares no resource ${name}`);
  return lines.join('\n');
};
const spec = require('../../datacloud/room-readings.columns.json');

const FOLDER = 'datacloud/room-readings/';
const READER_ACTIONS = ['s3:GetBucketLocation', 's3:GetObject', 's3:ListBucket'];

/** Every cloudformation.yaml in the repo, and the bootstrap template. */
function templates() {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory() && !['node_modules', '.git'].includes(entry.name)) walk(rel);
      else if (entry.name === 'cloudformation.yaml' || rel.startsWith(path.join('infra', 'bootstrap'))) found.push(rel);
    }
  };
  walk('lambda');
  walk('infra');
  return found;
}

test('no template creates an IAM user or an access key', () => {
  for (const file of templates()) {
    assert.doesNotMatch(source(file), /Type: AWS::IAM::(User|AccessKey)\b/, file);
  }
});

test('the function writes the CSV copy into the folder the column file gives Data Cloud', () => {
  assert.match(template, new RegExp(`DATA_CLOUD_EXPORT_PREFIX: !If \\[DataCloudExportOn, '${FOLDER}', ''\\]`));
  assert.equal(spec.file.folder, FOLDER);
  assert.match(body('PatientVitalsLambdaRole'), new RegExp(`- !Sub '\\$\\{ArchiveBucket.Arn\\}/${FOLDER}\\*'`));
});

test('the CSV copy expires on its own schedule, apart from the archive', () => {
  const bucket = body('ArchiveBucket');
  assert.match(bucket, /- Id: expire-data-cloud-copy\n\s+Status: Enabled\n\s+Prefix: datacloud\/\n\s+ExpirationInDays: !Ref DataCloudExportRetentionDays/);
  assert.match(bucket, /Prefix: readings\/\n\s+ExpirationInDays: !Ref ArchiveRetentionDays/);
});

test('by default nothing outside the account can read the bucket and no copy is written', () => {
  const parameter = (name) => template.match(new RegExp(`\\n  ${name}:\\n((?: {4}.*\\n)+)`))[1];
  assert.match(parameter('DataCloudExport'), /Default: 'false'/);
  for (const name of ['DataCloudOidcProviderArn', 'DataCloudExternalId', 'DataCloudReaderUserName']) {
    assert.match(parameter(name), /Default: ''/, name);
  }
  assert.match(body('DataCloudReaderRole'), /^ {4}Condition: HasDataCloudRole$/m);
  assert.match(template, /DataCloudReaderRoleArn:\n\s+Condition: HasDataCloudRole/);
});

test('the reader user may find the bucket, list datacloud/ and read it, and nothing more', () => {
  const policy = body('ArchiveBucketPolicy');
  const statements = policy.split(/\n {10}- /).slice(1);
  const reader = statements.filter((s) => s.includes('DataCloudReaderUserName'));
  assert.equal(reader.length, 3, 'one statement per action');
  for (const statement of reader) {
    assert.match(statement, /^!If\n\s+- HasDataCloudReaderUser\n/);
    assert.match(statement, /- !Ref AWS::NoValue$/);
    assert.match(statement, /Effect: Allow/);
    assert.match(statement, /AWS: !Sub 'arn:\$\{AWS::Partition\}:iam::\$\{AWS::AccountId\}:user\/\$\{DataCloudReaderUserName\}'/);
    assert.doesNotMatch(statement, /readings\//);
  }
  assert.deepEqual(reader.map((s) => s.match(/Action: (\S+)/)[1]).sort(), READER_ACTIONS);
  const by = (action) => reader.find((s) => s.includes(`Action: ${action}`));
  assert.match(by('s3:GetObject'), /Resource: !Sub '\$\{ArchiveBucket.Arn\}\/datacloud\/\*'/);
  assert.match(by('s3:ListBucket'), /StringLike:\n\s+s3:prefix: 'datacloud\/\*'/);
  // The TLS-only deny still covers every request, Data Cloud's included.
  assert.match(policy, /Sid: TlsOnly\n\s+Effect: Deny/);
});

test('the reader role may do the same three things, in the same folder', () => {
  const role = body('DataCloudReaderRole');
  const policies = role.slice(role.indexOf('Policies:'));
  const actions = [...policies.matchAll(/Action: (\S+)/g)].map((m) => m[1]).sort();
  assert.deepEqual(actions, READER_ACTIONS);
  assert.match(policies, /Action: s3:GetObject\n\s+Resource: !Sub '\$\{ArchiveBucket.Arn\}\/datacloud\/\*'/);
  assert.match(policies, /Action: s3:ListBucket\n\s+Resource: !GetAtt ArchiveBucket.Arn\n\s+Condition:\n\s+StringLike:\n\s+s3:prefix: 'datacloud\/\*'/);
  assert.doesNotMatch(policies, /readings\/|Put|Delete|Resource: '\*'/);
  // The deploy role may create and change only roles named this way.
  assert.match(role, /RoleName: cloud-agentic-iot-data-cloud-reader\n/);
});

test("the reader role trusts one Data Cloud connection, through the org's own identity provider", () => {
  const role = body('DataCloudReaderRole');
  const json = role.match(/AssumeRolePolicyDocument: !Sub\n\s+- \|\n([\s\S]+?)\n\s+- Issuer: (.+)\n/);
  assert.ok(json, 'the trust policy is JSON text under !Sub, then the Issuer variable');
  assert.equal(json[2], "!Select [1, !Split [':oidc-provider/', !Ref DataCloudOidcProviderArn]]");

  // What CloudFormation makes of it, for a provider and a connection.
  const provider = 'arn:aws:iam::111122223333:oidc-provider/example.my.salesforce.com/services/connectors';
  const values = {
    DataCloudOidcProviderArn: provider,
    DataCloudExternalId: 'app:0000AAAA:1111BBBB',
    Issuer: provider.split(':oidc-provider/')[1],
  };
  const text = json[1].replace(/\$\{(\w+)\}/g, (match, name) => {
    assert.ok(Object.hasOwn(values, name), `the trust policy uses \${${name}}, which nothing sets`);
    return values[name];
  });
  const document = JSON.parse(text);
  assert.deepEqual(document, {
    Version: '2012-10-17',
    Statement: [{
      Effect: 'Allow',
      Principal: { Federated: provider },
      Action: 'sts:AssumeRoleWithWebIdentity',
      Condition: { StringEquals: { 'example.my.salesforce.com/services/connectors:sub': 'app:0000AAAA:1111BBBB' } },
    }],
  });
});

test('the provider parameter takes only an org connector provider, and the user parameter only an IAM user name', () => {
  const pattern = (name) => new RegExp(
    template.match(new RegExp(`\\n  ${name}:\\n(?: {4}.*\\n)*? {4}AllowedPattern: '([^']+)'`))[1],
  );
  const provider = pattern('DataCloudOidcProviderArn');
  assert.match('', provider);
  assert.match('arn:aws:iam::111122223333:oidc-provider/example.my.salesforce.com/services/connectors', provider);
  assert.doesNotMatch('arn:aws:iam::111122223333:oidc-provider/token.actions.githubusercontent.com', provider);
  const user = pattern('DataCloudReaderUserName');
  assert.match('cloud-agentic-iot-data-cloud-reader', user);
  assert.doesNotMatch('reader/../admin', user);
  assert.doesNotMatch('a b', user);
});

test('the names Data Cloud reads as stay out of config/<env>.json, which is public', () => {
  for (const env of ['Dev', 'Prod']) {
    const settings = require(`../../config/${env}.json`).stacks['patient-vitals'];
    for (const name of ['DataCloudOidcProviderArn', 'DataCloudExternalId', 'DataCloudReaderUserName']) {
      assert.equal(Object.hasOwn(settings, name), false, `${env}: ${name} comes from the environment (scripts/deploy-aws.sh)`);
    }
  }
  const deploy = source('scripts/deploy-aws.sh');
  for (const pair of ['DATA_CLOUD_OIDC_PROVIDER_ARN=DataCloudOidcProviderArn', 'DATA_CLOUD_EXTERNAL_ID=DataCloudExternalId',
    'DATA_CLOUD_READER_USER=DataCloudReaderUserName']) {
    assert.ok(deploy.includes(pair), `scripts/deploy-aws.sh must pass ${pair}`);
  }
});
