// Cloudflare Cron Triggers -> GitHub Actions `workflow_dispatch`, replacing this
// repo's own GitHub `schedule:` triggers as the thing that actually fires each
// sync/tracker/report workflow. None of the underlying work moves -- every
// script still runs as a GitHub Actions job exactly as today (Node, `git
// commit`/`git push`, same timeouts). This Worker's only job is punctuality:
// GitHub explicitly documents that `schedule:`-triggered workflows can be
// delayed or silently skipped under load, and that's not theoretical here --
// update-tracker.yml's own header comment already records that every run of
// that workflow so far has fired via manual workflow_dispatch, never its own
// `schedule` block, and sync-statcast.yml's last 10 runs were all ~1hr later
// than scheduled. Cloudflare Cron Triggers are far more punctual, so this just
// swaps the trigger source.
//
// Setup:
//   1. `wrangler secret put GITHUB_TOKEN` -- a fine-grained PAT scoped to this
//      repo only, with "Actions: read and write" permission (classic PATs need
//      the `repo` + `workflow` scopes instead). This Worker never reads or
//      writes repo file contents itself -- it only calls the workflow_dispatch
//      endpoint, the same POST a manual "Run workflow" button click makes.
//   2. Deploy (`wrangler deploy`, or push to main once Workers Builds is
//      pointed at this file via wrangler.jsonc's "main").
//   3. Verify a few real firings (Cloudflare dashboard -> Workers & Pages ->
//      this Worker -> Cron Triggers -> trigger events, or just watch GitHub's
//      Actions tab for new workflow_dispatch-triggered runs at the expected
//      times) before removing the now-redundant `schedule:` blocks from the
//      workflow YAML files. Leaving both in place temporarily is harmless --
//      these syncs are idempotent, so an occasional double-fire just re-writes
//      the same data, never anything destructive.

const OWNER = 'jarolgutierrez5-netizen';
const REPO = 'diamond-report';

// cron string (must exactly match an entry in wrangler.jsonc's triggers.crons)
// -> which workflow file(s) to dispatch when Cloudflare fires it. Kept as a
// flat map (not derived from the YAML) so this file has zero dependency on
// parsing the workflow configs at runtime -- update both places by hand when
// a schedule changes, same as any other cross-file convention in this repo.
//
// Only 5 keys -- Cloudflare Workers Free caps cron triggers at 5 per account, so the
// 10 real firings these 4 workflows used to get one slot each for (sync-statcast.yml
// x5, update-tracker.yml x3, generate-projections.yml x1, calibration-report.yml x1)
// now share these same 5 slots. Each slot keeps sync-statcast.yml's original time
// (its own 5-a-day cadence needed the most slots, so it anchors all of them); the
// other three workflows attach to whichever slot sits closest to their original solo
// time -- see each one's own comment below for the before/after.
const CRON_MAP = {
  // sync-statcast.yml's 6am CT full sync, PLUS generate-projections.yml (was its own
  // '11 12 * * *' slot at ~7:11am CT -- 67min from this one, closer than any other).
  '4 11 * * *': ['sync-statcast.yml', 'generate-projections.yml'],
  // sync-statcast.yml intraday #1, PLUS update-tracker.yml's morning grade+capture
  // pass (was its own '7 14 * * *' -- 2 minutes off this slot, closest match by far).
  '9 14 * * *': ['sync-statcast.yml', 'update-tracker.yml'],
  // sync-statcast.yml intraday #2 -- no other workflow's original time landed close
  // enough to this slot to share it.
  '9 17 * * *': ['sync-statcast.yml'],
  // sync-statcast.yml intraday #3, PLUS update-tracker.yml's afternoon pass (was its
  // own '13 20 * * *' -- 4 minutes off this slot).
  '9 20 * * *': ['sync-statcast.yml', 'update-tracker.yml'],
  // sync-statcast.yml intraday #4, PLUS update-tracker.yml's evening pass (was its own
  // '19 0 * * *', i.e. ~70min later -- the least-close match of the three, but the
  // remaining option; still same-evening, still ahead of most late lineup postings).
  '9 23 * * *': ['sync-statcast.yml', 'update-tracker.yml'],
};

// calibration-report.yml only needs to run once a WEEKLY (Monday), not daily like
// every workflow sharing CRON_MAP's slots above -- a cron field can't express "fire
// this one extra workflow at a slot four others already use every day, but only on
// Mondays" without a 6th trigger entry this account doesn't have room for. Doing the
// day check here instead costs zero extra cron triggers. Piggybacks on the '9 14 * * *'
// slot (was its own '22 15 * * 1', ~73min from this slot -- closest of the two
// candidates near its original ~10:22am CDT time) since that slot already runs
// update-tracker.yml's morning pass, so the week's freshest graded results are
// guaranteed in by the time this fires, same ordering guarantee the original
// standalone schedule was built around.
const MONDAY_CALIBRATION_SLOT = '9 14 * * *';

async function dispatchWorkflow(workflowFile, env) {
  const res = await fetch(
    `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${workflowFile}/dispatches`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'diamond-report-cron-worker',
      },
      body: JSON.stringify({ ref: 'main' }),
    }
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`workflow_dispatch failed for ${workflowFile}: ${res.status} ${body}`);
  }
}

export default {
  // Static asset serving is unchanged by adding this script -- every normal
  // page/data-file request still falls straight through to the exact same
  // Workers Assets serving wrangler.jsonc's "assets" block already configures
  // (env.ASSETS is Cloudflare's implicit binding to that same asset set once a
  // Worker script + "assets" are both present), so this is a behavior-neutral
  // addition for every request except the scheduled ones below.
  async fetch(request, env) {
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    const workflows = [...(CRON_MAP[event.cron] || [])];
    // event.scheduledTime (not Date.now()) is when this firing was actually scheduled
    // for -- the correct clock to check "is this Monday" against, not whenever the
    // handler happens to actually execute. getUTCDay() is safe here (not just
    // convenient): MONDAY_CALIBRATION_SLOT's cron fires at 14:09 UTC, which is the
    // same calendar day in every US timezone this project's other CT-anchored crons
    // care about, so there's no midnight-boundary mismatch to worry about.
    if (event.cron === MONDAY_CALIBRATION_SLOT && new Date(event.scheduledTime).getUTCDay() === 1) {
      workflows.push('calibration-report.yml');
    }
    if (!workflows.length) {
      console.warn(`No workflow mapped for cron "${event.cron}" -- update CRON_MAP in src/scheduled-sync.js.`);
      return;
    }
    for (const wf of workflows) {
      ctx.waitUntil(dispatchWorkflow(wf, env).catch(err => console.error(err.message)));
    }
  },
};
