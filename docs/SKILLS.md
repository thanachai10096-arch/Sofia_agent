# Sofia Skills

Sofia exposes its existing skill catalog through two read-only Brain tools using the progressive-disclosure pattern.

## Discover skills

Call `skills_list` to retrieve compact metadata:

- `id`, `name`, and `description`
- triggers and categories
- source and version

Optional `query` searches the name, description, triggers, and categories. Optional `source` filters to `builtin`, `learned`, `project`, `custom`, or `marketplace`. Results are bounded to at most 100 entries.

## Load one skill

Call `skill_view` with the exact `id` returned by `skills_list`. This returns the selected skill's full procedure, strategy, and verification requirements.

Sofia does not load every procedure into the model context at the start of a run. The Brain may load a specific skill when the task requires it, reducing unnecessary prompt tokens.

## Trust and execution boundary

Skill procedures are reference guidance, not executable code and not authorization. The tool returns `trust: untrusted_reference_guidance`; all actions still pass through Sofia's existing Tool Gateway, policy checks, risk assessment, and approval flow.

Learned skills continue to use the versioned lifecycle:

1. Persist a candidate with provenance and evidence IDs.
2. Evaluate its metadata, procedure, and verification requirements.
3. Require explicit approval before promotion.
4. Preserve prior versions for rollback.

A missing approval handler fails closed. Listing or viewing a skill never installs, promotes, or executes it.

## Hermes compatibility notes

This ports the Hermes skills discovery pattern (`skills_list` → `skill_view`) into Sofia's native `SofiaSkill` and `SkillsPlatform` model. It does not copy Hermes' Python runtime or external skill directory loader. Filesystem-based `SKILL.md` packages, reference-file loading, marketplace installation, and slash-command routing remain separate future integrations.
