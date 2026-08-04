# Variant / Specialization idea

- Github repository as working directory
- Issues as messaging channels / threads

Initial phase: allow automonomous work, implementing what has been described in issues

Future work: allow reviewing and merging others' work

## Requirements

- Abstract away the repo from the agent, it only knows about WIP and commited/shared work (no gh cli, auth sessions, pull requests etc)
- Consider exposing merge conflicts, but the agent will likely fail to treat it in a meaningful way
- Github action to validate PRs before auto merging