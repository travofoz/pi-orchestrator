/**
 * Sovereign Meta-Orchestrator for Pi Engine
 * Architecture: Event-Sourced, Append-Only Linear Pipeline
 *
 * Fully unattended: point it at future_phases/, walk away, come back to
 * completed_phases/ full of PASS/FAIL history. No manual copy/kick/critic step.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// Operational Configuration Rails
const FUTURE_DIR = path.join(__dirname, 'future_phases');
const COMPLETED_DIR = path.join(__dirname, 'completed_phases');
const CURRENT_FILE = path.join(__dirname, 'current_phase.md');
const CURRENT_PHASE_NAME_FILE = path.join(__dirname, 'current_phase_name.txt');
const AUDIT_FILE = path.join(__dirname, 'audit_report.md');
const REMEDIATION_LOG_FILE = path.join(__dirname, 'remediation_log.md');
const LOCK_FILE = path.join(__dirname, 'pipeline.lock');
const STATUS_LOG_FILE = path.join(__dirname, 'status.md');
const MAX_REMEDIATION_ATTEMPTS = 3;

/** @type {number} spawnSync buffer cap in bytes. Default Node 1MB is too small for verbose pi output. Not a runtime limiter — 100MB of stdout is effectively unhittable, this just exists so a chatty run doesn't crash the process. */
const MAX_BUFFER = 1024 * 1024 * 100; // 100MB
/**
 * Hard kill timeout PER pi invocation (executor call, critic call, and specialist call each
 * get their own fresh window) in ms. This is NOT a per-phase budget — if a phase doesn't
 * decompose cleanly and the executor call itself runs long, this is the number that matters.
 * Override without editing source: PI_TIMEOUT_MS=5400000 node orchestrator.js
 */
const PI_TIMEOUT_MS = Number(process.env.PI_TIMEOUT_MS) || 2 * 60 * 60 * 1000; // 2 hr default

/**
 * Logs to stdout AND appends to status.md so the run can be watched live from another
 * session: `tail -f status.md`
 */
function log(step, message) {
  const line = `[${step}] ${new Date().toLocaleTimeString()} || ${message}`;
  console.log(line);
  try {
    fs.appendFileSync(STATUS_LOG_FILE, line + '\n', 'utf8');
  } catch (_) {
    // status.md write failure should never take down the pipeline
  }
}

// --- LOCK: prevent two concurrent unattended runs from racing on current_phase.md ---
function acquireLock() {
  if (fs.existsSync(LOCK_FILE)) {
    const pid = Number(fs.readFileSync(LOCK_FILE, 'utf8').trim());
    let alive = true;
    try {
      process.kill(pid, 0); // signal 0: liveness probe, does not actually send a signal
    } catch (_) {
      alive = false; // ESRCH — no such process
    }
    if (alive) {
      log('LOCK', `pipeline.lock present (pid ${pid}, still running). Refusing to start a second run.`);
      process.exit(1);
    }
    log('LOCK', `Stale pipeline.lock found (pid ${pid} is not running — likely SIGKILL or a hard crash). Clearing it.`);
    fs.unlinkSync(LOCK_FILE);
  }
  fs.writeFileSync(LOCK_FILE, String(process.pid), 'utf8');
  const release = () => { try { fs.unlinkSync(LOCK_FILE); } catch (_) {} };
  process.on('exit', release);
  process.on('SIGINT', () => { release(); process.exit(1); });
  process.on('SIGTERM', () => { release(); process.exit(1); });
}

function verifyEnvironment() {
  if (!fs.existsSync(FUTURE_DIR)) fs.mkdirSync(FUTURE_DIR);
  if (!fs.existsSync(COMPLETED_DIR)) fs.mkdirSync(COMPLETED_DIR);

  const phases = fs.readdirSync(FUTURE_DIR).filter(f => f.endsWith('.md')).sort();
  if (phases.length === 0 && !fs.existsSync(CURRENT_FILE)) {
    log('SYSTEM', 'Zero phase specifications found inside future_phases/. Pipeline clear.');
    process.exit(0);
  }
  return phases;
}

/**
 * Executes pi headlessly. Loops tools internally and blocks until settled.
 * Captures stderr (rather than inheriting straight to the terminal) so failures can
 * actually be inspected — stderr is still echoed to the terminal for live visibility,
 * just also kept in memory. On a non-zero exit, sniffs the output for rate-limit/quota
 * signals: those get generous exponential backoff since they're transient by nature;
 * anything else (a real bug, bad auth) gets a couple of quick retries then fails fast,
 * since waiting won't fix a broken API key.
 * @param {string} promptText
 * @returns {string} stdout
 */
function runHeadlessPi(promptText) {
  const RATE_LIMIT_PATTERN = /rate.?limit|429|quota exceeded|too many requests|overloaded|try again later/i;
  const GENERIC_MAX_RETRIES = 2;
  const RATE_LIMIT_MAX_RETRIES = 5;

  let attempt = 0;
  while (true) {
    const result = spawnSync('pi', ['-p', promptText], {
      cwd: __dirname,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'], // capture stderr instead of inheriting so we can inspect it
      maxBuffer: MAX_BUFFER,
      timeout: PI_TIMEOUT_MS,
    });

    if (result.stderr) process.stderr.write(result.stderr); // still visible live, just also captured

    if (result.error && result.error.code === 'ETIMEDOUT') {
      log('ENGINE_TIMEOUT', `Pi exceeded ${PI_TIMEOUT_MS}ms and was killed. Halting pipeline — investigate before restart.`);
      process.exit(1);
    }
    if (result.status === 0) return result.stdout;

    const combinedOutput = `${result.stdout || ''}\n${result.stderr || ''}`;
    const looksTransient = RATE_LIMIT_PATTERN.test(combinedOutput);
    const retryCeiling = looksTransient ? RATE_LIMIT_MAX_RETRIES : GENERIC_MAX_RETRIES;

    if (attempt < retryCeiling) {
      const backoffSec = looksTransient
        ? Math.min(30 * Math.pow(2, attempt), 300) // 30s, 60s, 120s, 240s, 300s cap
        : 5 * (attempt + 1); // 5s, 10s
      log('ENGINE_RETRY', `Pi exited with code ${result.status} (attempt ${attempt + 1}/${retryCeiling + 1}${looksTransient ? ', rate-limit/quota signal detected' : ''}). Retrying in ${backoffSec}s.`);
      spawnSync('sleep', [String(backoffSec)]);
      attempt++;
    } else {
      log('ENGINE_CRASH', `Pi exited with critical failure code: ${result.status} after ${attempt + 1} attempts${looksTransient ? ' (looked transient but retries exhausted)' : ''}.`);
      process.exit(1);
    }
  }
}

/**
 * Current git HEAD, or null if not a repo. Used to detect a phase where the model
 * ran but never actually committed anything — the per-task commit instruction is a
 * prompt, not an enforced contract, so this is a diagnostic tripwire, not a gate.
 * @returns {string|null}
 */
function getGitHead() {
  if (!fs.existsSync(path.join(__dirname, '.git'))) return null;
  const res = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: __dirname, encoding: 'utf8' });
  return res.status === 0 ? res.stdout.trim() : null;
}

/**
 * Optional supplementary hard gate, e.g. `npm test`, `./gradlew test`, `pytest`. Off by
 * default — the critic prompt already identifies the project type itself and runs its
 * own appropriate build/lint/test commands as part of every audit, so this isn't required
 * for verification to be real. Set ORCHESTRATOR_VERIFY_CMD only if you want one specific
 * command to ALSO have to pass regardless of what the critic chose to run. Deliberately
 * has no language/toolchain assumption baked in — you decide what it runs, if anything.
 */
const VERIFY_CMD = process.env.ORCHESTRATOR_VERIFY_CMD || null;

/**
 * @returns {{ran: boolean, passed: boolean, output: string}}
 */
function runVerification() {
  if (!VERIFY_CMD) return { ran: false, passed: true, output: '' };
  log('VERIFY', `Running verification command: ${VERIFY_CMD}`);
  const result = spawnSync(VERIFY_CMD, {
    shell: true,
    cwd: __dirname,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    timeout: PI_TIMEOUT_MS,
  });
  const output = (result.stdout || '') + (result.stderr || '');
  const passed = result.status === 0;
  log('VERIFY', passed ? 'Verification command passed.' : `Verification command failed (exit ${result.status}).`);
  return { ran: true, passed, output };
}

/**
 * Best-effort git checkpoint + push. Non-fatal if not a git repo, no remote configured,
 * or offline — this is a safety net for bisecting bad phases, not a hard requirement.
 * The commit alone only protects against the orchestrator process dying; if the whole
 * VM gets wiped and rebuilt, only a pushed remote survives that. Set up `git remote add
 * origin <url>` once during workspace setup if you want that protection.
 * @param {string} message
 */
function gitCheckpoint(message) {
  if (!fs.existsSync(path.join(__dirname, '.git'))) return;
  try {
    spawnSync('git', ['add', '-A'], { cwd: __dirname, encoding: 'utf8' });
    const commit = spawnSync('git', ['commit', '-m', message], { cwd: __dirname, encoding: 'utf8' });
    if (commit.status === 0) {
      log('CHECKPOINT', `git commit: ${message}`);
    }
    const push = spawnSync('git', ['push'], { cwd: __dirname, encoding: 'utf8', timeout: 30000 });
    if (push.status === 0) {
      log('CHECKPOINT_PUSH', 'Pushed to remote.');
    } else if (push.error || push.status !== 0) {
      log('CHECKPOINT_PUSH_WARN', 'git push failed or no remote configured — commit is local-only.');
    }
  } catch (err) {
    log('CHECKPOINT_WARN', `git checkpoint failed non-fatally: ${err.message}`);
  }
}

/**
 * Tolerant verdict parse. Scans the head of the output for a VERDICT: PASS/FAIL
 * pattern, stripping common markdown noise (bullets, bold, headers) the model
 * might wrap around it despite instructions not to. Strict-but-brittle exact-first-
 * line matching was flagged as a real risk — a stray "**VERDICT: PASS**" or a
 * leading bullet would have false-negatived into a wasted remediation cycle.
 * @param {string} auditOutput
 * @returns {{status: 'PASS'|'FAIL'|'MALFORMED', firstLine: string}}
 */
function parseVerdict(auditOutput) {
  const firstLine = (auditOutput.split('\n')[0] || '').trim();
  const head = auditOutput.slice(0, 500).replace(/[*_`>#-]/g, '');
  const match = head.match(/VERDICT:\s*(PASS|FAIL)/i);
  if (!match) return { status: 'MALFORMED', firstLine };
  return { status: /** @type {'PASS'|'FAIL'} */ (match[1].toUpperCase()), firstLine };
}

/**
 * Runs the executor → critic → remediate loop for a single phase until it PASSes
 * or hits the remediation ceiling. Shared by both the normal new-phase path and
 * the crash-resume path — a resumed phase and a fresh phase are handled identically
 * from this point on, since everything needed to continue lives on disk
 * (current_phase.md + remediation_log.md).
 * @param {string} originalPhaseName
 * @param {string} originalSpecContent
 */
function runPhaseToCompletion(originalPhaseName, originalSpecContent) {
  let remediationCount = 0;
  let phaseCleared = false;

  while (!phaseCleared) {
    const remediationLog = fs.existsSync(REMEDIATION_LOG_FILE)
      ? fs.readFileSync(REMEDIATION_LOG_FILE, 'utf8')
      : '';
    // Named to avoid colliding with pi's own "context window / session context" terminology —
    // this is the spec + remediation history to judge against, not conversational context.
    const phaseRequirements = remediationLog
      ? `${originalSpecContent}\n\n## Remediation History (fix these on top of the original spec above)\n\n${remediationLog}`
      : originalSpecContent;

    // --- LAYER 1: THE SEMANTIC BUILDER ---
    log('PHASE_STATUS', `=== ${originalPhaseName} | attempt ${remediationCount} | per-task commits enabled ===`);
    log('EXECUTION', `Launching Headless Pi for Phase: ${originalPhaseName} (Attempt ${remediationCount})`);
    const executionPrompt = `Execute the instructions outlined in this specification file. First call the create_goal tool with an objective summarizing this phase's outcome, then work through the task checklist below using your tools. For independent tasks with no shared-file conflicts, delegate to parallel sub-agents via the Agent tool where safe. Do not write placeholders, stubs, or mock data. After each individual task is completed and verified working, before moving to the next task, run \`git add -A && git commit -m "<short task name>"\` so every task lands as its own checkpoint. Do not batch multiple tasks into one commit. When the entire objective is complete and verified, call update_goal with status complete:\n\n${phaseRequirements}`;
    const headBeforeExec = getGitHead();
    runHeadlessPi(executionPrompt);
    log('EXECUTION', 'Pi tool-loop settled successfully.');
    const headAfterExec = getGitHead();
    if (headBeforeExec !== null && headBeforeExec === headAfterExec) {
      log('COMMIT_WARN', 'No new commits landed during this executor run — the model may have skipped the per-task commit instruction. Not fatal, but the per-task checkpoint granularity was not actually achieved this cycle.');
    }

    // --- LAYER 2: THE CONTEXT-BLIND CRITIC GATE ---
    // "Context-blind" = blind to the executor's session/reasoning, not blind to the spec.
    // The critic is a fresh process with zero continuity from the executor run above — it
    // never sees the builder's self-report, only phaseRequirements and whatever's on disk.
    log('AUDIT', 'Spawning Ephemeral, Context-Blind Critic to evaluate workspace state...');
    const criticPrompt = `Act as a brutal, adversarial forensic systems auditor. Analyze the current codebase state in the workspace against the exact requirements outlined in this specification: \n\n${phaseRequirements}\n\n Before rendering judgment, identify what kind of project this is (look for package.json, build.gradle/settings.gradle, Cargo.toml, pyproject.toml/requirements.txt, go.mod, or whatever else is present) and actually RUN the appropriate build, lint, and test commands for that project type using your tools — do not just read the files and guess whether they'd pass. Report what you ran and its real output as part of your reasoning. You must judge using an uncompromising binary framework based on both the code inspection and the actual command output. If the codebase is completely implemented, matches all architectural rules, contains zero placeholders, stubs, or empty blocks, AND every verification command you ran actually passed, your output MUST start with exactly 'VERDICT: PASS'. If anything is missing, wrong, broken, or a command failed, your output MUST start with exactly 'VERDICT: FAIL', followed by a detailed technical postmortem including the real output of whatever failed.`;

    let auditOutput = runHeadlessPi(criticPrompt);
    fs.writeFileSync(AUDIT_FILE, auditOutput, 'utf8');

    let { status, firstLine } = parseVerdict(auditOutput);

    if (status === 'MALFORMED') {
      log('AUDIT_MALFORMED', `Critic did not emit a valid VERDICT line (got: "${firstLine}"). Treating as FAIL and logging raw output for review.`);
    }

    // Optional additional hard gate. The critic above now runs its own project-appropriate
    // verification, so this is only for when you want one specific deterministic command to
    // ALSO have to pass regardless of what the critic decided to run — not required, and
    // deliberately has no assumption about npm/any specific language baked in.
    if (status === 'PASS') {
      const verification = runVerification();
      if (verification.ran && !verification.passed) {
        log('VERIFY_OVERRIDE', 'Critic said PASS but the ORCHESTRATOR_VERIFY_CMD command failed — overriding verdict to FAIL.');
        status = 'FAIL';
        auditOutput = `${auditOutput}\n\n## Verification Command Output (command failed after critic PASS)\n\n${verification.output}`;
        fs.writeFileSync(AUDIT_FILE, auditOutput, 'utf8');
      }
    }

    if (status === 'PASS') {
      // --- BRANCH A: VERDICT PASS ---
      log('AUDIT_PASS', `Critic cleared implementation for ${originalPhaseName}.`);

      const targetArchiveName = remediationCount === 0
        ? `${originalPhaseName}_FINAL_PASS.md`
        : `${originalPhaseName}_REMEDIATION_${remediationCount}_FINAL_PASS.md`;

      fs.copyFileSync(CURRENT_FILE, path.join(COMPLETED_DIR, targetArchiveName));
      fs.unlinkSync(CURRENT_FILE);
      if (fs.existsSync(CURRENT_PHASE_NAME_FILE)) fs.unlinkSync(CURRENT_PHASE_NAME_FILE);
      if (fs.existsSync(AUDIT_FILE)) fs.unlinkSync(AUDIT_FILE);
      if (fs.existsSync(REMEDIATION_LOG_FILE)) fs.unlinkSync(REMEDIATION_LOG_FILE);

      gitCheckpoint(`phase complete: ${originalPhaseName}`);

      phaseCleared = true;
      log('STAGE_COMPLETE', `Phase ${originalPhaseName} successfully integrated. Moving forward downstream.\n`);
    } else {
      // --- BRANCH B: VERDICT FAIL (or MALFORMED, treated as FAIL) ---
      remediationCount++;
      log('AUDIT_FAIL', `Critic rejected workspace state. Error threshold: ${remediationCount}/${MAX_REMEDIATION_ATTEMPTS}`);

      if (remediationCount > MAX_REMEDIATION_ATTEMPTS) {
        log('CIRCUIT_BREAKER', `Max remediation cycles reached for ${originalPhaseName}. Halting pipeline for safety.`);
        gitCheckpoint(`phase halted (max remediations): ${originalPhaseName}`);
        process.exit(1);
      }

      const historicalFailedName = `${originalPhaseName}_ATTEMPT_${remediationCount}_FAILED.md`;
      fs.copyFileSync(CURRENT_FILE, path.join(COMPLETED_DIR, historicalFailedName));
      fs.writeFileSync(
        path.join(COMPLETED_DIR, `${originalPhaseName}_ATTEMPT_${remediationCount}_AUDIT.md`),
        auditOutput,
        'utf8'
      );

      // --- LAYER 3: THE EPHEMERAL REMEDIATION SPECIALIST ---
      log('REMEDIATION', 'Invoking Specialist to generate append-only delta specification...');
      const specialistPrompt = `Act as a technical specification architect. Analyze this forensic audit report:\n\n${auditOutput}\n\nTranslate every single identified failure and omission into a fresh, forward-facing remediation specification file. Output ONLY clean markdown under a '## Tasks' header using uncompleted checkboxes (- [ ]). Do not write any conversational intros, explanations, summaries, or trailing text. Provide only the markdown checklist data payload.`;

      const remediationSpec = runHeadlessPi(specialistPrompt);

      // Append to the remediation log rather than overwriting current_phase.md —
      // current_phase.md stays untouched as a record; phaseRequirements (original + log)
      // is what actually gets fed to the next executor/critic pass.
      const logEntry = `### Remediation ${remediationCount}\n\n${remediationSpec}\n`;
      fs.appendFileSync(REMEDIATION_LOG_FILE, logEntry, 'utf8');
      log('REMEDIATION', `Remediation log appended (entry ${remediationCount}). Recycling loop with original spec + full delta history.`);
    }
  }
}

function executePipeline() {
  acquireLock();

  // --- RESUME-FROM-CRASH ---
  // An orphaned current_phase.md means the orchestrator process (or the whole box)
  // died mid-phase last run. That phase's real progress already lives on disk — git
  // commits from completed tasks, remediation_log.md from prior audit cycles — so
  // finish it before touching future_phases/, using the same loop as a fresh phase.
  if (fs.existsSync(CURRENT_FILE)) {
    const resumedName = fs.existsSync(CURRENT_PHASE_NAME_FILE)
      ? fs.readFileSync(CURRENT_PHASE_NAME_FILE, 'utf8').trim()
      : 'RECOVERED_UNKNOWN_PHASE';
    log('RESUME', `Found orphaned current_phase.md from a previous run. Resuming phase: ${resumedName}`);
    const resumedSpecContent = fs.readFileSync(CURRENT_FILE, 'utf8');
    runPhaseToCompletion(resumedName, resumedSpecContent);
  }

  const phasePool = verifyEnvironment();

  for (const phaseFile of phasePool) {
    const originalPhaseName = phaseFile.replace('.md', '');
    const sourcePath = path.join(FUTURE_DIR, phaseFile);

    log('STAGE_INIT', `Migrating ${phaseFile} from vault to active execution slot.`);
    fs.copyFileSync(sourcePath, CURRENT_FILE);
    fs.writeFileSync(CURRENT_PHASE_NAME_FILE, originalPhaseName, 'utf8');
    fs.unlinkSync(sourcePath); // Remove from future pool immediately

    // Immutable reference spec for this phase — never overwritten by remediation deltas.
    // This is what fixes spec drift: executor and critic always see the ORIGINAL requirements
    // plus the accumulated remediation log, never just the latest delta in isolation.
    const originalSpecContent = fs.readFileSync(CURRENT_FILE, 'utf8');
    if (fs.existsSync(REMEDIATION_LOG_FILE)) fs.unlinkSync(REMEDIATION_LOG_FILE);

    runPhaseToCompletion(originalPhaseName, originalSpecContent);
  }

  log('PIPELINE_SUCCESS', 'All phases executed, audited, and successfully integrated.');
}

// Boot the pipeline runner
executePipeline();

