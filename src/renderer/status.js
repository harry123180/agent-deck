'use strict';
// Heuristic agent-state detection from the last lines of a terminal screen.
// Works for Claude Code / Codex / OpenCode / Gemini style TUIs; patterns are intentionally loose.
(function (root) {
  // Waiting for a decision (permission prompts, y/n, option pickers)
  const ASK = [
    /do you want to (proceed|make this edit|create|allow|run|continue)/i,
    /\(y\/n\)|\[y\/n\]|\[y\/N\]|\(Y\/n\)/,
    /allow (once|always|this)|always allow|approve (this|the)/i,
    /(^|\s)[❯>›]\s*1\.\s*(yes|allow|approve)/i,
    /yes, proceed|no, and tell|yes, and don't ask again|yes, allow/i,
    /enter to (select|confirm)|esc to cancel/i,
    /waiting for (your )?(approval|confirmation|input|response)/i,
    /would you like to|press enter to continue/i,
  ];
  // Actively working
  const WORK = [
    /esc to interrupt|esc interrupt|ctrl\+c to interrupt|press esc to stop|esc to cancel request/i,
    /[✻✽✶✳✢⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏·*●]\s*[A-Za-z]+(ing|ed)?…?\s*\(\d+(\.\d+)?\s*(s|m|ms)\b/,
    /\bworking\s*\(\d+/i,
    /thinking…|thinking\.\.\./i,
  ];
  // Failed / blocked
  const ERR = [
    /api error|rate.?limit|overloaded|usage limit|credit balance|quota (exceeded|exhausted)/i,
    /invalid api key|unauthorized|authentication (failed|error)|please run \/login|not logged in/i,
    /ECONNRESET|ETIMEDOUT|ENOTFOUND|connection (error|refused|lost)|network error|stream error/i,
    /command not found|is not recognized as|cannot find the path|no such file or directory/i,
    /^\s*(fatal|panic|error):|traceback \(most recent|unhandled (exception|rejection)|segmentation fault/i,
  ];

  const tail = (lines, n) => lines.filter(l => l.trim()).slice(-n);
  const hit = (list, lines) => {
    for (const l of lines) for (const re of list) if (re.test(l)) return l.trim();
    return null;
  };

  function detect(lines) {
    const t12 = tail(lines, 12);
    const ask = hit(ASK, t12);
    if (ask) return { kind: 'asking', line: ask };
    const work = hit(WORK, t12);
    if (work) return { kind: 'working', line: work };
    const err = hit(ERR, tail(lines, 6));
    if (err) return { kind: 'error', line: err };
    return { kind: null, line: '' };
  }

  const api = { detect };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Status = api;
})(typeof window !== 'undefined' ? window : globalThis);
