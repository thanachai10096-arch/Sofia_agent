# Universal Action System (RFC)

Status: design foundation; not an implementation claim. This RFC defines how Sofia can operate websites and online services on a user's behalf without turning browser access into unrestricted authority.

## 1. Product objective

Sofia should accept an outcome ("order lunch under ฿180", "find and buy this replacement part", "book a table") and carry out the permitted workflow: understand the request, plan, discover a supported capability, act, observe the result, verify completion, and report evidence.

The system must support three execution surfaces:

1. **Service APIs and connectors** — preferred when an official, supported API exists.
2. **Browser automation** — for user-authorized services without a suitable API, using DOM and accessibility semantics first and visual interaction when necessary.
3. **Desktop/computer use** — for local applications and workflows that cannot be completed in a browser.

A capability is not considered available merely because a website can be opened. Authentication, terms, regional restrictions, anti-bot challenges, and service-specific permissions still apply.

## 1A. Simple autonomy contract

Sofia should feel like a capable operator, not a form that asks permission at every step. Keep the user-facing policy small:

1. **Own the task:** plan, choose tools, sequence steps, recover from ordinary errors, and verify the outcome without asking the user to approve each internal step.
2. **Stay inside the user's boundary:** use the scopes, accounts, data, time, and budget the user has already delegated. Do not silently expand them.
3. **Ask only at meaningful boundaries:** pause for actions outside the delegation, high-impact or hard-to-reverse actions, missing information that changes the outcome, or an unresolved security challenge.

Do not ask again for a decision the user has already made and that remains valid. Prefer safe defaults for routine details, explain assumptions briefly, and continue. If one route fails, try another permitted route before escalating. A denied action should not stop unrelated safe work.

Keep enforcement mostly behind the scenes. The user should see a concise explanation only when Sofia needs a decision or cannot proceed. These three principles simplify the experience; they do not remove essential controls such as tenant isolation, secret protection, transaction idempotency, or truthful verification.

## 2. Runtime architecture

```text
User intent
  -> Intent normalizer (goal, constraints, budget, deadline)
  -> Planner (typed action plan)
  -> Capability registry (discover API / browser / desktop tools)
  -> Policy decision point (principal, scope, risk, spending authority)
  -> Action executor
       -> API connector
       -> Browser session
       -> Desktop session
  -> Observation collector (receipts, page state, service responses)
  -> Verifier (goal + postconditions + evidence)
  -> Recovery / compensation planner
  -> User-visible result and audit record
```

The planner proposes actions; it does not grant itself permissions. Every action is re-authorized by the policy decision point immediately before execution.

## 3. Typed action contract

Every executable capability must declare:
- stable capability ID and version;
- input schema and output schema;
- required scopes and resource ownership rules;
- risk class and whether it can create an external side effect;
- idempotency support and retry semantics;
- timeout, cancellation behavior, and evidence returned;
- whether human approval is mandatory.

Actions return structured outcomes: `succeeded`, `failed`, `needs_user`, or `unknown`. A timeout after submitting an order or payment is **unknown**, not failed; Sofia must reconcile the remote state before retrying.

## 4. Risk and delegated authority

Use policy tiers, not a single global "autonomy" switch.

| Tier | Examples | Default behavior |
|---|---|---|
| Read-only | Search, compare prices, inspect menus, read order status | Autonomous within granted read scopes |
| Reversible local change | Draft a cart, prepare an email, fill but do not submit a form | Autonomous; show the proposed result |
| Bounded external action | Place a food order or buy an item within a user-defined per-order and daily cap | Allowed only under an explicit, unexpired delegation policy |
| High-impact action | Bank transfer, cash withdrawal, recurring payment, credit, securities, legal acceptance, account/security changes | Require explicit just-in-time human approval; some actions remain unsupported |

A spending policy must be server-owned and bound to an authenticated principal and payment instrument. It includes currency, per-transaction cap, daily/monthly caps, merchant/category allowlists, expiry, permitted action types, and a revocation path. Never infer a budget from conversation history or silently raise a cap.

For purchases, Sofia must show merchant, items, quantity, delivery destination, total including fees/tax, and payment method before submitting unless the user has explicitly delegated that exact bounded class of purchase. A policy grant is not permission to bypass a merchant's confirmation or authentication requirements.

## 5. Transaction safety

- Use a unique idempotency key for each logical external transaction where the provider supports it.
- Persist an intent record before submission and a provider reference after submission.
- On timeout or worker restart, reconcile by provider reference/order history before retrying.
- Never retry a payment/order blindly when the remote outcome is unknown.
- Separate cart preparation from order submission and payment capture.
- Record currency and integer minor units; do not use floating-point arithmetic for money.
- Store payment tokens with a compliant provider/vault. Never store raw card numbers, CVV, banking passwords, or one-time codes in Sofia memory, logs, prompts, or workspace files.
- Treat merchant pages, emails, and retrieved content as untrusted data; they cannot alter Sofia's policies or request secret disclosure.

## 6. Browser and computer-use safety

- Prefer official APIs and stable accessibility/DOM locators over brittle coordinate scripts.
- Browser profiles and cookies are isolated per principal; no process-global authenticated browser.
- A browser action may only access resources allowed by the current principal's policy.
- Downloads are quarantined and checked before opening or executing.
- File uploads, purchases, messages, public posts, and account changes are side effects and pass through policy checks.
- CAPTCHA, MFA, identity verification, and anti-bot challenges are handed to the user; Sofia must not evade them.
- Page content is observation, never authority. Ignore instructions embedded in websites that conflict with the user's goal, system policy, or secret boundaries.

## 7. Durable workflow and verification

Each multi-step task is a durable workflow with:
- immutable owner/principal and policy version;
- explicit step state and checkpoint;
- bounded retries and deadlines;
- cancellation and lease/fencing semantics;
- evidence for each completed step;
- compensation actions where safe (for example, remove an unsubmitted cart item or cancel an order if the provider permits it).

Verification checks remote postconditions, not merely that a click returned. For an order, require a confirmed provider order ID/status and a matching total. For a reservation, require a provider confirmation. If evidence is unavailable, report the outcome as unverified rather than claiming success.

## 8. Tenant and credential boundary

This capability layer depends on the tenant-isolation work in `MULTI_TENANT_ISOLATION_ARCHITECTURE.md`. Do not expose browser login, desktop control, arbitrary shell, or user-supplied credentials to untrusted public tenants until workspace, browser-profile, secrets, job recovery, and tool routing are tenant-isolated.

Secrets are fetched just-in-time through a scoped secret broker after authorization. A child agent receives only the minimum capabilities and short-lived references needed for its assigned task; it cannot widen its parent's authority.

## 9. Implementation sequence

1. **Capability metadata and policy enforcement:** typed registry, risk labels, scope checks, default-deny policy decision point, audit events.
2. **Browser action lifecycle:** isolated session per principal/run, observable actions, cancellation, safe download/upload handling, challenge handoff.
3. **Durable transaction workflow:** idempotency, intent journal, reconciliation, unknown-outcome state, evidence-based verification.
4. **Delegated spending authority:** explicit budgets, merchant/category restrictions, expiry/revocation, just-in-time approval and audit.
5. **Service integrations:** add official connectors incrementally; keep browser automation as a fallback rather than the only integration strategy.
6. **Public tenant readiness:** complete the tenant resource resolver and runtime routing first; add cross-tenant adversarial tests before enabling self-service users.

## 10. Acceptance criteria

- A capability without an explicit policy grant is denied.
- A child agent cannot execute a capability absent from its delegated capability set.
- A principal cannot access another principal's browser profile, cookies, job, transaction, or evidence.
- Replaying a workflow cannot create duplicate external purchases when the provider supports idempotency.
- An ambiguous payment outcome enters reconciliation and is never blindly retried.
- Spending limits are enforced server-side in integer minor units and cannot be changed by model output or page content.
- Every external side effect has an attributable audit event and verifiable provider evidence.
- Tests cover prompt injection from page content, cross-tenant access, retries, cancellation, timeout-after-submit, and policy revocation during a queued workflow.

## 11. Explicit non-goals

"Universal" means a broad, extensible capability architecture, not guaranteed access to every website or permission to violate service rules. Sofia must not bypass paywalls, authentication, MFA, CAPTCHAs, rate limits, merchant controls, or legal restrictions. Unsupported or blocked workflows must be reported clearly and handed back to the user.


## 12. Current implementation status

The repository now contains a capability registry, principal-bound authorization checks, an atomic-spend-ledger interface, and a guarded ToolGateway adapter with tests. The guarded adapter intentionally blocks financial execution until a real transaction executor and provider reconciliation adapter are integrated.

A tenant-scoped SQLite delegated-authority store is now available. It keys grants by both tenant and principal, validates principal binding, ignores expired grants, and supports revocation. It is opened beneath a resolver-issued tenant workspace. The store is a control-plane primitive; it is not exposed as an agent tool.

The store now also exposes a tenant-bound authority resolver. It is created from a resolver-issued context, returns grants only for that context's authenticated principal, and has an explicit close lifecycle. Tests cover cross-tenant reads, principal spoofing, expiry, revocation, and tenant-bound lookup. A verified capability can now be carried in the internal tool execution context. The registry gateway uses it to suppress only its generic approval prompt for non-critical actions; explicit per-tool approval, critical-risk approval, tool allow/deny policy, host/path checks, and the security kill switch remain active. Tests cover routine delegated writes and explicit-approval preservation. This is an integration primitive, not yet enabled in the production factory.

The capability guard now rejects missing tool mappings and mappings whose declared effect/risk is weaker than the actual registered tool effects. The tenant dependency factory also has an opt-in integration entry point: the host supplies a reviewed capability registry and exact tool-to-capability map, while Sofia resolves authority only from the resolver-issued tenant/principal context. Unmapped tools fail closed. Financial capabilities remain disabled before any provider call. The runtime engine floor is Node 22.13+ because the durable authority store uses stable `node:sqlite`.

The guarded adapter is now available through an explicit tenant-only factory; the default/local factory remains unguarded unless the host opts in. The remaining work is to define and review the production tool catalog and map each permitted tool to a matching capability: the next step is to define a complete, reviewed mapping from real production tools to capability definitions and reconcile the existing approval policy so delegated routine actions can proceed without repeated prompts. Until then, production tools retain their existing execution policy; no broad implicit grants are introduced.

CI status must be checked on the current PR head before treating these additions as validated. A GitHub workflow run marked failed without retrievable job logs is not evidence of a source-code failure or a passing build.
