export const meta = {
  name: "esp-ralph-loop",
  description:
    "Ralph loop: one fresh esp-iterator agent per iteration does one unit of a task, commits and stops, until the task is complete, blocked or out of iterations. Steering: while it runs, a user message in the launching session is a correction; that session finds the run (runs.mjs index --status running --workflow esp-ralph) and appends it with runs.mjs notes --append <text> --from operator --run-dir <run-dir>. The next iteration applies it, and a stop request ends the loop there",
  whenToUse:
    "Launched by the esp-ralph skill with the prompt it built; args: task (text or path), max_iterations, run_dir, model, effort, allow_subagents (needs plugin_root), no_progress_limit",
  phases: [{ title: "Iterate", detail: "one fresh agent per unit of work" }]
};

const ITERATION = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["continue", "complete", "blocked"] },
    summary: { type: "string" },
    commits: { type: "array", items: { type: "string" } },
    progress_note: { type: "string" },
    run_dir: { type: "string" },
    blocker: { type: "string" }
  },
  required: ["status", "summary", "commits", "progress_note"]
};

const input = typeof args === "string" ? { task: args } : (args ?? {});
const task = String(input.task ?? "").trim();
if (!task) throw new Error("esp-ralph-loop: args.task is required");

const positive = (value, fallback) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};
const maxIterations = positive(input.max_iterations, 25);
const noProgressLimit = positive(input.no_progress_limit, 2);
const allowSubagents = input.allow_subagents === true;
const pluginRoot = String(input.plugin_root ?? "").trim();
// A general-purpose iteration does not carry the esp-iterator prompt, so it
// reads the same rules from the plugin's agent file.
if (allowSubagents && !pluginRoot)
  throw new Error(
    "esp-ralph-loop: args.plugin_root is required with allow_subagents"
  );
const NULL_LIMIT = 2;

// A single line naming a text file is a task file; anything else is the task.
const isTaskFile = !/\n/.test(task) && /\.(md|markdown|txt)$/i.test(task);
const taskBlock = isTaskFile
  ? `Task file: ${task}\nRead it in full first: its contents are the task.`
  : `Task:\n\n${task}`;

const iterationPrompt = (n, runDir) =>
  [
    `You are iteration ${n} of at most ${maxIterations} of a ralph loop. You start with a fresh context: the task, the files on disk and the run notes are all you know. Do one unit of work, record it, and stop.`,
    ...(allowSubagents
      ? [
          `Loop rules: read ${pluginRoot}/agents/esp-iterator.md in full first and follow its Methodology and Output Guidance as your own. In it, \${CLAUDE_PLUGIN_ROOT} is ${pluginRoot}.`
        ]
      : []),
    taskBlock,
    runDir
      ? `Run dir: ${runDir}`
      : "Run dir: none yet. Create it first with runs.mjs create --workflow esp-ralph, and return its path as run_dir.",
    "Steering: read the run notes before anything else. Lines marked (operator) are corrections the user sent during the run: apply them, and note each one you applied. An operator line asking to stop, pause or cancel ends this iteration at once with status blocked and that request as the blocker.",
    "Return status continue when a unit is done and work remains, complete when the task's completion condition holds and its finish step ran, blocked when you cannot continue. List the full SHA of every commit you made, and put what the next iteration must know in progress_note (also appended to the run notes)."
  ].join("\n\n");

const agentOpts = (n) => {
  const opts = {
    label: `iteration-${n}`,
    phase: "Iterate",
    schema: ITERATION,
    agentType: allowSubagents ? "general-purpose" : "esp-skills:esp-iterator"
  };
  if (input.model) opts.model = input.model;
  if (input.effort) opts.effort = input.effort;
  return opts;
};

phase("Iterate");
let runDir = input.run_dir ? String(input.run_dir) : null;
const iterations = [];
let reason = "max_iterations";
let blocker = null;
let nulls = 0;
let idle = 0;

for (let n = 1; n <= maxIterations; n++) {
  let result = null;
  try {
    result = await agent(iterationPrompt(n, runDir), agentOpts(n));
  } catch (error) {
    log(`iteration ${n}: agent error: ${error.message}`);
    result = null;
  }

  if (!result) {
    nulls++;
    iterations.push({ n, status: null, summary: null, commits: [] });
    log(`iteration ${n}: no result (${nulls} in a row)`);
    if (nulls >= NULL_LIMIT) {
      reason = "agent_failures";
      break;
    }
    continue;
  }
  nulls = 0;

  if (!runDir && result.run_dir) runDir = result.run_dir;
  const commits = Array.isArray(result.commits)
    ? result.commits.filter(Boolean)
    : [];
  const note = String(result.progress_note ?? "").trim();
  iterations.push({
    n,
    status: result.status,
    summary: result.summary,
    commits,
    progress_note: note
  });
  log(
    `iteration ${n}: ${result.status}, ${commits.length} commit(s): ${result.summary}`
  );

  if (result.status === "complete") {
    reason = "complete";
    break;
  }
  if (result.status === "blocked") {
    reason = "blocked";
    blocker = result.blocker || result.summary;
    break;
  }

  idle = commits.length === 0 && !note ? idle + 1 : 0;
  if (idle >= noProgressLimit) {
    reason = "no_progress";
    break;
  }
}

log(`loop ended: ${reason} after ${iterations.length} iteration(s)`);
return {
  reason,
  blocker,
  run_dir: runDir,
  iterations,
  commits: iterations.flatMap((it) => it.commits)
};
