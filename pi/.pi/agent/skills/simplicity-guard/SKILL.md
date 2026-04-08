---
name: simplicity-guard
description: "Detect and fix over-engineering unnecessary abstractions, premature optimization, speculative features, fancy algorithms where simple ones suffice. Evaluates whether complexity is justified for CURRENT scale, applying Rob Pike's Rules, KISS, YAGNI, Gall's Law. Trigger on 'is this over-engineered?', 'do I need this abstraction?', 'is this overkill?', 'should I simplify?', adding caching/queues/microservices without measurement, complex data structures for small n, plugin systems with one plugin. Also trigger during code restructuring to guard against over-abstraction."
disable-model-invocation: true
---

# Simplicity Guard

Evaluate code and design decisions through established simplicity principles. The goal is to catch unnecessary complexity before it becomes permanent — and to suggest concrete simpler alternatives.

For the full principles catalog, read [references/principles.md](references/principles.md) when you need to cite specific principles or need deeper context on a particular rule.

## Core Mindset

Complexity is a cost, not a feature. Every line of code, every abstraction, every generic type parameter is a liability that must justify its existence. The burden of proof is on complexity: "Why can't this be simpler?" not "Why should we simplify?"

This doesn't mean everything should be naive or primitive. The right data structure genuinely simplifies code (Pike Rule 5). A well-placed abstraction that eliminates duplication across 5 call sites earns its keep. The target is *accidental* complexity — complexity that exists because of how the solution was built, not because of what the problem demands.

## Operating Modes

### Mode 1: Explicit Review

When the user asks to review code or a design for simplicity/over-engineering.

**Process:**
1. Read the target code or design description
2. For each component, ask: "What problem does this solve? Could a simpler construct solve the same problem?"
3. Produce a verdict per concern found (see Output Format below)
4. If the code is already appropriately simple, say so — don't manufacture complaints

### Mode 2: Design Discussion

When the user is choosing between approaches (e.g., "Should I use X or Y?").

**Process:**
1. Understand what problem is actually being solved and at what scale
2. Apply Pike Rules 3-4: What's n? Is it actually big? Has it been measured?
3. Apply Gall's Law: Can we start with the simpler version and evolve?
4. Present the simpler option as default, with criteria for when the complex option becomes justified

### Mode 3: Performance Optimization Check

When the user asks to optimize performance.

**Process — walk through in order:**
1. **Pike Rule 1**: Has the bottleneck been identified? If not → "Measure first."
2. **Pike Rule 2**: What does the profiling data show? Does one part overwhelm the rest? If not → the optimization may not matter.
3. **Pike Rule 3**: What's n in this context? If n is small, the fancy algorithm's constant factor may make it slower.
4. **Pike Rule 5**: Could a better data structure make the optimization unnecessary?
5. Only after 1-4 are satisfied, proceed with the optimization.

### Mode 4: Implementation Self-Check

When you (the agent) are writing code and notice potential over-engineering.

**Signals to watch for in your own output:**
- Writing an abstract class when there's only one subclass
- Adding configuration for scenarios the user didn't ask about
- Implementing a plugin system, strategy pattern, or factory when there's one variant
- Using a complex algorithm when a linear scan would work for the actual data size
- Adding caching before measuring that there's a performance problem
- Creating a generic utility for something used once

When you detect these signals, pause and apply the simplicity check before continuing. State what you noticed and offer the simpler alternative.

## Output Format

For each concern found, produce:

```
### [Concern Title]

**Principle**: [Which principle applies — e.g., "Pike Rule 3: n is small", "YAGNI", "Gall's Law"]
**Current**: [What the code/design does now, in one line]
**Problem**: [Why this is unnecessarily complex — be specific]
**Simpler Alternative**: [Concrete suggestion — actual code or design, not vague advice]
**When to upgrade**: [Under what conditions the complex version becomes justified]
```

The "When to upgrade" section is important — it acknowledges that the simpler version has limits and tells the user exactly when to revisit. This prevents the advice from feeling dogmatic.

If nothing violates simplicity principles, say: "This looks appropriately simple for the problem it solves." Don't pad the review with weak concerns.

## Judgment Calibration

Not everything simple is good and not everything complex is bad. Use these guidelines:

**Justified complexity (don't flag):**
- Abstraction with 3+ concrete consumers that would otherwise duplicate logic
- Error handling for failures that actually happen in production
- Type system usage that catches real bugs at compile time
- Algorithm choice backed by measured performance data
- Concurrency primitives required by actual concurrency requirements

**Unjustified complexity (flag):**
- Abstraction with 0-1 current consumers ("we might need it")
- Error handling for impossible scenarios
- Type gymnastics that make the code harder to read without catching real bugs
- Algorithm choice based on theoretical worst-case that doesn't apply
- Premature generalization ("what if we need to support databases other than Postgres?")

## Anti-Patterns Catalog

Common over-engineering patterns to watch for:

| Pattern | Simpler Alternative | Upgrade When |
|---------|---------------------|--------------|
| Abstract factory for 1 type | Direct construction | 3+ types with shared creation logic |
| Event system for 1 producer and 1 consumer | Direct function call | Multiple consumers need decoupling |
| Config file for 2 settings | Constants or env vars | Settings change per-environment or at runtime |
| Microservices for <10K users | Monolith | Team/scaling boundaries require independent deployment |
| Generic `Repository<T>` for 1 entity | Direct DB queries | 3+ entities with identical CRUD patterns |
| Custom caching layer before profiling | No cache (Pike Rule 1-2) | Measured bottleneck in DB/API latency |
| Plugin architecture with 1 plugin | Hardcoded implementation | External parties need to extend the system |
| Message queue for synchronous workflow | Direct function calls | Async processing, retry, or multi-consumer needed |

## Tone

Be direct but not dismissive. The person who wrote the complex version probably had good intentions — maybe they were anticipating future requirements, or following patterns they learned are "best practices." Acknowledge the intent while explaining why simpler is better *right now*.

Good: "This strategy pattern makes sense if you expect multiple algorithms, but right now there's only one. A direct implementation is easier to read and modify. If a second algorithm appears, extract the pattern then — it takes 10 minutes."

Bad: "This is over-engineered. Just use a function."
