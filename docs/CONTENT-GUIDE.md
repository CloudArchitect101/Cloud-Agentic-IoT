# Content Writing Guide

## Audience calibration — read this before writing anything

The author (and much of the audience) is a **strong generalist who is junior on Apex/LWC** — Python-first, 20 Salesforce certs on the declarative/architecture track, newer to hands-on platform code. Every piece must hold at that level:

1. **Define every Salesforce-ism on first use**, every time — SOQL, DML, governor limits, bulkification, org, `@InvocableMethod`. Assume the reader is a competent programmer who has never touched Salesforce.
2. **Every Apex/LWC snippet gets a plain-English sentence** saying what it does, and — where it genuinely clarifies — a Python analogy: `@future` ≈ a Celery task, a trigger ≈ a Django signal, a Platform Event ≈ a Kafka topic, `with sharing` ≈ ORM-enforced row security.
3. **Link `docs/PLATFORM-PRIMER.md`** instead of re-explaining fundamentals; explain inline only what this specific piece adds.
4. **Never write above the author's ability to defend it live.** If a paragraph would be hard to expand on when an reviewer says "tell me more", simplify it until it wouldn't be. Authenticity beats sophistication.
5. **Code comments in this repo are teaching comments by design.** The repo *is* the tutorial, so comments explain the platform concept in play ("one DML for the batch, because limits count statements, not rows"), not just local intent. This is a deliberate exception to the usual keep-comments-minimal rule.
6. Videos: narrate what the viewer is looking at before why it matters — they cannot re-read a paragraph.

## LinkedIn Articles

**Audience**: Salesforce practitioners and technical leaders, fellow professionals
**Length**: ~800 words
**Tone**: Technical but accessible

### Structure
1. **Hook** (1-2 sentences): Start with a healthcare AI challenge
2. **Problem** (3-4 sentences): Explain the data challenge
3. **Solution** (5-7 sentences): Describe your approach with a code snippet
4. **Results** (3 bullet points): What this enables
5. **CTA** (1 sentence): "Check the repo for full implementation"

### Template
```markdown
# [Topic Title]

[Hook: A compelling opening about the healthcare AI challenge]

The problem is [explain the challenge in healthcare context].

My solution: [describe approach]

```python
# Key code snippet
```

**What this enables:**
- [Benefit 1]
- [Benefit 2]
- [Benefit 3]

[CTA: Link to the repo]

#Salesforce #Agentforce #DataCloud #AI #Healthcare #AgenticData
```

## Blog Posts

**Audience**: Technical audience, Salesforce developers, AI enthusiasts
**Length**: ~1500 words
**Tone**: Deep technical dive

### Structure
1. **Introduction**: What this topic is and why it matters
2. **Architecture Overview**: How the pieces fit together
3. **Technical Deep-Dive**: Step-by-step code walkthrough
4. **Production Considerations**: Scaling, security, compliance
5. **Lessons Learned**: What you discovered
6. **References**: Links to docs and code

### Template
```markdown
# [Topic Title]: A Deep Dive

## Introduction

[Set the context - what problem we're solving]

## Architecture Overview

```mermaid
graph TB
  [diagram]
```

## Technical Walkthrough

### [Sub-step 1]
[Code explanation]

### [Sub-step 2]
[Code explanation]

## Production Considerations

[Scaling, security, compliance notes]

## Lessons Learned

[Insights gained]

## Resources

- [Link to the repo]
- [Link to architecture diagram]
- [Related articles]
```

## Video Scripts

**Audience**: Visual learners, technical readers who watch portfolio videos
**Length**: 2-3 minutes
**Format**: Outline with timing cues

### Structure
- **0:00-0:15** Hook: "In this video, I'll show you how to..."
- **0:15-1:00** Demo walkthrough: Walk through the code/architecture
- **1:00-2:00** Code explanation: Key technical concepts
- **2:00-2:30** Results: What this enables
- **2:30-2:45** CTA: "Full code in the repo"

### Template
```
[0:00-0:15] HOOK
"In this video, I'll show you how to build a RAG pipeline
that turns patient IoT data into actionable AI context."

[0:15-1:00] DEMO
"Here's the architecture... [point to diagram]
The data flows from wearable devices through AWS IoT Core
into Data Cloud, where it gets chunked and embedded."

[1:00-2:00] CODE
"Let's look at the key code... [show Lambda handler]
This is where the magic happens - we're using Bedrock
to generate embeddings for each data chunk."

[2:00-2:30] RESULTS
"This enables agents to... [list capabilities]
The agent can now make context-aware decisions
about patient care."

[2:30-2:45] CTA
"Full implementation is in the repo - link in description."
```

## Video Production & Tone

**Toolchain (keep it simple)**:
- OBS Studio (free) for screen recording — one scene for code/console, one for the architecture diagram
- Phone on a cheap tripod for hardware shots (ESP32, servo moving) — B-roll cut in later
- CapCut or Descript for editing: cuts, captions, and zoom-ins only. Auto-captions always (LinkedIn plays muted by default)
- Effects budget: zoom-in on the line of code that matters, a highlight box, captions. Nothing animated beyond that — realistic beats flashy

**Tone**: competent practitioner who doesn't take himself too seriously. Max 1–2 jokes per video, dry and professional, placed at natural beats (usually right after something works). The humor style, by example:
- ESP32: "This chip costs eight dollars. It's about to have a conversation with a CRM company worth three hundred billion."
- Git: "There's a Dev branch and a Prod branch, because 'it works on my machine' is not a release management strategy."
- AWS IAM: "The device gets a least-privilege policy. It can publish telemetry and receive commands. That's it. It cannot, unlike some consultants I've met, request admin access."
- Salesforce: "Yes, we made a custom object for that. There is always a custom object for that."
- Debugging beat (when something fails on camera — keep it in): "And this is the part every tutorial edits out. We're leaving it in."

That last one is a deliberate strategy, not just a joke: showing one real failure + fix per video is the strongest authenticity signal available, and it's exactly what a Forward Deployed Engineer does all day.

## Cross-Posting Strategy

1. **LinkedIn**: Post the LinkedIn article directly (shorter, more accessible)
2. **Blog**: Post the full blog post on your personal blog / Medium
3. **Video**: Record the video following the script outline, embed in blog post
4. **GitHub**: All content lives in the repo for transparency

## Writing Order

For each chapter, write in this sequence:
1. **LinkedIn article first** - gets the core message clear
2. **Blog post second** - expands with technical depth
3. **Video script third** - identifies visual moments from the blog
