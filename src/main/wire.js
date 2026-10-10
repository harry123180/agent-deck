'use strict';
// Connect a card's agent CLI to the Agent Deck bus (the agentdeck MCP server) when the card starts.
//   Claude Code : --mcp-config <file>                       (central card also pre-approves the tools)
//   Codex       : -c mcp_servers.agentdeck.* overrides      (central: approve, other cards: prompt)
//   OpenCode    : OPENCODE_CONFIG_CONTENT env var, merged by OpenCode with the user's own config
//   agy         : only a global `agy mcp add`, so it is not done automatically
// Nothing here touches the user's own config files.
//
// The Codex flags avoid quotes on purpose: Windows PowerShell 5.1 drops embedded double quotes when it calls a native
// program, so a TOML array/string would arrive broken. Codex reads an unparsable TOML value as a plain string, and the
// launcher (.cmd) carries the rest, so plain key=value pairs are enough.

// "claude" / "codex" at the start of the command or right after `;` or `{` (the resume-with-fallback form has two)
const at = name => new RegExp(`(^|;\\s*|\\{\\s*)${name}(?=\\s|$)`, 'g');
const psQuote = s => (/[\s'";&|()]/.test(s) ? `"${String(s).replace(/"/g, '')}"` : s);

function wireCommand(command, { agent, title, central, mcpConfigFile, launcher }) {
  const cmd = String(command || '');
  if (!cmd.trim()) return cmd;
  if (agent === 'claude' && mcpConfigFile && !/--mcp-config/.test(cmd)) {
    const extra = ` --mcp-config ${psQuote(mcpConfigFile)}` + (central ? ' --allowedTools "mcp__agentdeck"' : '');
    return cmd.replace(at('claude'), `$1claude${extra}`);
  }
  if (agent === 'codex' && launcher && !/mcp_servers\.agentdeck/.test(cmd)) {
    const name = String(title || 'card').replace(/["'\r\n]/g, '');
    const extra = ` -c mcp_servers.agentdeck.command=${psQuote(launcher)}` +
      ` -c ${psQuote(`mcp_servers.agentdeck.env.AGENT_DECK_CARD=${name}`)}` +
      ` -c mcp_servers.agentdeck.default_tools_approval_mode=${central ? 'approve' : 'prompt'}`;
    return cmd.replace(at('codex'), `$1codex${extra}`);
  }
  return cmd;
}

// OpenCode merges this inline config with the user's own; an existing value is merged, never replaced.
function opencodeEnv(existing, { command, args, env, title }) {
  let cfg = {};
  try { cfg = existing ? JSON.parse(existing) : {}; } catch { cfg = {}; }
  cfg.mcp = { ...(cfg.mcp || {}), agentdeck: { type: 'local', command: [command, ...args], environment: { ...env, AGENT_DECK_CARD: String(title || 'card') }, enabled: true } };
  return JSON.stringify(cfg);
}

// .cmd launcher Codex can start without any quoted arguments
function launcherScript({ electron, server, busFile }) {
  return ['@echo off', 'set ELECTRON_RUN_AS_NODE=1', `set "AGENT_DECK_BUS=${busFile}"`, `"${electron}" "${server}"`, ''].join('\r\n');
}

module.exports = { wireCommand, opencodeEnv, launcherScript };
