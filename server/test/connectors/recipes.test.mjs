import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import YAML from 'yaml';

import { createConnectors } from '../../src/connectors/index.mjs';
import { draftArgs, draftRecipe, nounOf, pickTools } from '../../src/connectors/init.mjs';
import { recipeFor, RECIPES_DIR, shippedRecipes, validateRecipe } from '../../src/connectors/recipes.mjs';
import { makeApp, makeTempRepo, rmrf } from '../helpers.mjs';
import { memoryConnect } from './helpers.mjs';

const repos = [];
const apps = [];
after(async () => {
  for (const a of apps) await a.stop().catch(() => {});
  repos.forEach(rmrf);
});

const SHIPPED = ['github', 'gitlab', 'google-drive', 'granola', 'linear', 'mcp-resources', 'notion', 'slack', 'web-fetch'];

describe('shipped recipes', () => {
  it('ships the nine recipes the spec names, and every one validates', () => {
    assert.deepEqual(shippedRecipes(), SHIPPED);
    for (const name of SHIPPED) {
      assert.doesNotThrow(() => recipeFor({ id: 't', recipe: name }), name);
    }
  });

  it('every recipe states in its header whether it was verified, and against what', () => {
    for (const name of SHIPPED) {
      const text = fs.readFileSync(path.join(RECIPES_DIR, `${name}.yaml`), 'utf-8');
      assert.match(text, /^# verified: (yes|no|partial) — /m, name);
    }
  });

  it('inline list/fetch on a connector override the shipped recipe; custom is inline only', () => {
    const r = recipeFor({ id: 't', recipe: 'linear', list: { tool: 'list_documents' }, fetch: { tool: 'get_document' } });
    assert.equal(r.list.tool, 'list_documents');
    assert.equal(r.list.ref, 'id', 'the rest of the shipped mapping survives');
    assert.throws(() => recipeFor({ id: 't', recipe: 'custom' }), /`list` is required/);
    assert.equal(recipeFor({ id: 't', recipe: 'custom', list: { static: '{{select.urls}}', ref: '$' }, fetch: { tool: 'fetch' } }).name, 'custom');
  });

  it('a recipe file can live in the repo, but a draft is never loaded by name', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'almagest-recipes-'));
    repos.push(dir);
    fs.writeFileSync(path.join(dir, 'mine.yaml'), YAML.stringify({ name: 'mine', list: { tool: 'x', ref: 'id' }, fetch: { tool: 'y' } }));
    fs.writeFileSync(path.join(dir, 'wip.draft.yaml'), YAML.stringify({ name: 'wip', list: { tool: 'x', ref: 'id' }, fetch: { tool: 'y' } }));
    assert.equal(recipeFor({ id: 't', recipe: './mine.yaml' }, { repoRoot: dir }).name, 'mine');
    assert.throws(() => recipeFor({ id: 't', recipe: 'wip' }, { dir }), /no recipe "wip"/);
    assert.throws(() => recipeFor({ id: 't', recipe: 'wip.draft' }, { dir }), /not a recipe name/);
  });

  it('names every problem in an invalid recipe at once', () => {
    assert.throws(
      () => validateRecipe({ name: 'bad', list: { tool: 'a', method: 'resources/list', items: 'x[' }, fetch: { render: 'pdf' }, resolve: [{}] }),
      (e) => ['more than one', 'list.ref is required', 'unclosed', 'fetch.render', 'resolve[0] needs', 'resolve[0].set'].every((m) => e.message.includes(m)),
    );
  });
});

describe('connectors init — drafting from tools/list', () => {
  const tools = [
    { name: 'delete_issue', inputSchema: { properties: { id: {} } } },
    { name: 'search_issues', inputSchema: { properties: { query: {} } } },
    { name: 'list_issues', description: 'List issues', inputSchema: { properties: { updated_after: {}, page_token: {}, page_size: {}, team: {} }, required: ['team'] } },
    { name: 'get_issue', inputSchema: { properties: { issue_id: {}, include: {} }, required: ['issue_id'] } },
    { name: 'get_user', inputSchema: { properties: { id: {} }, required: ['id'] } },
  ];

  it('pairs list*/get* by noun and never picks a write tool', () => {
    assert.equal(nounOf('list_issues'), 'issue');
    assert.equal(nounOf('searchDocuments'), 'document');
    const { list, fetch } = pickTools(tools);
    assert.equal(list.name, 'list_issues');
    assert.equal(fetch.name, 'get_issue');
    assert.ok(!pickTools([{ name: 'delete_all' }, { name: 'list_and_delete' }]).list);
  });

  it('guesses argument roles from the input schema', () => {
    assert.deepEqual(draftArgs(tools[2]), { updated_after: '{{since}}', page_token: '{{cursor}}', page_size: 50, team: '{{select.team}}' });
    assert.deepEqual(draftArgs(tools[3], { forFetch: true }), { issue_id: '{{item.ref}}' });
  });

  it('drafts a tools recipe that parses, validates, and is marked unverified', () => {
    const d = draftRecipe({ name: 'tracker', server: 'tracker', tools });
    assert.equal(d.suggestion, 'tools');
    assert.match(d.yaml, /verified: no/);
    assert.match(d.yaml, /TODO/);
    const parsed = YAML.parse(d.yaml);
    assert.equal(parsed.list.tool, 'list_issues');
    assert.equal(parsed.list.next_cursor.split(' | ')[0], 'nextCursor');
    assert.doesNotThrow(() => validateRecipe(parsed));
  });

  it('a server with resources is pointed at mcp-resources', () => {
    const d = draftRecipe({ name: 'files', server: 'files', tools: [], resources: [{ uri: 'file:///a' }] });
    assert.equal(d.suggestion, 'mcp-resources');
    assert.match(d.yaml, /recipe: mcp-resources/);
    assert.equal(YAML.parse(d.yaml).list.method, 'resources/list');
  });

  it('inspect reads tools/list and resources/list — and calls no tool', async () => {
    const repo = makeTempRepo({ files: { '.mcp.json': JSON.stringify({ mcpServers: { fake: { command: 'fake' } } }) } });
    repos.push(repo);
    const app = await makeApp({ repoRoot: repo });
    apps.push(app);
    const calls = [];
    const svc = createConnectors(app.ctx, { connect: memoryConnect({ current: { resources: [{ uri: 'file:///x', name: 'x', mimeType: 'text/plain', text: 'x' }] } }, calls) });
    const { tools: listed, resources } = await svc.inspect('fake');
    assert.ok(listed.some((t) => t.name === 'list_docs'));
    assert.equal(resources.length, 1);
    assert.ok(!calls.some((c) => c.tool), 'no tool was called');
    const d = draftRecipe({ name: 'fake', server: 'fake', tools: listed, resources });
    assert.equal(d.suggestion, 'mcp-resources');
    const noRes = draftRecipe({ name: 'fake', server: 'fake', tools: listed });
    assert.equal(YAML.parse(noRes.yaml).list.tool, 'list_docs');
    assert.equal(YAML.parse(noRes.yaml).fetch.tool, 'get_doc');
    await svc.stop();
  });
});
