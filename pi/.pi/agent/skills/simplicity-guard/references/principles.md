# Simplicity Principles Catalog

Reference material for the simplicity-guard skill. Read sections as needed — not all at once.

## Table of Contents
1. [Rob Pike's 5 Rules of Programming](#rob-pikes-5-rules)
2. [KISS](#kiss)
3. [YAGNI](#yagni)
4. [Unix Philosophy](#unix-philosophy)
5. [Go Proverbs](#go-proverbs)
6. [Gall's Law](#galls-law)
7. [Worse is Better](#worse-is-better)
8. [Zen of Python (selected)](#zen-of-python)

---

## Rob Pike's 5 Rules

The foundation of this skill. From Rob Pike (co-creator of Go, Plan 9, UTF-8).

**Rule 1: You can't tell where a program is going to spend its time.**
Bottlenecks occur in surprising places. Don't put in a speed hack until you've proven that's where the bottleneck is.

**Rule 2: Measure.**
Don't tune for speed until you've measured, and even then don't unless one part of the code overwhelms the rest.

**Rule 3: Fancy algorithms are slow when n is small, and n is usually small.**
Fancy algorithms have big constants. Until you know that n is frequently going to be big, don't get fancy. (Even if n does get big, use Rule 2 first.)

**Rule 4: Fancy algorithms are buggier than simple ones, and they're much harder to implement.**
Use simple algorithms as well as simple data structures.

**Rule 5: Data dominates.**
If you've chosen the right data structures and organized things well, the algorithms will almost always be self-evident. Data structures, not algorithms, are central to programming.

**Commentary:**
- Rules 1-2 restate Tony Hoare's maxim: "Premature optimization is the root of all evil."
- Ken Thompson rephrased Rules 3-4 as: "When in doubt, use brute force."
- Rules 3-4 are instances of KISS.
- Rule 5 was stated by Fred Brooks in The Mythical Man-Month. Often shortened to: "Write stupid code that uses smart objects."

---

## KISS

**Keep It Simple, Stupid** — attributed to Kelly Johnson (Lockheed Skunk Works).

The principle: most systems work best if they are kept simple rather than made complicated. Simplicity should be a key goal in design, and unnecessary complexity should be avoided.

**Applied to code:**
- Prefer a 20-line function over a 5-line clever one-liner that nobody can read
- One obvious way to do something beats three clever ways
- If you need a comment to explain what a line does, the line is too clever

---

## YAGNI

**You Aren't Gonna Need It** — from Extreme Programming (XP).

Don't implement something until it is actually needed. The cost of building it now:
- Code written and never used
- Increased surface area for bugs
- Cognitive load on every future reader
- Maintenance burden forever

**Signals of YAGNI violation:**
- "We might need this later"
- Configuration for scenarios that don't exist yet
- Abstract factory for a single concrete type
- Generic solution when only one variant exists
- Plugin system with one plugin

---

## Unix Philosophy

From Doug McIlroy, Ken Thompson, Dennis Ritchie.

Core tenets relevant to code design:
1. **Do one thing well.** Write programs (functions, modules) that do one thing and do it well.
2. **Compose.** Write programs to work together. Design interfaces that connect.
3. **Text streams as universal interface.** Prefer simple, universal data formats.
4. **Build quickly, iterate.** Don't hesitate to throw away the clumsy parts and rebuild.
5. **Use tools over manual labor.** Automate before you hand-craft.

**Peter Salus summary:**
- Write programs that do one thing and do it well.
- Write programs to work together.
- Write programs to handle text streams, because that is a universal interface.

---

## Go Proverbs

From Rob Pike's talk "Go Proverbs" (2015). Selected proverbs most relevant to simplicity:

- **"Clear is better than clever."** — Readability beats cleverness every time.
- **"A little copying is better than a little dependency."** — Don't create coupling to avoid duplicating a few lines.
- **"The bigger the interface, the weaker the abstraction."** — Small interfaces are powerful. `io.Reader` has one method and is everywhere.
- **"Make the zero value useful."** — Design types that work without initialization.
- **"Don't just check errors, handle them gracefully."** — But don't over-engineer error handling either.
- **"Gofmt's style is no one's favorite, yet gofmt is everyone's favorite."** — Consistency beats personal preference.
- **"interface{} says nothing."** — Overly generic types lose meaning.

---

## Gall's Law

From John Gall's *Systemantics* (1975):

> "A complex system that works is invariably found to have evolved from a simple system that worked. A complex system designed from scratch never works and cannot be patched up to make it work. You have to start over with a working simple system."

**Implication:** Don't design the final complex system upfront. Build the simplest version that works, then evolve it. If you're drawing architecture diagrams for 6 months before writing code, you're violating Gall's Law.

---

## Worse is Better

From Richard P. Gabriel's essay "The Rise of Worse is Better" (1989).

The "New Jersey style" (worse is better) vs "MIT/Stanford style" (the right thing):

| Aspect | Worse is Better | The Right Thing |
|--------|----------------|-----------------|
| Simplicity | Implementation simplicity is paramount | Interface simplicity is paramount |
| Correctness | Slightly less correct is acceptable | Must be correct |
| Consistency | Can be sacrificed for simplicity | Must be consistent |
| Completeness | Can be sacrificed for simplicity | Must cover all cases |

**Why worse wins:** A simpler implementation is easier to port, understand, modify, and maintain. It spreads faster. Once adopted, it gets incrementally improved. The "right" solution often never ships because it's too complex to build.

**Applied to code:** Ship the simpler version. A 90% solution that's maintainable beats a 100% solution that's incomprehensible.

---

## Zen of Python

Selected lines from PEP 20 (Tim Peters) that apply broadly beyond Python:

- **Simple is better than complex.**
- **Complex is better than complicated.** (If complexity is needed, keep it organized.)
- **Flat is better than nested.** (Deep nesting is a code smell.)
- **Readability counts.**
- **If the implementation is hard to explain, it's a bad idea.**
- **If the implementation is easy to explain, it may be a good idea.**
- **There should be one — and preferably only one — obvious way to do it.**
