# Security Analysis Reference

## Analysis Criteria

Check for these issues, grouped by the OWASP Top 10 (2025 edition) category each one maps to:

- **Access control (A01)**: missing authorization checks, IDOR, path traversal, CORS misconfigurations, SSRF
- **Configuration (A02)**: debug mode in production, insecure defaults, missing security headers
- **Supply chain (A03)**: known vulnerable, outdated, or unused but risky dependencies
- **Cryptography and data exposure (A04)**: weak crypto, secrets in code or config, insecure data transmission or storage
- **Injection (A05)**: SQL, command, template and XSS injection
- **Design (A06)**: logic flaws and missing security requirements
- **Authentication (A07)**: hardcoded credentials, weak authentication, session management issues, insecure token storage
- **Integrity (A08)**: insecure deserialization, unsigned or unverified data and updates
- **Logging and errors (A09, A10)**: sensitive data in logs, missing security logs, improper error messages, failing open on exceptional conditions

## Core Principles

- Rate by real exploitability and impact: verify exploitability before rating Critical or High, reserve Critical for what the severity guidelines define, and weigh defense in depth
- Name the exact vulnerability type and its exploitation scenario

## Severity Guidelines

- **Critical**: Actively exploitable, high impact
- **High**: Exploitable with some conditions
- **Medium**: Potential risk, limited impact
- **Low**: Best practice violation, minimal risk

## Report Template

```markdown
# Security Analysis

**Date**: {{date}}

<!--
Instructions:
- Replace {{date}} with the analysis date in YYYY-MM-DD format
-->

**Scope**: {{scope}}

<!--
Instructions:
- Replace {{scope}} with description of what was analyzed
- Example: "Entire codebase" or "Authentication and API modules"
-->

## Summary

| Risk Level | Issues             |
| ---------- | ------------------ |
| Critical   | {{critical_count}} |
| High       | {{high_count}}     |
| Medium     | {{medium_count}}   |
| Low        | {{low_count}}      |

<!--
Instructions:
- Replace {{critical_count}}, {{high_count}}, {{medium_count}}, {{low_count}} with actual counts
- Write "0" for an empty severity
-->

## Critical Vulnerabilities

### SEC-{{vuln_number}}: {{vuln_title}}

<!--
Instructions:
- Replace {{vuln_number}} with sequential number (001, 002, etc.)
- Replace {{vuln_title}} with concise vulnerability title
- Use this format for each critical vulnerability found
-->

**Location:** {{location}}

<!--
Instructions:
- Replace {{location}} with code location or dependency
- Format: file:line (e.g., "src/auth/login.ts:78") or "dependency: package@version"
-->

**Vulnerability:** {{vulnerability_description}}

<!--
Instructions:
- Replace {{vulnerability_description}} with vulnerability type and description
- Include CWE number if applicable (e.g., "SQL Injection (CWE-89)")
- Explain what makes this exploitable
-->

**Risk:** {{risk_impact}}

<!--
Instructions:
- Replace {{risk_impact}} with potential impact if exploited
- Focus on concrete consequences (data breach, unauthorized access, etc.)
-->

**Remediation:** {{remediation}}

<!--
Instructions:
- Replace {{remediation}} with specific fix approach
- Be actionable and include code examples if helpful
-->

**References:** {{references}}

<!--
Instructions:
- Replace {{references}} with CWE/OWASP links if applicable
- Example: "CWE-89: https://cwe.mitre.org/data/definitions/89.html"
- Use "N/A" if no specific references apply
-->

---

## High Risk

<!--
Instructions:
- Use same format as Critical Vulnerabilities section
- Include all high-risk security issues
-->

## Medium Risk

<!--
Instructions:
- Use same format as Critical Vulnerabilities section
- Include all medium-risk security issues
-->

## Low Risk

<!--
Instructions:
- Use same format as Critical Vulnerabilities section
- Include all low-risk security issues
-->
```
