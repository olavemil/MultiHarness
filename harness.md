# Synthetic intelligence harness

## Core Idea

- A robust and flexible framework providing a clean sandbox for an agent.
- Intended for running with a local model, typically via ollama or docker.
- Tools for the agent to interact with a knowledge database, create/delete/edit and move files and folders within a working directory (could be a virtual file tree, text blobs presented as a tree via tools).
- Tools for the agent to ingest/read content at given urls. or to search whitelisted/special cased sites (wikipedia, news)
- First class representation of multiple distinct users/other communication partners. The agent doesn't need to know whether it is talking to a human or another system, but should keep track of the different identities, and know who wrote the message it is responding to.
- One incoming message, scheduled run, or other trigger should typically result in a new agent session (or notify/update an ongoing one).
- A session involves a variable pipeline of steps, each of which could have different system prompts, model types, presented context.
- Pipeline steps should receive a context/system prompt that is a combination of
    - Own reaction topic/prompt headline
    - User query (where relevant)
    - Pipeline/plan summary (next, previous step, has research been done etc.)
    - Prior step output (plan, research summary, draft)

## Default pipeline

- reflect: (only from second session onwards, tracked per communication channel)
    - context
        - most recent message
        - last review
        - last session summary
        - previous history in the channel
        - last reflection
        - user summary
    - Update knowledge db, files
    - Output reflection
        - how well did the last session answer/respond to the incoming message (relevance/correctness/tone)
        - Concrete recommendations for the next sessions (DO's not DON'Ts)
- react
    - Context: same as reflect + reflection when present
    - Directive: Determine what steps to include of the ones below. Note that research and reason steps are expected to be expensive and take a longer time.
    - Output: List of (step, topic) tuples/lines "research, find latest news about X\ndraft"
[optional/configurable steps go here]
- respond:
    - Receives original user message, current draft if any, thoughts if any, reflection
- summarize: Non-llm call, structured listing of steps performed, time taken
- review:
    - Receives user message, reflection, session summary
    - Updates knowledge db, files
    - Produces a review

- repeat[steps, count]
    - repeats listed steps, up to three times
    - not a processing step by itself
- plan
    - Receives user message, reflection, last session summary
    - Outputs a more elaborate plan for the session
- research
    - Receives plan in context if present
    - Expected to update or populate the knowledge db, adding entries on relevant and related topics
    - Expected to return a summary of info on the specific topic
- reason
    - Receives plan, reeaerch summary + research stats (number of entries/files added/modified during research)
    - Extended reasoning, fairly free form, expected to make use of tools to note ideas, perhaps review outside data, but primarily to think about the question at hand.
    - Output thoughts
- draft:
    - Receive user message, reasoning thoughts, plan if any, research summary
    - Update or create the session draft
- message: (ask a third party for suggestions/feedback on the response, update user during ongoing research)
    - Receives original user message, pipeline summary, prior step output

## Hygiene

Step output is stored as files/entries that are reviewable via tools, but not modifiable (readonly except harness write on step end).

Suggested separation to handle various concerns:

- Avoid storing agent/session data in the repo. Working directory elsewhere, holding both agent config, runtime memory/files, and produced content (if any).
- In the working directory, suggest distinguishing between
    - knowledge: essentially a K/V store, ideally with some building dedup, separate pass to normalize data. Could be files or sqlite.
    - agent files: sandbox file system for the agent to use as it wishes
    - pipeline output: folder per session holding markdown files for session summary, reflection, reaction (pipeline config), response, thinking etc.
        - tools access to read a given step of the previous session, or look up session by number


On code style specifically
- Avoid duplication
- Avoid monolithic files
- Prefer keeping files focused, single concern etc.
- Avoid injecting prompts inline (separate .md files for each step, "${name}" for templating, "name_1.md" for variant prompts (randomly selected))
- Avoid specifying model names etc. inline, prefer a yaml/toml config with a default model, and overrides per step type.

## Concepts

A session is bookended by meta thinking:
- reflection looks to interpret the users satisfaction with a prior answer, and give instructions to itself for how to adjust course going forward (or to judge whether the message was not a feedback, but an unrelated question). It should handle multiple users talking about different topics in the meantime, and ideally look at the last few messages since multiple can have arrived in the meantime. Pay special attention to @mention's of the agent by name.
- review looks to evaluate the session after the fact, to judge how fast it managed to respond, the quality of it, and how it feels about the question and response.

The next layer is react/respond:
- react is the inbput step; it determines whether to respond, and assuming it decides to respond, react also outlines the rough pipeline. If the incoming message was directed at someone else, or just an acknowledgement of the agent's last reply, consider skipping directly to review, but allow the agent to "feel strongly enough" to want to interject, based on conversation history, reflection etc.
- respond is the output step, it formulates and sends the exact response.

The optional steps in between are essentially all variants of a thinking step, but with different system prompts and output files.