# Project Management Process

This document standardizes how work is planned, implemented, reviewed, released, and monitored in `bugspotter-mcp`.

## Scope

Applies to:
- Product/use-case changes
- Bug fixes and incidents
- Documentation and operational improvements

## Workflow Overview

1. **Intake**
   - Capture request/bug with clear context, impact, and environment.
   - Prefer reproducible examples (input, expected output, actual output, timestamps).
2. **Triage**
   - Classify by type: feature, bug, incident, docs, tech debt.
   - Set priority based on impact and urgency.
3. **Design Alignment**
   - Validate against `docs/use-cases.md` and `docs/architecture.md`.
   - Identify API/functionality implications and backward-compatibility risks.
4. **Implementation**
   - Implement changes in `src/` with focused scope.
   - Add/update tests in `tests/`.
5. **Verification**
   - Run local checks (lint/tests/husky hooks).
   - Ensure CI in `.github/workflows/` passes.
6. **Release**
   - Deploy via existing deployment process (`deploy/`, `Dockerfile`, `fly.toml`).
   - Record noteworthy changes in release notes/changelog process.
7. **Post-Release Monitoring**
   - Use behavioral logging guidance in `docs/behavioral-logs.md`.
   - Track regressions and incident follow-ups.

## Roles and Responsibilities

- **Reporter**
  - Provides problem statement, environment, timestamp, expected vs actual behavior.
- **Maintainer/Engineer**
  - Reproduces issue, proposes fix, adds tests, ensures documentation updates.
- **Reviewer**
  - Validates design fit, test coverage, operational risks, and doc quality.
- **Release Owner**
  - Coordinates deploy timing, rollback readiness, and production verification.

## Issue and Incident Lifecycle

### Minimum Issue Template

- Title
- Reporter
- Date/time observed (UTC preferred)
- Environment (production/staging/local)
- Affected function/tool
- Expected behavior
- Actual behavior
- Reproduction steps (or reason unavailable)
- Impact

### Incident Severity (suggested)

- **SEV-1**: Service unavailable or critical customer impact
- **SEV-2**: Major function degraded (timeouts/high error rates)
- **SEV-3**: Partial degradation/workaround exists
- **SEV-4**: Minor defect/docs inconsistency

### Timeout Incident Playbook (e.g., `search_bugs`)

1. Confirm timeout scope (single request vs broad pattern).
2. Capture request filters/pagination and timeout threshold.
3. Correlate with logs/metrics around reported timestamp.
4. Test narrowed query and baseline performance.
5. Mitigate (query optimization, pagination limits, caching, guardrails).
6. Add regression tests and update troubleshooting docs.

## Definition of Ready (DoR)

Work item is ready when:
- Problem and business/user impact are clear
- Acceptance criteria are defined
- Dependencies/risks identified
- Required environments and test data are known

## Definition of Done (DoD)

Work item is done when:
- Code implemented and reviewed
- Tests added/updated and passing
- CI passes
- Relevant docs updated (`README.md` and/or `docs/*`)
- Deployment verified in target environment
- Monitoring/rollback notes prepared for risky changes

## Documentation Update Policy

Update docs in the same PR when behavior changes:
- **User-facing behavior** → `README.md`, `docs/use-cases.md`
- **Architecture/flow changes** → `docs/architecture.md`
- **Operational changes** → `docs/troubleshooting.md`, `docs/behavioral-logs.md`

## Release and Change Management

- Prefer small, reversible changes.
- Use feature flags/config guards when feasible.
- Define rollback plan before production deploy.
- Verify key MCP operations after release (smoke checks).

## Metrics and Review Cadence

Track at minimum:
- Open defects by severity
- Mean time to acknowledge (MTTA)
- Mean time to resolve (MTTR)
- Timeout/error rate for core operations (e.g., `search_bugs`)
- Change failure rate

Suggested cadence:
- Weekly: triage and defect review
- Bi-weekly: process retrospective
- Monthly: documentation and runbook audit

## PR Checklist (recommended)

- [ ] Scope and acceptance criteria are clear
- [ ] Tests cover new/changed behavior
- [ ] CI is green
- [ ] Docs updated where needed
- [ ] Operational impact and rollback considered
