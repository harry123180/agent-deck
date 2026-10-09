'use strict';
// Agent CLI presets (resume flags checked against each tool's own --help):
//   claude   --continue | --resume <id> | --session-id <uuid>
//   codex    resume --last | resume <id>
//   opencode --continue | --session <id>
//   gemini   --resume latest|<index>
//   agy      --continue | --conversation <id>
// Agent CLI presets. `start` runs on first launch, `resume` on every later launch
// (reboot / app restart). Both are plain shell commands and editable per tab,
// so any terminal-based agent tool works via the "custom" preset.
const AGENTS = {
  claude:   { label: 'Claude Code', start: 'claude',   resume: 'claude --continue' },
  codex:    { label: 'Codex',       start: 'codex',    resume: 'codex resume --last' },
  opencode: { label: 'OpenCode',    start: 'opencode', resume: 'opencode --continue' },
  gemini:   { label: 'Gemini CLI',  start: 'gemini',   resume: 'gemini --resume latest' },
  agy:      { label: 'agy',         start: 'agy',      resume: 'agy --continue' },
  shell:    { label: 'Shell only',  start: '',         resume: '' },
  custom:   { label: 'Custom',      start: '',         resume: '' },
};

// Command to type into the shell when a tab is (re)started.
function launchCommand(tab) {
  if (tab.autoRun === false) return '';
  const cmd = tab.launched ? (tab.resumeCmd || tab.startCmd) : tab.startCmd;
  return (cmd || '').trim();
}

module.exports = { AGENTS, launchCommand };
