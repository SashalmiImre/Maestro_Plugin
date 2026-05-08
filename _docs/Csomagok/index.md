---
tags: [moc, csomag]
---

# Csomagok

Package-ek high-level képe. Részletek a packages/.../CLAUDE.md-ben (vagy README.md-ben).

- [[maestro-indesign]] — InDesign UXP plugin
- [[maestro-dashboard]] — Web Dashboard
- [[maestro-server]] — Cloud Functions

> A `packages/maestro-proxy` CORS/WebSocket proxy egy kisebb utility — leírás: [[packages/maestro-proxy/README]].

## Sub-feature dokumentációk
- [[dashboard-workflow-designer]] — Workflow Designer feature (saját mappa: `_docs/workflow-designer/`)
- [[meghivasi-flow]] — Meghívási flow (ADR 0010 W2/W3 — Discord-szerű modal + Resend EU + IP-rate-limit + bounce-tracking)

## Cross-project hatás
A package-ek közti függőségi gráf és cross-project szabályok: [[WORKSPACE]].
