#!/bin/bash
# Scaffolds a new chapter with structure the CI pipelines accept.
#
# A chapter is a DIRECTORY under content/, not a branch. All code lives on Dev
# in the one shared layout (force-app/, lambda/, firmware/); only the prose is
# namespaced per chapter. There is no per-chapter README — the root README.md
# carries every chapter's description and deploy steps in one place.
#
# The generated layout deliberately satisfies every convention documented in
# docs/CI-CD-SECRETS.md — .cls-meta.xml alongside every class, a Lambda Code
# property, sketch folders named after their .ino. Hand-rolling a chapter
# instead of using this script is how those get missed, and they fail at deploy
# time rather than at author time.
#
# Usage: ./scripts/chapter-setup.sh <chapter-slug> <topic-title>
# Example: ./scripts/chapter-setup.sh 14-agent-observability 'Agent Observability'

set -euo pipefail

CHAPTER="${1:-}"
TOPIC="${2:-}"

if [ -z "$CHAPTER" ] || [ -z "$TOPIC" ]; then
    echo "Usage: ./scripts/chapter-setup.sh <chapter-slug> <topic-title>"
    echo "Example: ./scripts/chapter-setup.sh 14-agent-observability 'Agent Observability'"
    exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if [ -d "content/$CHAPTER" ]; then
    echo "Error: content/$CHAPTER/ already exists. Refusing to overwrite."
    exit 1
fi

echo "Scaffolding $CHAPTER — $TOPIC"

# Code goes in the one standard location shared by every chapter; only the
# prose is namespaced, because every chapter has its own BLOG/LINKEDIN/VIDEO.
mkdir -p force-app/main/default/classes
mkdir -p force-app/main/default/objects
mkdir -p force-app/main/default/triggers
mkdir -p lambda
mkdir -p firmware
mkdir -p "content/$CHAPTER"

cat > "content/$CHAPTER/ARCHITECTURE.md" <<EOF
# Architecture: $TOPIC

## System Diagram

\`\`\`mermaid
graph TB
    subgraph Edge
        A[ESP32 Device]
    end

    subgraph AWS
        B[AWS IoT Core]
        C[Lambda]
    end

    subgraph Salesforce
        D[Platform Event]
        E[Agentforce]
    end

    A -->|MQTT over mTLS| B
    B --> C
    C --> D
    D --> E
\`\`\`

## Components

| Component | Purpose | Technology |
|-----------|---------|------------|
| [name] | [what it does] | [tech] |

## Security

- [How is this authenticated? Prefer SigV4/JWT/mTLS over shared secrets.]
- [What is the least-privilege boundary?]
EOF

cat > "content/$CHAPTER/LINKEDIN.md" <<EOF
# $TOPIC

[Hook: one concrete sentence. What visibly happens?]

[Problem: 2-3 sentences on why the obvious approach fails.]

[Solution: what you built, with one short code snippet that shows the
interesting decision — not boilerplate.]

**What this enables:**
- [Capability 1]
- [Capability 2]
- [Capability 3]

[One honest note: a constraint you hit, or something that did not work first
time. This is the part that reads as real.]

Full implementation in the repo — see the "$TOPIC" chapter in the README.

#Salesforce #AWS #Agentforce #CloudAgenticIoT
EOF

cat > "content/$CHAPTER/BLOG.md" <<EOF
# $TOPIC: A Deep Dive

## Introduction

[What problem, and why the naive approach falls over.]

## Architecture Overview

\`\`\`mermaid
graph LR
    A[Source] --> B[Processing] --> C[Target]
\`\`\`

## Technical Walkthrough

### Step 1: [name]

[Explain, with code.]

### Step 2: [name]

[Explain, with code.]

## Production Considerations

- **Scaling**: [notes]
- **Security**: [notes]
- **Failure isolation**: [what happens when the downstream is unavailable?]
- **Monitoring**: [how would you know this broke?]

## Lessons Learned

1. [Something that genuinely surprised you]
2. [A constraint you had to design around]
3. [Something you would do differently]

## Resources

- The "$TOPIC" chapter in the repo README
- [Related chapters this builds on]
EOF

cat > "content/$CHAPTER/VIDEO.md" <<EOF
# Video Script: $TOPIC

[0:00-0:20] HOOK
"[Show the result first. What moves, changes, or appears?]"

[0:20-1:30] ARCHITECTURE
"[Walk the diagram. Name each hop and why it exists.]"

[1:30-2:45] CODE
"[Show the one decision that mattered, not a file tour.]"

[2:45-3:30] THE PART THAT DIDN'T WORK
"[Keep one real failure and its fix. This is the credibility beat —
see docs/CONTENT-GUIDE.md.]"

[3:30-4:00] CLOSE
"Full code in the repo. Link in the first comment."

## Shot list
- [ ] [Result shot, single unbroken take]
- [ ] [Screen: the key code]
- [ ] [Screen: it running / logs]
- [ ] [The failure shot]
EOF

cat <<EOF

Scaffolded $CHAPTER
  content/$CHAPTER/{ARCHITECTURE,BLOG,LINKEDIN,VIDEO}.md
  force-app/main/default/{classes,objects,triggers}/   (shared standard layout)
  lambda/ firmware/

Conventions the CI pipelines enforce (docs/CI-CD-SECRETS.md):
  - every .cls needs a matching .cls-meta.xml
  - code lives in force-app/ | lambda/ | firmware/, prose in content/<chapter>/
  - Lambda FunctionName must be cloud-agentic-iot-<source directory name>
  - every AWS::Lambda::Function needs a Code property
  - a sketch folder must contain a .ino named after the folder

Next:
  1. Add a "### $TOPIC" section to README.md under "The chapters" —
     what it demonstrates, key files, and its deploy steps.
  2. Build it on Dev. Push; the pipelines deploy AWS and Salesforce.
  3. Once verified for real, promote Dev -> Prod.
EOF
