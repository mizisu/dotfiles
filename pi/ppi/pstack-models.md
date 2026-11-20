# pstack model configuration. One line per role; overrides pstack skill defaults.
# Missing roles inherit the parent model. inherit-parent and auto omit the subagent model argument.
# Panel entries each launch one attempt; the configured GPT models do not provide model-family diversity.
# The cross-judge pool uses only a different-family model from the parent; otherwise skip cross-judging.
# budget: large (xhigh)
feature, refactoring: openai-codex/gpt-6.1-sol:xhigh
bug-fix: openai-codex/gpt-6.1-sol:xhigh
perf-issue: openai-codex/gpt-6.1-sol:xhigh
hillclimb: openai-codex/gpt-6.1-sol:xhigh
judgment and prose: openai-codex/gpt-6-astra:xhigh
hardest tasks: openai-codex/gpt-6-astra:xhigh
how explorer: openai-codex/gpt-6.1-sol:xhigh
how explainer: openai-codex/gpt-6.1-terra:xhigh
why investigators: openai-codex/gpt-6.1-sol:xhigh
why synthesizer: openai-codex/gpt-6-astra:xhigh
reflect tooling: openai-codex/gpt-6.1-sol:xhigh
reflect judgment, divergent, synthesizer: openai-codex/gpt-6-astra:xhigh
arena runners: openai-codex/gpt-6-astra:xhigh, openai-codex/gpt-6.1-sol:xhigh
arena cross-judge pool: openai-codex/gpt-6-astra:xhigh, openai-codex/gpt-6.1-sol:xhigh
swarm workers: openai-codex/gpt-6.1-sol:xhigh
architect runners: openai-codex/gpt-6-astra:xhigh, openai-codex/gpt-6.1-sol:xhigh
interrogate reviewers: openai-codex/gpt-6-astra:xhigh, openai-codex/gpt-6.1-sol:xhigh
