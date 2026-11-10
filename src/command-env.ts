// The environment for commands an atoll runs on this machine. Archil's exec runs each command in a fresh
// microVM that sees nothing of the runner's environment, and local hands match it: a command gets only
// what a shell needs to find programs and format text. So it can't read the runner's Archil or model keys
// and write them into evidence, and a command that works here works the same on Archil.
//
// This is hygiene, not isolation. Local hands run as you, on your machine; isolation comes from Archil.

const PASSED = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TMPDIR", "TZ"] as const;

export function commandEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of PASSED) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}
