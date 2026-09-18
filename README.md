# skills.isambard.ac.uk

A curated collection of **AI agent skills** for Isambard HPC systems,
served at [skills.isambard.ac.uk](https://skills.isambard.ac.uk).

Agent skills are plain Markdown instruction files that teach AI coding
assistants (such as [Claude Code](https://claude.ai/code)) how to perform
specific tasks correctly in your environment. Loading a skill gives the
agent up-to-date, site-specific knowledge without you having to explain
the environment from scratch every session.

---

## Available Skills

| Skill | Description | URL |
|---|---|---|
| [Slurm](site/plugins/isambard/skills/slurm/SKILL.md) | Submit, monitor and manage HPC jobs on Isambard using the Slurm workload manager | `https://skills.isambard.ac.uk/skills/slurm/SKILL.md` |
| [Python](site/plugins/isambard/skills/python/SKILL.md) | Install and manage Python environments on Isambard using Conda (Miniforge), uv, or Cray Python | `https://skills.isambard.ac.uk/skills/python/SKILL.md` |
| [Modules](site/plugins/isambard/skills/modules/SKILL.md) | Use the modules system, Cray Programming Environments, compiler wrappers (cc, CC, ftn), GNU and NVIDIA compilers, and profiling tools on Isambard | `https://skills.isambard.ac.uk/skills/modules/SKILL.md` |
| [Spack](site/plugins/isambard/skills/spack/SKILL.md) | Install, configure, and use Spack to build HPC software on Isambard-AI and Isambard 3, including the buildit config repository and targeting neoverse_v2 / aarch64 | `https://skills.isambard.ac.uk/skills/spack/SKILL.md` |
| [Containers](site/plugins/isambard/skills/containers/SKILL.md) | Run containers on Isambard using Podman-HPC and Apptainer. Covers image management, GPU access, and multi-node MPI/NCCL workloads over Slingshot 11 | `https://skills.isambard.ac.uk/skills/containers/SKILL.md` |
| [MPI](site/plugins/isambard/skills/mpi/SKILL.md) | Use MPI on Isambard with Cray MPICH or OpenMPI. Covers PMI types, srun --mpi flags, Slingshot 11 performance, and why mpirun/mpiexec must not be used | `https://skills.isambard.ac.uk/skills/mpi/SKILL.md` |
| [NCCL](site/plugins/isambard/skills/nccl/SKILL.md) | Use NCCL for multi-node GPU communication on Isambard-AI over Slingshot 11. Covers the brics/nccl module, aws-ofi-nccl plugin, building from source, and NCCL in containers | `https://skills.isambard.ac.uk/skills/nccl/SKILL.md` |
| [GPUs and CUDA](site/plugins/isambard/skills/cuda/SKILL.md) | Use GPUs and CUDA on Isambard-AI (NVIDIA GH200, sm_90). Covers cudatoolkit/nvhpc modules, compiling with nvcc, and CUDA forward compatibility via NGC containers or NVIDIA HPC SDK | `https://skills.isambard.ac.uk/skills/cuda/SKILL.md` |

---

## Additions in this fork

These live only in this fork (`yushiran/skills.isambard.ac.uk`, installed through the `yushiran-research`
marketplace as `isambard@yushiran-research`) and are not served at skills.isambard.ac.uk.

| Part | What it is | When it fires |
|---|---|---|
| [slurm-watch](site/plugins/isambard/skills/slurm-watch/SKILL.md) | Watch a long Slurm job to its read point and evaluate it in the turn it ends; `scripts/job_status.sh` prints state, latest log record and a windowed ratio | when a job is submitted or asked about |
| [hooks/squeue_context.sh](site/plugins/isambard/hooks/squeue_context.sh) | `UserPromptSubmit` hook: the user's queue and each running job's last log line, into context | every user message; silent when the queue is empty |
| [agents/repo-reader](site/plugins/isambard/agents/repo-reader.md) | reads a baseline's released code and paper; equations with `file:line`, per-step cost | dispatched by name |
| [agents/library-surveyor](site/plugins/isambard/agents/library-surveyor.md) | answers from a `references/<topic>/` library through its `INDEX.md`, never traversing it | dispatched by name |

---

## Using a Skill

### Claude Code

Add the Isambard marketplace (all skills at once):

```
/plugin marketplace add https://github.com/isambard-sc/skills.isambard.ac.uk
```

Install Isambard plugin:

```
/plugin install isambard@isambard-skills
```

Or add to your project's `.claude/settings.json` to enable automatically:

```json
{
  "extraKnownMarketplaces": {
    "isambard-skills": {
      "source": {
        "source": "url",
        "url": "https://skills.isambard.ac.uk/.claude-plugin/marketplace.json"
      }
    }
  },
  "enabledPlugins": { "isambard@isambard-skills": true }
}
```

Reload skills to find and activate skills provided by Isambard plugin:

```
/reload-skills
```

View skills provided by Isambard plugin:

```
/skills
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  Skills
  9 skills · Space to cycle, Enter to save, / to search, t to sort, Esc to cancel

  ╭──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╮
  │ ⌕ Search skills…                                                                                                         │
  ╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
  ❯ 🔒 on         isambard:docs · plugin · ~100 tok · locked by plugin
    🔒 on         isambard:containers · plugin · ~200 tok · locked by plugin
    🔒 on         isambard:cuda · plugin · ~190 tok · locked by plugin
    🔒 on         isambard:modules · plugin · ~180 tok · locked by plugin
    🔒 on         isambard:mpi · plugin · ~170 tok · locked by plugin
    🔒 on         isambard:nccl · plugin · ~210 tok · locked by plugin
    🔒 on         isambard:python · plugin · ~150 tok · locked by plugin
    🔒 on         isambard:slurm · plugin · ~190 tok · locked by plugin
    🔒 on         isambard:spack · plugin · ~200 tok · locked by plugin

  Plugin skills are managed via /plugin

```

### Other agent-based tools

Paste the skill URL into the tool's context or skill configuration. The
raw Markdown content is served directly from this site.

---

## Repository Structure

```
.claude-plugin
  marketplace.json           # Claude Code plugin marketplace catalog
site/plugins/isambard/       # All web-served content (GitHub Pages source)
  .claude-plugin/
    marketplace.json         # Claude Code plugin marketplace catalog
  skills/
    slurm/
      SKILL.md               # Slurm skill file (AgentSkills spec format)
    docs/
      SKILL.md               # User documentation skill file (AgentSkills spec format)
  index.html                 # Public site landing page
  marketplace.json           # Simple skills index for other agent tools
  CNAME                      # Custom domain configuration
.github/
  agents/
    skills-agent.md          # Instructions for AI agents on creating skills
.vscode/
  settings.json              # Word-wrap settings for Markdown/.chatagent files
README.md                    # This file
```

---

## Contributing / Adding a New Skill

See [`.github/agents/skills-agent.md`](.github/agents/skills-agent.md)
for the full conventions on how skills are structured, named, and
registered in the marketplace.

For full Isambard documentation visit
[docs.isambard.ac.uk](https://docs.isambard.ac.uk).
