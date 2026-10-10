'use strict';
const assert = require('assert');
const { wireCommand, opencodeEnv, launcherScript } = require('../src/main/wire');

const o = { mcpConfigFile: 'C:\\Users\\me\\AppData\\Roaming\\agent-deck\\central\\mcp.json', launcher: 'C:\\Users\\me\\AppData\\Roaming\\agent-deck\\central\\agentdeck-mcp.cmd' };

// Claude: every `claude` of the resume-with-fallback form gets the MCP config; only the central card pre-approves
const fb = 'claude --resume abc; if ($LASTEXITCODE -ne 0) { claude --session-id abc }';
let w = wireCommand(fb, { ...o, agent: 'claude', title: 'docs' });
assert.strictEqual((w.match(/--mcp-config/g) || []).length, 2, w);
assert.ok(!w.includes('--allowedTools'), 'normal cards ask before using the tools');
assert.ok(w.startsWith('claude --mcp-config C:\\Users\\me\\AppData\\Roaming\\agent-deck\\central\\mcp.json --resume abc;'), w);
w = wireCommand('claude --continue', { ...o, agent: 'claude', central: true });
assert.ok(w.includes('--allowedTools "mcp__agentdeck"'), w);
// already wired -> unchanged; paths with spaces are quoted
assert.strictEqual(wireCommand('claude --mcp-config x', { ...o, agent: 'claude' }), 'claude --mcp-config x');
assert.ok(wireCommand('claude', { ...o, agent: 'claude', mcpConfigFile: 'C:\\My Dir\\mcp.json' }).includes('--mcp-config "C:\\My Dir\\mcp.json"'));
// a word that merely contains "claude" is not touched
assert.strictEqual(wireCommand('echo myclaude', { ...o, agent: 'claude' }), 'echo myclaude');

// Codex: quote-free -c overrides, identity per card, approval mode by role
w = wireCommand('codex resume --last', { ...o, agent: 'codex', title: 'backend' });
assert.ok(w.startsWith('codex -c mcp_servers.agentdeck.command=C:\\Users\\me\\AppData\\Roaming\\agent-deck\\central\\agentdeck-mcp.cmd'), w);
assert.ok(w.includes('-c mcp_servers.agentdeck.env.AGENT_DECK_CARD=backend'), w);
assert.ok(w.includes('default_tools_approval_mode=prompt') && w.endsWith(' resume --last'), w);
assert.ok(!/=\[|\{ /.test(w), 'no TOML arrays/inline tables that PowerShell 5.1 would break');
assert.ok(wireCommand('codex', { ...o, agent: 'codex', title: 'my card', central: true }).includes('-c "mcp_servers.agentdeck.env.AGENT_DECK_CARD=my card"'));
assert.ok(wireCommand('codex', { ...o, agent: 'codex', central: true }).includes('approval_mode=approve'));

// other agents and empty commands are left alone
assert.strictEqual(wireCommand('opencode --continue', { ...o, agent: 'opencode' }), 'opencode --continue');
assert.strictEqual(wireCommand('', { ...o, agent: 'claude' }), '');

// OpenCode inline config: merged into an existing value, never replacing the user's servers
const spec = { command: 'electron.exe', args: ['mcp-server.js'], env: { ELECTRON_RUN_AS_NODE: '1', AGENT_DECK_BUS: 'bus.json' }, title: 'docs' };
let c = JSON.parse(opencodeEnv('', spec));
assert.deepStrictEqual(c.mcp.agentdeck.command, ['electron.exe', 'mcp-server.js']);
assert.strictEqual(c.mcp.agentdeck.environment.AGENT_DECK_CARD, 'docs');
c = JSON.parse(opencodeEnv(JSON.stringify({ model: 'x', mcp: { mine: { type: 'remote' } } }), spec));
assert.ok(c.mcp.mine && c.mcp.agentdeck && c.model === 'x');
c = JSON.parse(opencodeEnv('not json', spec));
assert.ok(c.mcp.agentdeck);

// launcher: no echo (stdout is the MCP channel), env set, both paths quoted
const l = launcherScript({ electron: 'C:\\E\\electron.exe', server: 'D:\\x\\mcp-server.js', busFile: 'C:\\a b\\bus.json' });
assert.ok(l.startsWith('@echo off') && l.includes('set ELECTRON_RUN_AS_NODE=1') && l.includes('set "AGENT_DECK_BUS=C:\\a b\\bus.json"'));
assert.ok(l.includes('"C:\\E\\electron.exe" "D:\\x\\mcp-server.js"'));
console.log('wire tests passed');
