# Retag employee IDs by company

One-time migration: set existing employee IDs to `VEGA-HR-#####` or `NNIT-HR-#####` from the linked company name. The numeric suffix is kept; only the prefix changes.

## Rules

| Company name | Prefix |
|---|---|
| Contains `vega` | `VEGA-HR-` |
| Contains `nnit` / Neoron Nexus | `NNIT-HR-` |
| Other / unknown | `VEGA-HR-` (fallback) |

- Placeholder `VEGA-HR-0000` (company party) is never changed.
- If the target ID already exists → **conflict** (skipped, reported).
- Shared prefix helper: [`../utils/employeeIdPrefix.js`](../utils/employeeIdPrefix.js)

## Commands (from `VERP_backend`)

```bash
# Dry-run (default) — no writes
node scripts/retagEmployeeIdsByCompany.js
npm run retag-employee-ids

# Apply DB + S3 document prefix rename
node scripts/retagEmployeeIdsByCompany.js --apply
npm run retag-employee-ids -- --apply

# Apply DB only (leave S3 keys under old employeeId path)
node scripts/retagEmployeeIdsByCompany.js --apply --skip-s3
```

## Before apply

1. Backup MongoDB.
2. Note S3/IDrive bucket (employee-documents/).
3. Run dry-run and review `conflict` rows.

## After apply — spot-check

1. Login as a retagged employee.
2. Open their profile; confirm documents still open.
3. Open one Fine / Reward / Loan for that employee.
4. Dashboard inbox (assignee / subject employee ids).
5. Add Employee → pick Vega company and NNIT company; confirm next IDs use the right prefix.
