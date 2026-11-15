const os = require('os');
const { execFile } = require('child_process');

// CPU % is the busy share of CPU time between two consecutive calls
let prevCpuTimes = null;

function readCpuTimes() {
  let idle = 0, total = 0;
  for (const cpu of os.cpus()) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

function getCpuPercent() {
  const now = readCpuTimes();
  const prev = prevCpuTimes;
  prevCpuTimes = now;
  if (!prev) return null; // need two samples
  const totalDiff = now.total - prev.total;
  if (totalDiff <= 0) return null;
  return Math.round(Math.max(0, Math.min(100, (1 - (now.idle - prev.idle) / totalDiff) * 100)));
}

function execText(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 2000 }, (err, stdout) => resolve(err ? null : stdout));
  });
}

// macOS: match Activity Monitor's "Memory Used" (app memory + wired + compressed).
// os.freemem() on macOS treats cached files as used, which overstates usage.
async function getMemPercent() {
  const total = os.totalmem();
  if (process.platform === 'darwin') {
    const out = await execText('/usr/bin/vm_stat', []);
    if (out) {
      const pageSize = Number((out.match(/page size of (\d+) bytes/) || [])[1]) || 16384;
      const pages = (label) => {
        const m = out.match(new RegExp(`${label}:\\s+(\\d+)`));
        return m ? Number(m[1]) : 0;
      };
      const appMemory = pages('Anonymous pages') - pages('Pages purgeable');
      const used = (appMemory + pages('Pages wired down') + pages('Pages occupied by compressor')) * pageSize;
      if (used > 0) return Math.round(Math.max(0, Math.min(100, (used / total) * 100)));
    }
  }
  return Math.round(((total - os.freemem()) / total) * 100);
}

async function getSystemStats() {
  const mem = await getMemPercent();
  let cpu = getCpuPercent();
  if (cpu === null) {
    // First call: take a short second sample so the UI gets a real number immediately
    await new Promise(r => setTimeout(r, 250));
    cpu = getCpuPercent();
  }
  return { cpu: cpu === null ? 0 : cpu, mem };
}

module.exports = { getSystemStats };
