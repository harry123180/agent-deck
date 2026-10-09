param([string]$Exclude = '')
# Lists running cmd/PowerShell windows: pid, working directory, and which agent CLI (if any) runs inside.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public static class PCwd {
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint a, bool i, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr h, IntPtr b, byte[] buf, IntPtr size, out IntPtr read);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int c, byte[] pbi, int len, out int ret);
  public static string Get(int pid) {
    IntPtr h = OpenProcess(0x1010, false, pid);
    if (h == IntPtr.Zero) return null;
    try {
      byte[] pbi = new byte[48]; int r;
      if (NtQueryInformationProcess(h, 0, pbi, 48, out r) != 0) return null;
      long peb = BitConverter.ToInt64(pbi, 8);
      byte[] b = new byte[8]; IntPtr rd;
      if (!ReadProcessMemory(h, (IntPtr)(peb + 0x20), b, (IntPtr)8, out rd)) return null;
      long pp = BitConverter.ToInt64(b, 0);
      byte[] us = new byte[16];
      if (!ReadProcessMemory(h, (IntPtr)(pp + 0x38), us, (IntPtr)16, out rd)) return null;
      int len = BitConverter.ToUInt16(us, 0); long buf = BitConverter.ToInt64(us, 8);
      if (len == 0) return null;
      byte[] s = new byte[len];
      if (!ReadProcessMemory(h, (IntPtr)buf, s, (IntPtr)len, out rd)) return null;
      return Encoding.Unicode.GetString(s);
    } finally { CloseHandle(h); }
  }
}
"@

$procs = Get-CimInstance Win32_Process | Select-Object Name, ProcessId, ParentProcessId, CommandLine
$kids = @{}
foreach ($p in $procs) { if (-not $kids.ContainsKey([int]$p.ParentProcessId)) { $kids[[int]$p.ParentProcessId] = @() }; $kids[[int]$p.ParentProcessId] += $p }

# our own PTYs (and everything below them) must not be offered for import
$skip = New-Object 'System.Collections.Generic.HashSet[int]'
function Add-Tree($id) { if ($skip.Add($id) -and $kids.ContainsKey($id)) { foreach ($c in $kids[$id]) { Add-Tree ([int]$c.ProcessId) } } }
foreach ($x in ($Exclude -split ',' | Where-Object { $_ })) { Add-Tree ([int]$x) }

$agents = [ordered]@{
  claude   = '(^|[\\/ "])claude(\.exe|\.cmd)?("|\s|$)|claude-code'
  codex    = '(^|[\\/ "])codex(\.exe|\.cmd|\.js)?("|\s|$)|@openai[\\/]codex'
  opencode = 'opencode'
  gemini   = '(^|[\\/ "])gemini(\.exe|\.cmd)?("|\s|$)|gemini-cli'
  agy      = '(^|[\\/ "])agy(\.exe|\.cmd)?("|\s|$)'
}
function Get-Descendants($id) {
  if ($kids.ContainsKey($id)) { foreach ($c in $kids[$id]) { $c; Get-Descendants ([int]$c.ProcessId) } }
}

$out = @()
foreach ($p in $procs) {
  if ($p.Name -notin 'cmd.exe', 'powershell.exe', 'pwsh.exe') { continue }
  if ($skip.Contains([int]$p.ProcessId)) { continue }
  $cwd = [PCwd]::Get([int]$p.ProcessId)
  if (-not $cwd) { continue }
  $cwd = $cwd.TrimEnd('\'); if ($cwd.Length -eq 2) { $cwd += '\' }
  $agent = 'shell'
  foreach ($d in (Get-Descendants ([int]$p.ProcessId))) {
    if ($d.Name -eq 'conhost.exe') { continue }
    $line = "$($d.Name) $($d.CommandLine)"
    foreach ($k in $agents.Keys) { if ($line -match $agents[$k]) { $agent = $k; break } }
    if ($agent -ne 'shell') { break }
  }
  $out += [pscustomobject]@{ pid = [int]$p.ProcessId; shell = $p.Name; cwd = $cwd; agent = $agent }
}
ConvertTo-Json -InputObject @($out) -Compress
