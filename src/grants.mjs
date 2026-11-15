import { z } from 'zod';
import { Workspace, filesSchema } from './workspace.mjs';
import { WebAccess } from './web.mjs';
import { Actions, loadRegistry, protectedPaths, registryPath, canonical } from './actions.mjs';

// Shared schema fields for every tool that starts a job.
export const grantSchema = {
  files: filesSchema.optional(),
  web: z.boolean().optional().describe('Let the delegate read public web pages and APIs with web_get (GET only, no cookies, no local or private addresses; every fetch logged). Avoid combining with sensitive file grants unless the task needs both.'),
  actions: z.array(z.string().min(1).max(48)).max(16).optional().describe('Names of pre-approved actions from the owner\'s registry that the delegate may run with run_action.')
};

// Builds the job's grants. A write grant may never cover the action registry or any
// registered script, whether or not this job uses actions: otherwise a delegate could
// stage a change to a script it can later run.
// Refuses targets that are the action registry or a registered script. Fails closed: if
// the registry exists but cannot be read or parsed, no write is allowed, because the
// scripts it lists cannot be known. An absent registry still protects its own path.
export async function assertWritable(targets) {
  if (!targets.length) return;
  let registry;
  try { registry = await loadRegistry(); }
  catch (error) { throw Error(`Write refused: the action registry at ${registryPath()} could not be read (${String(error.message).slice(0, 200)}). Fix it first.`); }
  const guarded = await protectedPaths(registry);
  for (const target of targets)
    if (guarded.has(target) || guarded.has(await canonical(target)))
      throw Error(`Write refused: ${target} is the action registry or a registered action script.`);
}

// Builds the job's grants. Write targets are checked when the job starts and again just
// before apply, so a script registered while a job ran is still protected.
export async function buildGrants({ files, web, actions } = {}) {
  const grants = {};
  if (files) {
    grants.workspace = await Workspace.create(files);
    await assertWritable([...grants.workspace.writeTargets.keys()]);
    grants.workspace.beforeApply = assertWritable;
  }
  if (actions?.length) {
    let registry;
    try { registry = await loadRegistry(); }
    catch (error) { throw Error(`Action registry is invalid: ${String(error.message).slice(0, 300)}`); }
    grants.actions = await Actions.create(actions, registry);
  }
  if (web) grants.web = new WebAccess();
  return grants;
}

// Spec recorded in request fingerprints, so retries with different grants conflict.
export function grantSpec({ workspace, web, actions } = {}) {
  return { files: workspace?.spec, web: Boolean(web), actions: actions?.names };
}

export function grantTools({ workspace, web, actions } = {}) {
  return [...(workspace?.tools() ?? []), ...(web?.tools() ?? []), ...(actions?.tools() ?? [])];
}
