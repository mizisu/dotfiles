# Test-pruning campaign

Campaign mode prunes one subsystem's whole test surface in one PR: a module,
package, service, or other component. The value bar, retention bar, candidate
evidence, and validation in [SKILL.md](SKILL.md) apply to every lane.
This file adds the order of work and the lessons of a full campaign.
Each step ends on its completion criterion; do not start the next step early.

## 1. Baseline

Record the subsystem's test and support line counts and every test file's
pass/fail state at a pinned target-branch commit. Keep baseline failures in their
own list: they may reveal real product bugs, not stale tests.

Done when every in-scope test file has a recorded baseline result.

## 2. Lanes and inventory

Split the surface into **lanes** along production owner boundaries, not file
prefixes. Identify these boundaries from the subsystem's actual responsibilities
and dependencies. Include the subsystem's cases at shared boundaries and any
QA and live-proof harness tests it owns.

Done when every test file and QA scenario the subsystem owns belongs to exactly
one lane.

## 3. Read-only ledger per lane

When delegation is authorized and available, give each lane to its own read-only
agent; otherwise inspect lanes sequentially. Read every assigned test in full,
including parameter tables, plus the production owners and their entry points,
callers, history, and CI routing. Each test declaration goes into a written
**ledger** with one mark. A parameterized test is one declaration unless its
rows need different marks; then mark each row.

- `R`: retain, naming the contract and the bug it catches; a retained test that
  only moves to a better-named file stays `R` with the move noted;
- `F`: retain the contract but repair the assertion, such as a vacuous negative
  that passes when only one of several items is missing;
- `C`: consolidate, naming the owner that absorbs the assertion first: a sibling
  table case, a stronger boundary suite, or the shared owner in another package;
- `D`: delete, naming the proof that remains, or why no contract exists.

Judge a test by its assertions, not its name. A test named for retiring a
resource may merely assert that the resource was not cleared.

Done when every declaration in the lane has a mark and an evidence line.

## 4. Layer plan per lane

Treat the per-test ledger as input, not as the edit list. A second read-only
pass, starting from the ledger, looks for the redundant **layer**. Several
suites may replay the same shared helper through mocks while stronger
integration suites already exercise its real boundary. Name the **keeper**
suite for each contract. Prefer the real transport boundary with a fake network
over a mocked collaborator. Correct any ledger errors this pass finds.

Done when each lane plan names its retired files, its keeper per contract, the
assertions to carry into keepers, and the test-only production seams unlocked.

## 5. Cutover

Edit lane by lane. Serialize changes to shared harnesses and support files
through one owner. With each lane, remove the test-only production seams it
unlocks: injection parameters, getters, reset exports, and indirection layers.
Register moved suites in CI routing and test inventories where maintained.
Update shrink-only line-cap baselines where enforced. Put durable test-ownership
rules in the repository's appropriate scoped instruction file, drawn from
mistakes this campaign actually found.

Done when every lane plan is applied and each lane's keepers pass.

## 6. Preservation review

Before claiming completion, have independent reviewers compare deleted
coverage against the keepers, one reviewer per boundary group, when authorized
and available. Otherwise perform a separate sequential review pass and state
that independent review remains outstanding; do not claim a self-review is
independent or bypass repository review requirements. Look for contracts that
lost their only proof and new assertions that cannot fail, such as a rejection
row the production code never reaches.

For each restored contract, make one deliberate **mutation** of the production
owner and confirm the keeper goes red. Then restore the source byte for byte.

Done when every reported gap is restored or rejected with source evidence,
every restored contract has a caught mutation, and review requirements and any
outstanding independent review are explicitly accounted for.

## 7. Product defects

A baseline failure that survives into a keeper is a bug report. Fix it at its
owner as a separate commit when authorized, and prove it through the real user
flow, with a **control** run that reverts the fix and shows the old behavior.
Record unrelated product discrepancies you find as follow-ups instead of fixing
them in the campaign.

Done when each repaired defect has a failing control and a passing candidate
on the same harness.

## 8. Reconcile and hand off

Campaigns may span many target-branch commits. Refresh from the target branch
using the repository's merge or rebase policy. When upstream modified a file
the campaign deleted, port any new contract into the keeper before retaining
the deletion, and confirm every new upstream regression still has a home.
Reassess the deletion if the keeper cannot preserve that coverage. Rerun the
whole subsystem suite and any applicable live proof on the updated head.

Expect review tooling to see a truncated file list on a diff this large.
Record maintainer decisions about compatibility exceptions in the PR evidence
rather than weakening gates.

Hand off with the [SKILL.md](SKILL.md) report, plus:

- baseline and final test/support line counts, with production counted separately;
- lanes, retired layers, and keepers;
- preservation gaps found and their mutations;
- product defects with control and candidate proof;
- outstanding checks or independent review.
