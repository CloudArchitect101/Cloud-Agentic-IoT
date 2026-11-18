#!/usr/bin/env node
'use strict';

/*
 * stack-parameters.js <Dev|Prod> <path/to/cloudformation.yaml>
 *
 * Prints one stack's parameter overrides, one Key=Value per line, from the
 * stacks.<name> section of config/<env>.json, where <name> is the template's
 * directory: the name scripts/deploy-aws.sh deploys it under. Prints nothing
 * for a stack the file does not mention, so the template's defaults apply.
 *
 * Fails, naming the key, when the section sets a parameter the template does
 * not declare. CloudFormation would refuse such an override anyway, but only
 * after the deploy had started; a typo is cheaper to find here.
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '../..');

/** The names in a template's Parameters block. Templates here indent by two spaces. */
function declaredParameters(templateText) {
  const names = [];
  let inParameters = false;
  for (const line of templateText.split(/\r?\n/)) {
    if (/^Parameters:\s*$/.test(line)) {
      inParameters = true;
      continue;
    }
    if (inParameters && /^\S/.test(line) && !line.startsWith('#')) break;   // the next top-level key
    const match = inParameters && line.match(/^ {2}([A-Za-z0-9]+):\s*$/);
    if (match) names.push(match[1]);
  }
  return names;
}

function loadConfig(env) {
  const file = path.join(REPO_ROOT, 'config', `${env}.json`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function overridesFor(env, templatePath) {
  const stack = path.basename(path.dirname(path.resolve(templatePath)));
  const settings = (loadConfig(env).stacks || {})[stack] || {};
  const declared = new Set(declaredParameters(fs.readFileSync(templatePath, 'utf8')));
  const unknown = Object.keys(settings).filter((key) => !declared.has(key));
  if (unknown.length) {
    throw new Error(`config/${env}.json sets ${unknown.join(', ')} for "${stack}", but ${templatePath} declares no such parameter.`);
  }
  return Object.entries(settings).map(([key, value]) => {
    if (value === null || typeof value === 'object') {
      throw new Error(`config/${env}.json: ${stack}.${key} must be a string, number or boolean.`);
    }
    return `${key}=${value}`;
  });
}

module.exports = { declaredParameters, loadConfig, overridesFor };

if (require.main === module) {
  const [env, templatePath] = process.argv.slice(2);
  if (!env || !templatePath) {
    console.error('usage: stack-parameters.js <Dev|Prod> <path/to/cloudformation.yaml>');
    process.exit(2);
  }
  try {
    for (const line of overridesFor(env, templatePath)) console.log(line);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
