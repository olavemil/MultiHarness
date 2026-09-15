# Restructuring (or v2)

The current code has some problems:

- verbosity
- tight coupling across steps and layers

These makes it hard to make incremental changes, or to "simply" restructure a stage prompt, since construction is spread through the code.

## Layers

- primitives layer
  - llm provider wrappers
    - ollama, lmstudio, omlx
    - context independent llm queries, with common parameters that are only set if provided (temperature, topk, token limits, model name, reasoning on/off, prompt)
    - embeddings
  - io
    - markdown/toml parsing
    - sqlite wrapper
    - common file io
      - write (path, name, contents)
      - read (path, name, embeddings vector?)
    - slack and other messaging wrapper
- harness layer
  - stage prototype / interface: What is the shape of all steps
    - name
    - output name(s)
    - inputs
    - auto inputs (dependencies, rules)
  - session prototype / interface
  - agent prototype / interface: identity
  - common mechanisms
    - stage logging
    - messaging
      - identities
      - channels/rooms
    - persona-less llm queries/steps
      - summarize text in n lines
      - classify text
- agent layer
  - implementations of above interfaces
  - identity
    - what is always provided as context to personal stages that is distinct for this agent? (name, description)
  - stages
    - base prompts (text only): what is always passed to a given stage, as prefix to the stage input?
    - prompt/context recipes (concat only, list of named products, omit if empty): what is appended to the base prompt?
      - default: [_base_, inputs, auto, _identity_, _reflection_, _thoughts_]
  - sessions
    - pipeline configs

## Pipelines / session config

Slight alterations to the session structure, and the concept of background work. Messages are handled in a pipeline, but the idea of a session is less present. Background work is defined as anything that isn't strictly driven by incoming messages, but is populated by the agent at the end of each pipeline. While there is background work to do, the agent will keep working, but will pause to handle message pipelines, whose output will be merged into pending work requests.

### on_message: (default pipeline)

- interpret: restate the message given conversation history, determine who/which message is addressed
- reflect: consider implication of incoming message given recent actions by the agent (not only what it did last session, the message might be related to prior messages)
- decide: given reflection and interpretation, decide how to handle incoming message; respond, react, defer, ignore. schedule remainder of session given decision
- optional planned steps, stack that can be pushed to while working
  - research
  - reason
  - draft
  - contact_other
  - reflect
  - review
  - react
- respond: (can be chosen as pipeline step)
- review: review session summary, step outputs
- background: plan background work

### Background: (default pipeline)

- schedule: populate a list of tasks
  - research
  - reason
  - free_write
  - contact_other
- while list not empty
  - wait if on_message needs to run
  - merge incoming background requests (step_a:"Do task 1") + (step_a:"Do task 2") = (step_a:"Do task 1\nDo task 2")
  - perform step
  - review output
  - schedule addition work if needed, given planned work
