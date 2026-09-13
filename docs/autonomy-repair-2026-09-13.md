# Goal autonomy repair, 2026-09-13

Source repair only. Installed npm package remains unchanged.

## Controls

Every scheduler and provider-limit resume checks the same autonomy gate. Queued goal messages are fenced at message_start using the host abort signal. The real Pi0.85.1 probe confirms zero transport requests for a queued command while compacting.

The gate observes mantice:spend-guard and restores mantice-spend-guard from the active branch. Compacting yields. Paused, assistant error, cancellation, and explicit goal pause latch an independent pause. Goal history and owner token-budget semantics remain intact.

Defaults per session allowance: 8,000,000 cumulative input + output + cacheRead + cacheWrite tokens; 64 reserved autonomous continuations. These are token units, not invoice dollars. The allowance spans goal replacement, compaction and reload. Full append history prevents /tree from refunding it. /goal-guard reset requires idle and a ready Mantice guard, records the new baseline, and starts no paid work. Then /goal resume explicitly resumes the goal. Model tools do not reset the allowance.

Removed the get_goal-only continuation heuristic. Tool names, tool cadence, idle workers and 600-second waits do not establish wasted work.

## Verification

Pi0.85.1 real RPC, isolated agent directory, fetch replaced by a local fixture that rejects unexpected URLs. Queue while compacting: zero requests. Ready + explicit reset: one request. Pause after response: no hidden continuation. /goal resume while paused: zero additional requests. A response with 8M cacheRead tokens trips the independent allowance. Original objective remains in durable entries. Two fixture requests, zero paid requests.

Existing suite: 338 passed. Type check and build passed. Existing continuation tests split by responsibility to stay below 400 lines. Assertions updated for explicit brake preservation and removal of tool-name stall inference. Package-loading checks allow the new allowance audit entry while proving prior bytes unchanged. npm pack JSON is an object in the installed CLI; Object.values accepts its records without assuming array output.

Exact probe and evidence: /tmp/mantice-incident-20260913/goal-manual.mjs, repair-fixture.ts, goal-manual-evidence.json.

## Retry interpretation

Pi0.85.1 settings default to three agent-level retries, exponential delays 2s/4s/8s, provider retries zero, maximum provider-requested delay 60s. A successful assistant response resets the host retry counter. Host overflow has one compact-and-retry attempt. These are per-cycle bounds, not a session-wide spend bound.

Before this repair, the goal provider-limit scheduler could arm another delayed resume after each new failure, and ordinary goal continuations had no cumulative cache-inclusive allowance. The subagent extension itself has no automatic replay loop. This establishes a mechanism for repeated requests, not evidence that any particular recorded retry was wasted or billed twice. Request IDs, outcome and recorded usage must be compared with actual useful work.

Host retry configuration remains unchanged. This gate controls goal automation, while the coordinated pi-mantice provider-boundary guard controls paid admission and mechanical reduction.
