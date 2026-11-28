---
name: esp-qna
description: Read-only answer to a question. Use when the user asks about the code or a concept and wants no changes made.
argument-hint: "<question>"
---

# Q&A

## Overview

Answer a question about the code or a concept directly, leaving the codebase, the files and the environment exactly as they were.

## Arguments

### Definitions

- **`<question>`** (required): The question to answer: all the free text.

### Values

Arguments: $ARGUMENTS

If the line above holds no arguments or an unreplaced placeholder, read them from the message that invoked this skill.

## Core Principles

- Read-only: gather context by reading files, searching the code and running read-only commands. When the answer calls for an edit, a new file, or a command with side effects, describe it in the answer and leave it undone

## Instructions

1. When the answer depends on the code, gather context read-only until every claim in the answer is backed by a file or line you read.
2. Answer the question. Done when the first sentence answers it and each claim about the code names the file it comes from.

## Output Guidance

A direct text answer, as brief as the question allows: the answer first, then its support, with an example when it clarifies.
