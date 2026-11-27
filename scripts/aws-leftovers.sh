#!/usr/bin/env bash
#
# aws-leftovers.sh - list what is in an environment's AWS account but no
# longer in this repo: CloudFormation stacks, Thing Groups and Lambda
# functions of this project that no template declares. Read-only: it deletes
# nothing, it prints what it finds and how to remove each one.
#
#   AWS_PROFILE=test-yourname scripts/aws-leftovers.sh Dev
#
# Why: the repo keeps one current version of everything, but a resource made
# by an older template, by hand, or by a renamed stack stays in the account
# (and on the bill) until someone deletes it. Run this after a removal is
# merged and deployed, and before a recorded rebuild.

set -euo pipefail
# shellcheck source=lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

ENV="${1:-}"
check_environment "$ENV"
need aws "Install the AWS CLI v2 - see docs/SETUP.md."
cd "$REPO_ROOT"

templates=$(find . -name cloudformation.yaml -not -path "*/node_modules/*" | sort)
found=0

step "CloudFormation stacks of $PROJECT in this account that no template makes"
expected=$(for t in $templates; do stack_name "$(basename "$(dirname "$t")")" "$ENV"; echo; done
           stack_name bootstrap "$ENV"; echo)
live=$(aws cloudformation list-stacks --output text \
  --query "StackSummaries[?StackStatus!='DELETE_COMPLETE' && starts_with(StackName, '$PROJECT-') && ends_with(StackName, '-$ENV')].StackName" \
  | tr '\t' '\n' | sed '/^$/d' | sort -u)
for s in $live; do
  if ! grep -qx "$s" <<< "$expected"; then
    echo "  $s    remove: aws cloudformation delete-stack --stack-name $s"
    found=$((found + 1))
  fi
done
endstep

step "Thing Groups that infra/ota/cloudformation.yaml does not declare"
declared_groups=$(grep -h 'ThingGroupName:' infra/ota/cloudformation.yaml | sed 's/.*ThingGroupName:[[:space:]]*//' | tr -d '\r"' | sort -u)
for g in $(aws iot list-thing-groups --output text --query 'thingGroups[].groupName' | tr '\t' '\n' | sed '/^$/d' | sort -u); do
  if ! grep -qx "$g" <<< "$declared_groups"; then
    n=$(aws iot list-things-in-thing-group --thing-group-name "$g" --output text --query 'length(things)')
    echo "  $g ($n board(s) in it)    remove: aws iot delete-thing-group --thing-group-name $g"
    found=$((found + 1))
  fi
done
endstep

step "Lambda functions of $PROJECT that no template declares"
declared_fns=$(grep -rh "FunctionName: $PROJECT" --include=cloudformation.yaml . | sed 's/.*FunctionName: //' | tr -d '\r' | sort -u)
for f in $(aws lambda list-functions --output text --query "Functions[?starts_with(FunctionName, '$PROJECT-')].FunctionName" | tr '\t' '\n' | sed '/^$/d' | sort -u); do
  if ! grep -qx "$f" <<< "$declared_fns"; then
    echo "  $f    remove: aws lambda delete-function --function-name $f"
    found=$((found + 1))
  fi
done
endstep

if [ "$found" -eq 0 ]; then
  note "Nothing left over: every stack, Thing Group and function of $PROJECT in this account is one the repo makes."
else
  warn "$found leftover(s) above. Check each is unused before you remove it; nothing was deleted."
fi
