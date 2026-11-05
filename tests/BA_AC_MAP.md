# BA MVP v1.2 — Acceptance criteria test map

Automated tests run via `npm test` (Node test runner). Browser/mobile manual checks are **not** part of CI unless noted.

| AC | Description | Automated test(s) | Manual / partial |
|----|-------------|-------------------|------------------|
| AC01 | 1:1 interval overlap | `ba-ac.test.mjs` one-to-one; HTTP workflow | Class conversion edge cases |
| AC02 | Parent links | `ba-ac.test.mjs` roster | Full bidirectional lookup UI |
| AC03 | Recurring preview/apply | `ba-ac.test.mjs`, `ba-http-ac.test.mjs`, `ba-batch-d.test.mjs` (invalid preview HTTP) | Schedule UI overlap confirm |
| AC04 | Adhoc session | `ba-ac.test.mjs` HTTP workflow | Adhoc form UX |
| AC05 | Reschedule + reminder revision | `ba-ac.test.mjs`, `ba-http-ac.test.mjs`, `ba-batch-d.test.mjs` (cancel/reason HTTP) | Session detail UI |
| AC06 | Cancelled no attendance | `ba-ac.test.mjs`, `ba-batch-d.test.mjs` (cancelled read preserved) | Cancelled attendance readonly UI |
| AC07 | Unmarked separate | `ba-ac.test.mjs` report | — |
| AC08 | Catalog deactivate | `ba-ac.test.mjs` catalog | Catalog management UI |
| AC09 | Late minutes | `ba-ac.test.mjs` minutes | — |
| AC10 | Attendance audit | `ba-ac.test.mjs` AC10, `ba-batch-d.test.mjs` (correction+minutes) | Initial+correction audit UI |
| AC11 | Report totals / filters | `ba-ac.test.mjs`, `ba-http-ac.test.mjs` A2, `ba-batch-d.test.mjs` (cards DOM) | Report drilldown UI |
| AC12 | Reminder offset | `ba-ac.test.mjs` dueAt | Worker timer lifetime |
| AC13 | Recipient dedup | `ba-ac.test.mjs` | Preview detail UI (`ba-batch-c` DOM smoke) |
| AC14 | Missing contact skipped | `ba-ac.test.mjs`, `ba-batch-c` retry reject | Notification preview UI |
| AC15 | Mock all success | `ba-ac.test.mjs` | Scenario picker UI |
| AC16 | Mock per recipient | `ba-ac.test.mjs`, `ba-batch-c` 4+ recipients | Per-recipient controls UI |
| AC17 | Retry preserves attempts | `ba-ac.test.mjs` AC17/18, `ba-http-ac` confirm | Batch detail retry UI |
| AC18 | Reminder tick idempotent | `ba-ac.test.mjs` AC17/18, AC19 | — |
| AC19 | Overdue no burst | `ba-ac.test.mjs` AC19 | Server restart burst |
| AC20 | Manual confirm isolated | `ba-ac.test.mjs`, `ba-batch-c` manual HTTP | Manual picker UI |
| AC21 | Batch snapshot frozen | `ba-ac.test.mjs` AC21 | Batch history detail UI |
| AC22 | Archive preserves history | `ba-ac.test.mjs` (+ confirmArchiveImpact) | Archive preview UI |
| AC23 | Overlap 409 / override | `ba-http-ac.test.mjs` | — |
| AC24 | No leave/makeup/fees | `ba-ac.test.mjs` | — |

Additional: migration (`ba-ac.test.mjs`), IDOR/CSRF (`ba-http-ac.test.mjs`), membership batch B (`ba-batch-b.test.mjs`), notifications batch C (`ba-batch-c.test.mjs`), attendance/session/reports batch D (`ba-batch-d.test.mjs`), tutor UI smoke (`ba-ui-integration.test.mjs`), BA F follow-up (`ba-batch-f.test.mjs`).

Change/cancel notification resolver coverage: `ba-batch-c.test.mjs` (membership-boundary change union, cancel roster).
