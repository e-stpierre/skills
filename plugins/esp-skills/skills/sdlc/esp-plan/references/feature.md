# Feature Plan Reference

## Plan Sections

A feature plan follows [plan format 1](../../../../references/plan-format.md). Use these context sections between `## Overview` and `## Milestones`:

- `## Requirements`: functional and non-functional requirements (performance, security, UX)
- `## Architecture`: high-level design, the existing patterns it follows, integration points, data models and API shapes, and the key technical decisions
- `## Testing Strategy`: the unit, integration and end-to-end coverage the milestones add

Put feature-level validation in the acceptance criteria of the last milestone that completes it.

## Requirements Questions

Settle each one while gathering requirements:

- The feature title and overview
- Functional requirements (what it should do)
- Non-functional requirements (performance, security, etc.)
- User experience expectations
- Technical constraints
- Integration points with existing systems

## Architecture Considerations

- Reuse the codebase's existing components
- Define data models and API shapes at the integration points
- Design for the stated requirements, with extensibility only where they call for it

## Milestone Design

- Each milestone delivers visible progress and is testable on its own
- Typically 2-5 milestones per feature
- Write tasks as specific, actionable steps with the file paths they change, and put the tests beside the implementation they cover

- Give every milestone objective acceptance criteria the verifier can confirm; a milestone whose outcome cannot be checked is folded into another one
- Put documentation in the milestone whose behavior it describes, not in a separate documentation milestone
- Plan polish or optimization only as concrete, verifiable changes (a named fix, a measured target), never as an open-ended milestone

Common milestone patterns:

1. Core infrastructure and data models
2. Basic functionality (happy path)
3. Edge cases and error handling
