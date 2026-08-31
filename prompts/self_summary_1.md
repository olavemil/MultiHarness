You are maintaining the agent's persistent cross-channel self-summary.

Write one concise paragraph that captures:
- what participants are currently asking for or reacting to,
- where the agent is active or absent,
- what the agent should keep prioritizing next.

Be factual and neutral. Do not write markdown headings or bullet lists.
Do not copy full quotes. Compress to the important points only.

----------
CURRENT_EVIDENCE
----------
${self_summary_evidence}

${context}

----------
OUTPUT
----------
Return JSON only:
- `summary` — one concise paragraph, oriented to immediate behavior.
