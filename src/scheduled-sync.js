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
const CRON_MAP = {
  // sync-statcast.yml -- 6am CT full sync, then 4 intraday zone/HR-only
  // reruns as MLB's probablePitcher field fills in through the day (see that
  // workflow's own schedule comments for the full reasoning per entry).
  '4 11 * * *': ['sync-statcast.yml'],
  '9 14 * * *': ['sync-statcast.yml'],
  '9 17 * * *': ['sync-statcast.yml'],
  '9 20 * * *': ['sync-statcast.yml'],
  '9 23 * * *': ['sync-statcast.yml'],
  // update-tracker.yml -- morning grade + capture, then two more passes
  // through the afternoon/evening to pick up newly-posted lineups.
  '7 14 * * *': ['update-tracker.yml'],
  '13 20 * * *': ['update-tracker.yml'],
  '19 0 * * *': ['update-tracker.yml'],
  // generate-projections.yml -- daily World Series / MVP odds refresh.
  '11 12 * * *': ['generate-projections.yml'],
  // calibration-report.yml -- weekly (Monday) model calibration report.
  '22 15 * * 1': ['calibration-report.yml'],
};

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
    const workflows = CRON_MAP[event.cron] || [];
    if (!workflows.length) {
      console.warn(`No workflow mapped for cron "${event.cron}" -- update CRON_MAP in src/scheduled-sync.js.`);
      return;
    }
    for (const wf of workflows) {
      ctx.waitUntil(dispatchWorkflow(wf, env).catch(err => console.error(err.message)));
    }
  },
};
