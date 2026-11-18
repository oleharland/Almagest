/**
 * channels/mcp.mjs — approval requests from a chat.
 *
 * A chat (WS4's `request_approval` tool) never approves. It asks
 * ctx.governance.createConfirmation(prpId, onBehalfOf, 'approve') and hands
 * the person the link or code it gets back. The person opens
 * /inbox/confirm/<code>, signed in as themselves, sees the proposal, and
 * presses the button — that press is the approval, recorded with channel
 * `mcp`. The code works once and expires (default 15 minutes,
 * `confirm_ttl_minutes`).
 *
 * Nothing to push: chats pull proposals through the MCP tools.
 */
export function create() {
  return {
    kind: 'mcp',
    canApprove: false,
    notify() {},
  };
}
