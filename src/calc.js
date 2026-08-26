/* ======== Capacity calculation engine (unit-tested separately) ======== */
/* Canonical units: CPU millicores, memory GB. */
const Calc = {
  toMillicores(value, unit) { return unit === 'cores' ? value * 1000 : value; },
  fromMillicores(value, unit) { return unit === 'cores' ? value / 1000 : value; },
  // Baseline memory usage per pod: explicit memBaseline, defaulting to the request.
  memBaseline(w) {
    return Number(w.memBaseline) > 0 ? Number(w.memBaseline) : (Number(w.memRequest) || 0);
  },
  // Active burst tiers: [{pct, cpu, mem}], up to 3. cpu/mem of 0 mean "use baseline".
  burstTiers(w) {
    if (!w.burstEnabled) return [];
    const arr = Array.isArray(w.burstTiers)
      ? w.burstTiers
      : (w.burstPct > 0 && w.burstCpu > 0 ? [{ pct: w.burstPct, cpu: w.burstCpu }] : []);
    return arr
      .map((t) => ({ pct: Number(t && t.pct) || 0, cpu: Number(t && t.cpu) || 0, mem: Number(t && t.mem) || 0 }))
      .filter((t) => t.pct > 0 && (t.cpu > 0 || t.mem > 0))
      .slice(0, 3);
  },
  perPod(w, strategy) {
    const base = { cpu: Number(w.cpuRequest) || 0, mem: Calc.memBaseline(w) };
    // A tier's unset resource falls back to the baseline for that resource
    const tiers = Calc.burstTiers(w).map((t) => ({
      pct: t.pct,
      cpu: t.cpu > 0 ? t.cpu : base.cpu,
      mem: t.mem > 0 ? t.mem : base.mem,
    }));
    if (strategy === 'baseline') return { ...base };
    if (strategy === 'weighted') {
      let sum = 0, cpuPart = 0, memPart = 0;
      for (const t of tiers) {
        const p = Math.min(Math.max(t.pct, 0), 100) / 100;
        if (sum + p > 1) break;
        sum += p; cpuPart += p * t.cpu; memPart += p * t.mem;
      }
      return { cpu: (1 - sum) * base.cpu + cpuPart, mem: (1 - sum) * base.mem + memPart };
    }
    // worst: every pod at the hottest tier for each resource simultaneously
    const cpu = Math.max(w.cpuLimit || 0, base.cpu, ...tiers.map((t) => t.cpu));
    const mem = Math.max(w.memLimit || 0, base.mem, ...tiers.map((t) => t.mem));
    return { cpu, mem };
  },
  workloadDemand(w, strategy) {
    const pp = Calc.perPod(w, strategy);
    return { cpu: w.pods * pp.cpu, mem: w.pods * pp.mem };
  },
  totals(workloads, strategy) {
    return workloads.reduce((acc, w) => {
      const d = Calc.workloadDemand(w, strategy);
      acc.cpu += d.cpu; acc.mem += d.mem; return acc;
    }, { cpu: 0, mem: 0 });
  },
  // True when a resource has a usable capacity figure to divide by.
  capacitySet(capacity) {
    return !!capacity && capacity.cpu > 0 && capacity.mem > 0;
  },
  // Utilization is undefined without capacity: pct/headroom come back null and the
  // status is 'none' rather than a misleading 0% / 'fits'. A single missing resource
  // makes the overall verdict 'none' too — half a picture is not a verdict.
  assess(workloads, strategy, capacity, tightPct = 85) {
    const t = Calc.totals(workloads, strategy);
    const cpuSet = capacity && capacity.cpu > 0, memSet = capacity && capacity.mem > 0;
    const cpuPct = cpuSet ? (t.cpu / capacity.cpu) * 100 : null;
    const memPct = memSet ? (t.mem / capacity.mem) * 100 : null;
    const status = (pct) => (pct === null ? 'none' : pct > 100 ? 'over' : pct > tightPct ? 'tight' : 'fits');
    const bothSet = !!(cpuSet && memSet);
    const worstPct = bothSet ? Math.max(cpuPct, memPct) : null;
    return {
      strategy,
      capacitySet: bothSet,
      cpu: { used: t.cpu, pct: cpuPct, headroom: cpuSet ? capacity.cpu - t.cpu : null, status: status(cpuPct) },
      mem: { used: t.mem, pct: memPct, headroom: memSet ? capacity.mem - t.mem : null, status: status(memPct) },
      verdict: status(worstPct),
      binding: !bothSet ? 'none' : cpuPct === memPct ? 'balanced' : cpuPct > memPct ? 'cpu' : 'mem',
    };
  },
  morePodsFit(w, workloads, strategy, capacity) {
    const a = Calc.assess(workloads, strategy, capacity);
    if (!a.capacitySet) return null; // unknowable without capacity
    const pp = Calc.perPod(w, strategy);
    if (a.cpu.headroom < 0 || a.mem.headroom < 0) return 0;
    const byCpu = pp.cpu > 0 ? Math.floor(a.cpu.headroom / pp.cpu) : Infinity;
    const byMem = pp.mem > 0 ? Math.floor(a.mem.headroom / pp.mem) : Infinity;
    const n = Math.min(byCpu, byMem);
    return n === Infinity ? null : n;
  },
  // Max pods of workload w (all other workloads fixed) that keep BOTH resources
  // at or under thresholdPct of capacity. Whole pods, >= 0. Null when w has no
  // demand, or when capacity is unset (a break-point needs something to break against).
  maxPodsUnder(w, workloads, strategy, capacity, thresholdPct) {
    if (!Calc.capacitySet(capacity)) return null;
    const others = workloads.reduce((acc, o) => {
      if (o === w || (w.id != null && o.id === w.id)) return acc;
      const d = Calc.workloadDemand(o, strategy);
      acc.cpu += d.cpu; acc.mem += d.mem; return acc;
    }, { cpu: 0, mem: 0 });
    const pp = Calc.perPod(w, strategy);
    if (!(pp.cpu > 0) && !(pp.mem > 0)) return null;
    const th = thresholdPct / 100;
    const room = (cap, used, per) => (per > 0 ? Math.floor((cap * th - used) / per + 1e-9) : Infinity);
    return Math.max(0, Math.min(room(capacity.cpu, others.cpu, pp.cpu), room(capacity.mem, others.mem, pp.mem)));
  },
  // Parse a Kubernetes CPU quantity ("250m", "1", "1.5") -> millicores
  parseCpuQty(q) {
    if (q === undefined || q === null || q === '') return 0;
    const s = String(q).trim();
    if (s.endsWith('m')) return parseFloat(s) || 0;
    return (parseFloat(s) || 0) * 1000;
  },
  // Parse a Kubernetes memory quantity ("512Mi", "1Gi", "500M", "2G", "1073741824") -> GB (binary)
  parseMemQty(q) {
    if (q === undefined || q === null || q === '') return 0;
    const s = String(q).trim();
    const m = s.match(/^([0-9.]+)\s*(Ki|Mi|Gi|Ti|K|M|G|T|k)?i?$/i);
    if (!m) return 0;
    const n = parseFloat(m[1]) || 0;
    const unit = (m[2] || '').toLowerCase();
    const GiB = 1024 * 1024 * 1024;
    const bytes =
      unit === 'ki' ? n * 1024 :
      unit === 'mi' ? n * 1024 * 1024 :
      unit === 'gi' ? n * GiB :
      unit === 'ti' ? n * GiB * 1024 :
      unit === 'k' ? n * 1e3 :
      unit === 'm' ? n * 1e6 :
      unit === 'g' ? n * 1e9 :
      unit === 't' ? n * 1e12 :
      n; // plain bytes
    return bytes / GiB;
  },
  // Map a kubectl JSON dump (kind: List of Deployments/StatefulSets, or a single object)
  // to this app's workload shape. Returns [] when the JSON isn't a k8s dump.
  fromK8sList(d) {
    if (!d || typeof d !== 'object') return [];
    const items = Array.isArray(d.items) ? d.items : (d.kind && d.spec ? [d] : []);
    const out = [];
    for (const it of items) {
      const kind = it && it.kind;
      if (kind !== 'Deployment' && kind !== 'StatefulSet') continue;
      const name = it.metadata && it.metadata.name;
      if (!name) continue;
      const pods = Number(it.spec && it.spec.replicas);
      const containers =
        (it.spec && it.spec.template && it.spec.template.spec && it.spec.template.spec.containers) || [];
      let cpu = 0, mem = 0;
      for (const c of containers) {
        const req = (c.resources && c.resources.requests) || {};
        cpu += Calc.parseCpuQty(req.cpu);
        mem += Calc.parseMemQty(req.memory);
      }
      out.push({
        name,
        pods: Number.isFinite(pods) ? pods : 1,
        cpuRequest: cpu,
        memRequest: mem,
        memBaseline: mem,
        burstEnabled: false,
        burstTiers: [],
      });
    }
    return out;
  },
  // Memory the scheduler reserves but the workload doesn't use at baseline (GB, >= 0),
  // and the inverse: baseline usage above the reservation.
  strandedMem(w) {
    const gap = ((Number(w.memRequest) || 0) - Calc.memBaseline(w)) * (Number(w.pods) || 0);
    return { stranded: Math.max(0, gap), unreserved: Math.max(0, -gap) };
  },
  overcommit(workloads, capacity) {
    const t = workloads.reduce((acc, w) => {
      acc.cpu += w.pods * (w.cpuLimit || w.cpuRequest || 0);
      acc.mem += w.pods * (w.memLimit || w.memRequest || 0);
      return acc;
    }, { cpu: 0, mem: 0 });
    return {
      cpu: capacity.cpu > 0 ? t.cpu / capacity.cpu : 0,
      mem: capacity.mem > 0 ? t.mem / capacity.mem : 0,
    };
  },
};
if (typeof module !== "undefined") module.exports = Calc;
