/**
 * channels/index.mjs — the approval-channel registry.
 *
 * A channel is `{ kind, notify(event, payload), routes?(http), canApprove }`,
 * built by `create(ctx, channelConfig, deps)`. `governance.channels[]` picks
 * which run; `web` always does. An unknown kind stops the service at startup
 * — a typo in a channel name must not silently mean "nobody is told".
 *
 * Channels notify on bus events. A failed notification is logged and never
 * blocks the action that caused it.
 */
import * as email from './email.mjs';
import * as githubPr from './github-pr.mjs';
import * as mcp from './mcp.mjs';
import * as slack from './slack.mjs';
import * as web from './web.mjs';

export const CHANNELS = { web, mcp, slack, email, 'github-pr': githubPr };

export const NOTIFY_EVENTS = [
  'proposal.created', 'proposal.updated', 'proposal.approved', 'proposal.rejected', 'proposal.merged',
  'decision.created', 'decision.resolved',
];

export function createChannels(ctx, deps) {
  const configured = [...(ctx.config.governance.channels || [])];
  if (!configured.some((c) => c?.kind === 'web')) configured.unshift({ kind: 'web' });

  const seen = new Set();
  const channels = [];
  for (const cfg of configured) {
    const kind = cfg?.kind;
    const mod = CHANNELS[kind];
    if (!mod) throw new Error(`governance.channels: unknown channel kind "${kind}" — known: ${Object.keys(CHANNELS).join(', ')}`);
    if (seen.has(kind)) throw new Error(`governance.channels: "${kind}" is listed twice — one entry per kind`);
    seen.add(kind);
    const channel = mod.create(ctx, cfg, deps);
    channel.routes?.(ctx.http);
    channels.push(channel);
  }

  for (const event of NOTIFY_EVENTS) {
    ctx.bus.on(event, (payload) => Promise.all(channels.map(async (channel) => {
      try {
        await channel.notify?.(event, payload);
      } catch (err) {
        ctx.log.warn('channel notification failed', { channel: channel.kind, event, error: err.message });
      }
    })));
  }
  return channels;
}
