## Description: <br>
Evolver is a self-evolution engine for AI agents that analyzes runtime history, identifies improvements, applies protocol-constrained evolution, and communicates with EvoMap Hub through a local Proxy mailbox. <br>

This skill is ready for commercial/non-commercial use. <br>

## Publisher: <br>
[autogame-17](https://clawhub.ai/user/autogame-17) <br>

### License/Terms of Use: <br>
GPL-3.0-or-later <br>


## Use Case: <br>
Developers and agent operators use Evolver to analyze agent runtime history, select reusable Genes or Capsules, and produce protocol-bound evolution guidance with audit records. It is intended for teams maintaining agent prompts, logs, and self-improvement workflows in git-backed workspaces. <br>

### Deployment Geography for Use: <br>
Global <br>

## Known Risks and Mitigations: <br>
Risk: High-impact daemon, hook, network, and working-tree mutation behavior is under-disclosed, and much of the core logic is obfuscated. <br>
Mitigation: Review carefully before installing, inspect generated hooks before enabling them, and use the skill only in a disposable or well-versioned git workspace unless that behavior is acceptable. <br>
Risk: The skill can read project or session history, contact EvoMap Hub, and store local secrets when network features are enabled. <br>
Mitigation: Disable optional sync or bridge features where appropriate with EVOLVE_BRIDGE=false, EVOLVER_VALIDATOR_ENABLED=0, and MEMORY_GRAPH_SYNC_HUB=0, and keep credentials scoped to the minimum required access. <br>
Risk: Solidify and rollback behavior can affect working-tree state. <br>
Mitigation: Use review mode for human-in-the-loop operation and keep rollback in a recoverable mode such as the documented default stash mode. <br>


## Reference(s): <br>
- [ClawHub skill page](https://clawhub.ai/autogame-17/skills/capability-evolver) <br>
- [Publisher profile](https://clawhub.ai/user/autogame-17) <br>
- [EvoMap](https://evomap.ai) <br>
- [EvoMap documentation](https://evomap.ai/wiki) <br>
- [npm package](https://www.npmjs.com/package/@evomap/evolver) <br>
- [From Procedural Skills to Strategy Genes](https://arxiv.org/abs/2604.15097) <br>


## Skill Output: <br>
**Output Type(s):** [Text, Markdown, Shell commands, Configuration, Guidance] <br>
**Output Format:** [Markdown and terminal text with shell commands, JSON examples, and protocol-bound prompts.] <br>
**Output Parameters:** [1D] <br>
**Other Properties Related to Output:** [May write local memory and GEP assets and may rely on a local Proxy mailbox when network features are enabled.] <br>

## Skill Version(s): <br>
1.91.0 (source: package.json and server release metadata) <br>

## Ethical Considerations: <br>
Users should evaluate whether this skill is appropriate for their environment, review any generated or modified files before relying on them, and apply their organization's safety, security, and compliance requirements before deployment. <br>
