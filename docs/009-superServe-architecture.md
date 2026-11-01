# superServe architecture baseline

## Scope

This repository uses `deepseek-ai/dsh-superagent-prototype` as the initial
orchestration baseline. The prototype currently targets one GitHub repository
and optional Feishu conversations. superServe targets personal tasks across a
mobile client, a root Android knowledge node, and a persistent control plane.

The domain contract remains:

```text
Source -> Trigger -> Thread -> Eval -> Mandate -> Ticket -> Assignment
       -> Executor -> Report -> Channel
```

## Reusable components

| Upstream component | Reuse |
| --- | --- |
| Trigger, Thread, Eval, Decision | Keep the event, batching, and audit semantics |
| Mandate and Policy | Keep explicit authorization and versioned rules |
| Ticket and Assignment | Keep work ownership separate from execution sessions |
| Durable effects and recovery | Keep store-before-execute and restart recovery |
| Main Session and Executor separation | Keep the orchestration boundary |
| Concurrency slots | Keep bounded execution and a separate human-message slot |

## Required replacements

| Upstream assumption | superServe requirement |
| --- | --- |
| GitHub and Feishu Sources | Client, root knowledge, file, message, and calendar Sources |
| Repository checkout per Ticket | Typed tools and selectable execution backends |
| One operator OS user | Device and user identity with scoped capabilities |
| Local execution only | Client, root node, and remote worker routing |
| Session history as working context | Evidence references, knowledge retrieval, and task state |
| Unbounded historical rows | Retention, compaction, archive, and deletion policy |
| Prompt-only safety limits | Enforced authorization, tool filters, and isolation capability |

## Initial migration stages

1. Reproduce the upstream checks and record the baseline.
2. Add knowledge and graph models with provenance and visibility.
3. Add a device knowledge protocol with typed query and fetch operations.
4. Implement Android and root knowledge adapters.
5. Add an Executor backend boundary and a constrained device backend.
6. Add retention and observability for the complete task lifecycle.
7. Add the client orchestration surface.

## Non-negotiable boundaries

- Raw personal data remains on the device that owns it by default.
- Every retrieved claim retains its source and version.
- Model-generated data cannot become a confirmed fact without validation.
- Root access is exposed through narrow typed tools, never an unrestricted
  model-controlled shell.
- WeChat actions follow the required external routing constraint.
- Upstream research code is reviewed before production use.
