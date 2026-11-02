// Per-bot resource sampling (memory + CPU) for the dashboard and admin views.
// Linux: reads /proc. Elsewhere: falls back to `ps`. Samples every 15s while a bot runs.
const fs = require('fs');
const { execFile } = require('child_process');

const samples = new Map(); // pid -> { cpuTicks, at, cpu, memMB, threads }
const CLK = 100; // USER_HZ on Linux

function readProc(pid) {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const ticks = Number(rest[11]) + Number(rest[12]); // utime + stime
  const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
  const rss = /VmRSS:\s+(\d+)/.exec(status);
  const thr = /Threads:\s+(\d+)/.exec(status);
  return { ticks, memMB: rss ? Number(rss[1]) / 1024 : 0, threads: thr ? Number(thr[1]) : 1 };
}

function sampleOne(pid) {
  const prev = samples.get(pid);
  const now = Date.now();
  if (fs.existsSync('/proc/self/stat')) {
    try {
      const p = readProc(pid);
      let cpu = prev ? prev.cpu : 0;
      if (prev && now > prev.at) cpu = Math.max(0, ((p.ticks - prev.ticks) / CLK) / ((now - prev.at) / 1000) * 100);
      samples.set(pid, { ticks: p.ticks, at: now, cpu, memMB: p.memMB, threads: p.threads });
    } catch (e) { samples.delete(pid); }
    return;
  }
  execFile('ps', ['-o', 'rss=,pcpu=', '-p', String(pid)], (err, out) => {
    if (err || !out.trim()) return samples.delete(pid);
    const [rss, cpu] = out.trim().split(/\s+/).map(Number);
    samples.set(pid, { at: Date.now(), cpu: cpu || 0, memMB: (rss || 0) / 1024, threads: 0 });
  });
}

function tick(pids) {
  const live = new Set(pids);
  for (const pid of live) sampleOne(pid);
  for (const pid of samples.keys()) if (!live.has(pid)) samples.delete(pid);
}

function get(pid) {
  const s = pid && samples.get(pid);
  if (!s) return null;
  return { memMB: Math.round(s.memMB * 10) / 10, cpu: Math.round(s.cpu * 10) / 10, threads: s.threads };
}

module.exports = { tick, get };
