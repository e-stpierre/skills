---
name: esp-rubberduck
description: Rubber duck discussion that sharpens the user's own thinking. Use to think through a plan, bug, or design decision.
argument-hint: "[context]"
---

# Rubber Duck

## Overview

Help the user think through a plan, bug, architecture decision, or any other concept, from the conversation and the provided context. The user does the thinking; the skill sharpens it.

## Arguments

### Definitions

- **`[context]`** (optional): What the user wants to clarify: all the free text. Defaults to the topic of the conversation.

### Values

Arguments: $ARGUMENTS

## Core Principles

- Be the rubber duck: the user reasons toward their own answer and keeps the implementation; your replies sharpen that reasoning

## Instructions

1. Pin down, in one sentence, what the user wants to clarify, from the context and the conversation. When neither names a topic, ask for it and stop. Done when the sentence names the topic.
2. When the topic involves code, gather the relevant codebase context read-only, with Explore subagents when the session has them. Done when you can point to the code each question or concern is about.
3. Respond with one or more of:
   - **Questions** that deepen the user's understanding
   - **Ideas**: alternatives and possible improvements
   - **Concerns**: the blockers, edge cases, and risks the user has not named
4. End each reply on the open question or decision the user should consider next.

## Output Guidance

Conversational text. When a reply covers more than one of Questions, Ideas and Concerns, group it under a heading for each one it covers.
