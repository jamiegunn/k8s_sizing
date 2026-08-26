const { useState, useMemo, useRef, useEffect } = React;

/* ---------- Formatting helpers ---------- */
const fmtCores = (mc) => {
  const c = mc / 1000;
  return (Math.abs(c) >= 100 ? c.toFixed(0) : Math.abs(c) >= 10 ? c.toFixed(1) : c.toFixed(2)).replace(/\.0+$/, '') ;
};
const fmtCpu = (mc) => (Math.abs(mc) >= 1000 ? `${fmtCores(mc)} cores` : `${Math.round(mc)}m`);
const fmtMem = (gb) => {
  const a = Math.abs(gb);
  if (a >= 1024) {
    const t = gb / 1024;
    const v = Math.abs(t) >= 10 ? t.toFixed(1) : t.toFixed(2);
    return `${parseFloat(v)} TB`;
  }
  const v = a >= 100 ? gb.toFixed(0) : a >= 10 ? gb.toFixed(1) : gb.toFixed(2);
  return `${parseFloat(v)} GB`;
};
const fmtPct = (p) => `${p >= 999.5 ? Math.round(p) : p.toFixed(p >= 99.95 ? 0 : 1)}%`;
const uid = () => 'w' + Math.random().toString(36).slice(2, 9);

/* ---------- Sample data ---------- */
const SAMPLE_WORKLOADS = [
  { id: uid(), name: 'api-gateway', pods: 12, cpuRequest: 250, cpuLimit: 0, memRequest: 0.5, memBaseline: 0.75, memLimit: 0, burstEnabled: true, burstTiers: [{ pct: 10, cpu: 900, mem: 1.5 }, { pct: 5, cpu: 1500, mem: 0 }, { pct: 0, cpu: 0, mem: 0 }] },
  { id: uid(), name: 'order-service', pods: 8, cpuRequest: 500, cpuLimit: 0, memRequest: 1, memBaseline: 1, memLimit: 0, burstEnabled: false, burstTiers: [] },
  { id: uid(), name: 'postgres', pods: 3, cpuRequest: 1000, cpuLimit: 0, memRequest: 4, memBaseline: 4, memLimit: 0, burstEnabled: false, burstTiers: [] },
];

const STRATEGIES = [
  { key: 'baseline', title: 'Baseline', desc: 'Every pod at its baseline CPU and memory usage. Best case.' },
  { key: 'weighted', title: 'Expected (weighted)', desc: 'Baseline plus each burst option weighted by its share. Realistic.' },
  { key: 'worst', title: 'Worst case', desc: 'Every pod at its hottest burst CPU and memory at the same time.' },
];

const VERDICT_META = {
  fits: { icon: '✓', label: 'Fits' },
  tight: { icon: '△', label: 'Tight' },
  over: { icon: '✕', label: 'Over capacity' },
  none: { icon: '○', label: 'No capacity set' },
};

/* ---------- Small components ---------- */
function Verdict({ status }) {
  const m = VERDICT_META[status];
  return <span className={'verdict ' + status}><span aria-hidden="true">{m.icon}</span>{m.label}</span>;
}

function Meter({ label, used, capacity, pct, status, unit, delta }) {
  const unset = pct === null || pct === undefined;
  const width = unset ? 0 : Math.max(0, Math.min(100, pct));
  const fmt = unit === 'cpu' ? fmtCpu : fmtMem;
  const showDelta = !unset && delta !== null && delta !== undefined && Math.abs(delta) >= 0.05;
  return (
    <div className="meter-block">
      <div className="meter-top">
        <span className="m-label">{label}</span>
        <span className="m-val">
          <strong>{fmt(used)}</strong> of {unset ? '—' : <>{fmt(capacity)} · {fmtPct(pct)}</>}
          {showDelta && <span className={'delta ' + (delta > 0 ? 'up' : 'down')} title="Change vs snapshot">{delta > 0 ? '+' : '−'}{Math.abs(delta).toFixed(1)}</span>}
        </span>
      </div>
      <div className="meter" role="img" aria-label={unset ? `${label} — no capacity set` : `${label} ${fmtPct(pct)} used`}>
        <div className={'fill ' + status} style={{ width: width + '%' }} />
      </div>
    </div>
  );
}

function Seg({ options, value, onChange }) {
  return (
    <span className="seg" role="group">
      {options.map((o) => (
        <button key={o.value} type="button" className={value === o.value ? 'on' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </span>
  );
}

/* ---------- Strategy card ---------- */
function StrategyCard({ meta, assessment, capacity, snap }) {
  const a = assessment;
  // null pct would coerce to 0 in arithmetic, so only diff when both sides are real.
  const diff = (now, was) => (snap && now !== null && was !== null && was !== undefined ? now - was : null);
  const dCpu = diff(a.cpu.pct, snap && snap.cpu.pct);
  const dMem = diff(a.mem.pct, snap && snap.mem.pct);
  const bindingText =
    a.binding === 'none'
      ? 'Enter cluster capacity to see utilization'
      : a.binding === 'balanced'
      ? 'CPU and memory are equally utilized'
      : a.binding === 'cpu'
      ? 'CPU is the binding constraint'
      : 'Memory is the binding constraint';
  const headroom = (r, fmt) =>
    r.headroom === null ? '—' : r.headroom >= 0 ? fmt(r.headroom) : `−${fmt(-r.headroom)} short`;
  return (
    <div className="card">
      <div className="strat-head">
        <div>
          <h3>{meta.title}</h3>
          <div className="desc">{meta.desc}</div>
        </div>
        <Verdict status={a.verdict} />
      </div>
      <div className="strat-body">
        <Meter label="CPU" used={a.cpu.used} capacity={capacity.cpu} pct={a.cpu.pct} status={a.cpu.status} unit="cpu" delta={dCpu} />
        <div className="headroom">
          Headroom: <strong>{headroom(a.cpu, fmtCpu)}</strong>
        </div>
        <div style={{ height: 12 }} />
        <Meter label="Memory" used={a.mem.used} capacity={capacity.mem} pct={a.mem.pct} status={a.mem.status} unit="mem" delta={dMem} />
        <div className="headroom">
          Headroom: <strong>{headroom(a.mem, fmtMem)}</strong>
        </div>
        <div className="binding"><span className="dot" />{bindingText}</div>
      </div>
    </div>
  );
}

/* ---------- Workload form modal ---------- */
const BLANK = {
  name: '', pods: 1,
  cpuRequest: 250, cpuLimit: 0,
  memRequest: 0.5, memBaseline: 0, memLimit: 0,
  burstEnabled: false, burstTiers: [],
  pinned: false,
};

const padTiers = (src) => {
  let t = Array.isArray(src.burstTiers)
    ? src.burstTiers.map((x) => ({ pct: Number(x && x.pct) || 0, cpu: Number(x && x.cpu) || 0, mem: Number(x && x.mem) || 0 }))
    : (src.burstPct > 0 && src.burstCpu > 0 ? [{ pct: src.burstPct, cpu: src.burstCpu, mem: 0 }] : []);
  t = t.slice(0, 3);
  while (t.length < 3) t.push({ pct: 0, cpu: 0, mem: 0 });
  return t;
};

function WorkloadModal({ initial, existingNames, onSave, onClose }) {
  const [f, setF] = useState(() => {
    const base = initial ? { ...initial } : { ...BLANK };
    // Baseline memory shows blank when it just mirrors the request (the default)
    const memBaseline = Number(base.memBaseline) > 0 && Number(base.memBaseline) !== Number(base.memRequest) ? base.memBaseline : '';
    return { ...base, burstTiers: padTiers(base), memBaseline };
  });
  const [errors, setErrors] = useState([]);
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  const num = (k) => (e) => set(k, e.target.value === '' ? '' : Number(e.target.value));
  const setTier = (i, k) => (e) => setF((p) => {
    const t = p.burstTiers.map((x) => ({ ...x }));
    t[i][k] = e.target.value === '' ? '' : Number(e.target.value);
    return { ...p, burstTiers: t };
  });

  const validate = () => {
    const errs = [];
    if (!String(f.name).trim()) errs.push('Workload name is required.');
    else if (existingNames.includes(String(f.name).trim().toLowerCase())) errs.push('A workload with this name already exists.');
    if (!(Number(f.pods) >= 0) || !Number.isFinite(Number(f.pods))) errs.push('Pods must be 0 or more.');
    if (!(Number(f.cpuRequest) > 0)) errs.push('CPU request must be greater than 0.');
    if (!(Number(f.memRequest) > 0)) errs.push('Memory request must be greater than 0.');
    if (f.memBaseline !== '' && !(Number(f.memBaseline) > 0)) errs.push('Baseline memory must be greater than 0 (or leave it blank to match the request).');
    if (f.burstEnabled) {
      const tiers = f.burstTiers.map((t, i) => ({ i, pct: Number(t.pct) || 0, cpu: Number(t.cpu) || 0, mem: Number(t.mem) || 0 }));
      const active = tiers.filter((t) => t.pct > 0 || t.cpu > 0 || t.mem > 0);
      if (!active.length) errs.push('Add at least one burst option (share of pods plus burst CPU and/or memory).');
      active.forEach((t) => {
        if (!(t.pct > 0) || t.pct > 100) errs.push(`Burst option ${t.i + 1}: share of pods must be between 1 and 100%.`);
        if (!(t.cpu > 0) && !(t.mem > 0)) errs.push(`Burst option ${t.i + 1}: set a burst CPU, a burst memory, or both.`);
        if (t.cpu > 0 && t.cpu <= Number(f.cpuRequest)) errs.push(`Burst option ${t.i + 1}: burst CPU should be higher than the baseline request.`);
      });
      const sum = active.reduce((s, t) => s + t.pct, 0);
      if (sum > 100) errs.push(`Burst shares add up to ${sum}% — together they cannot exceed 100%.`);
    }
    return errs;
  };

  const submit = () => {
    const errs = validate();
    if (errs.length) { setErrors(errs); return; }
    onSave({
      id: f.id || uid(),
      name: String(f.name).trim(),
      pods: Math.round(Number(f.pods)),
      cpuRequest: Number(f.cpuRequest),
      cpuLimit: 0,
      memRequest: Number(f.memRequest),
      memBaseline: f.memBaseline === '' ? Number(f.memRequest) : Number(f.memBaseline),
      memLimit: 0,
      burstEnabled: !!f.burstEnabled,
      burstTiers: f.burstTiers.map((t) => ({ pct: Number(t.pct) || 0, cpu: Number(t.cpu) || 0, mem: Number(t.mem) || 0 })),
      pinned: !!f.pinned,
    });
  };

  const conv = (mc) => (mc > 0 ? `= ${(mc / 1000).toLocaleString(undefined, { maximumFractionDigits: 3 })} cores` : '');

  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={initial ? 'Edit workload' : 'Add workload'}>
        <div className="modal-head">
          <h3>{initial ? 'Edit workload' : 'Add workload'}</h3>
          <button className="btn-icon" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="modal-body">
          {errors.length > 0 && (
            <div className="form-err">{errors.map((e, i) => <div key={i}>• {e}</div>)}</div>
          )}
          <div className="fsection">Workload</div>
          <div className="frow">
            <div className="fgroup">
              <label>Name</label>
              <input type="text" value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. checkout-service" autoFocus />
            </div>
            <div className="fgroup">
              <label>Pods (replicas)</label>
              <input type="number" min="1" step="1" value={f.pods} onChange={num('pods')} />
            </div>
          </div>

          <div className="fsection">Resources per pod</div>
          <div className="frow">
            <div className="fgroup">
              <label>CPU request (millicores)</label>
              <input type="number" min="0" step="50" value={f.cpuRequest} onChange={num('cpuRequest')} />
              <div className="conv">{conv(Number(f.cpuRequest))}</div>
            </div>
            <div className="fgroup">
              <label>Memory request (GB)</label>
              <input type="number" min="0" step="0.25" value={f.memRequest} onChange={num('memRequest')} />
            </div>
          </div>
          <div className="frow">
            <div className="fgroup">
              <label>Baseline memory usage (GB) <span style={{ fontWeight: 400, color: 'var(--ink-muted)' }}>(may exceed the request)</span></label>
              <input type="number" min="0" step="0.25" value={f.memBaseline} onChange={num('memBaseline')} placeholder={`= request (${f.memRequest || 0} GB)`} />
              <div className="conv">Leave blank to match the memory request. Memory math uses this value.</div>
            </div>
          </div>

          <div className="fsection">Burst profile</div>
          <div className="switch-row">
            <button type="button" className={'switch' + (f.burstEnabled ? ' on' : '')} onClick={() => set('burstEnabled', !f.burstEnabled)} aria-pressed={f.burstEnabled} aria-label="Enable burst profile" />
            <div>
              <div className="sw-label">This workload bursts</div>
              <div className="sw-sub">Define up to 3 burst options — each is a share of pods running above baseline CPU and/or memory</div>
            </div>
          </div>
          {f.burstEnabled && (
            <div>
              {[0, 1, 2].map((i) => (
                <div className="frow triple" key={i}>
                  <div className="fgroup">
                    <label>Option {i + 1} — share (%)</label>
                    <input type="number" min="0" max="100" step="1" value={f.burstTiers[i].pct} onChange={setTier(i, 'pct')} />
                  </div>
                  <div className="fgroup">
                    <label>Burst CPU (m)</label>
                    <input type="number" min="0" step="50" value={f.burstTiers[i].cpu} onChange={setTier(i, 'cpu')} />
                    <div className="conv">{conv(Number(f.burstTiers[i].cpu))}</div>
                  </div>
                  <div className="fgroup">
                    <label>Burst memory (GB)</label>
                    <input type="number" min="0" step="0.25" value={f.burstTiers[i].mem} onChange={setTier(i, 'mem')} />
                    <div className="conv">{Number(f.burstTiers[i].mem) > 0 ? '' : '0 = baseline'}</div>
                  </div>
                </div>
              ))}
              <div className="cap-note">Leave an option at 0 to skip it. A burst CPU or memory of 0 falls back to that pod's baseline. Shares combined cannot exceed 100%.</div>
            </div>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={submit}>{initial ? 'Save changes' : 'Add workload'}</button>
        </div>
      </div>
    </div>
  );
}

/* ---------- Scaling runway chart ---------- */
const SERIES_CPU = '#2a78d6';   // categorical slot 1 (blue)
const SERIES_MEM = '#eb6834';   // categorical slot 2 (orange)

function RunwayChart({ w, workloads, capacity }) {
  const [hover, setHover] = useState(null); // pod count under cursor
  const pp = Calc.perPod(w, 'weighted');
  const others = workloads.reduce((acc, o) => {
    if (o.id === w.id) return acc;
    const d = Calc.workloadDemand(o, 'weighted');
    acc.cpu += d.cpu; acc.mem += d.mem; return acc;
  }, { cpu: 0, mem: 0 });
  const cpuAt = (p) => (capacity.cpu > 0 ? ((others.cpu + p * pp.cpu) / capacity.cpu) * 100 : 0);
  const memAt = (p) => (capacity.mem > 0 ? ((others.mem + p * pp.mem) / capacity.mem) * 100 : 0);
  const at100 = Calc.maxPodsUnder(w, workloads, 'weighted', capacity, 100);
  const pods = Math.max(0, Math.round(Number(w.pods) || 0));
  const xMax = Math.max(pods + 5, at100 !== null ? Math.ceil((at100 + 2) * 1.2) : pods * 2, 10);
  const yTop = Math.max(cpuAt(xMax), memAt(xMax), 112);
  const yMax = Math.min(200, Math.ceil(yTop / 25) * 25);

  const W = 520, H = 230, ml = 42, mr = 14, mt = 10, mb = 30;
  const X = (p) => ml + (p / xMax) * (W - ml - mr);
  const Y = (v) => mt + (1 - v / yMax) * (H - mt - mb);
  const xStep = Math.max(1, Math.ceil(xMax / 6 / 5) * 5);
  const xTicks = []; for (let p = 0; p <= xMax; p += xStep) xTicks.push(p);
  const yTicks = []; for (let v = 0; v <= yMax; v += 25) yTicks.push(v);
  const clampY = (v) => Math.max(0, Math.min(yMax, v));

  // continuous crossing of 100% on the binding series (for the break marker)
  const crossAt = (fn, per, cap, used) => (per > 0 && cap > 0 ? (cap - used) / per : Infinity);
  const cCpu = crossAt(cpuAt, pp.cpu, capacity.cpu, others.cpu);
  const cMem = crossAt(memAt, pp.mem, capacity.mem, others.mem);
  const cross = Math.min(cCpu, cMem);
  const showCross = cross >= 0 && cross <= xMax;

  const onMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const fx = ((e.clientX - rect.left) / rect.width) * W;
    const p = Math.round(((fx - ml) / (W - ml - mr)) * xMax);
    setHover(p >= 0 && p <= xMax ? p : null);
  };

  return (
    <div>
      <div className="legend-row" aria-hidden="false">
        <span className="legend-key"><span className="key-line" style={{ background: SERIES_CPU }} />CPU</span>
        <span className="legend-key"><span className="key-line" style={{ background: SERIES_MEM }} />Memory</span>
        <span className="legend-key"><span className="bp-warn">△ 85%</span></span>
        <span className="legend-key"><span className="bp-crit">✕ 100%</span></span>
      </div>
      <div className="chart-wrap">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Cluster utilization as ${w.name} scales from 0 to ${xMax} pods`}
             onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
          {yTicks.map((v) => (
            <g key={v}>
              <line x1={ml} x2={W - mr} y1={Y(v)} y2={Y(v)} stroke="#e1e0d9" strokeWidth="1" />
              <text x={ml - 6} y={Y(v) + 3.5} textAnchor="end" fontSize="10" fill="#898781" fontVariant="tabular-nums">{v}%</text>
            </g>
          ))}
          {xTicks.map((p) => (
            <text key={p} x={X(p)} y={H - 10} textAnchor="middle" fontSize="10" fill="#898781" fontVariant="tabular-nums">{p}</text>
          ))}
          <text x={(ml + W - mr) / 2} y={H - 0.5} textAnchor="middle" fontSize="9.5" fill="#898781">{w.name} pods</text>
          {/* thresholds */}
          <line x1={ml} x2={W - mr} y1={Y(85)} y2={Y(85)} stroke="#fab219" strokeWidth="1" />
          <line x1={ml} x2={W - mr} y1={Y(100)} y2={Y(100)} stroke="#d03b3b" strokeWidth="1" />
          {/* series */}
          <line x1={X(0)} y1={Y(clampY(cpuAt(0)))} x2={X(xMax)} y2={Y(clampY(cpuAt(xMax)))} stroke={SERIES_CPU} strokeWidth="2" strokeLinecap="round" />
          <line x1={X(0)} y1={Y(clampY(memAt(0)))} x2={X(xMax)} y2={Y(clampY(memAt(xMax)))} stroke={SERIES_MEM} strokeWidth="2" strokeLinecap="round" />
          {/* current pod count markers (surface-ringed dots) */}
          <line x1={X(pods)} x2={X(pods)} y1={mt} y2={H - mb} stroke="#c3c2b7" strokeWidth="1" />
          <circle cx={X(pods)} cy={Y(clampY(cpuAt(pods)))} r="4.5" fill={SERIES_CPU} stroke="#fff" strokeWidth="2" />
          <circle cx={X(pods)} cy={Y(clampY(memAt(pods)))} r="4.5" fill={SERIES_MEM} stroke="#fff" strokeWidth="2" />
          <text x={X(pods)} y={mt + 2} textAnchor="middle" fontSize="9.5" fill="#52514e" fontWeight="600">now: {pods}</text>
          {/* 100% crossing marker */}
          {showCross && (
            <g>
              <circle cx={X(cross)} cy={Y(100)} r="4.5" fill="#d03b3b" stroke="#fff" strokeWidth="2" />
              <text x={X(cross)} y={Y(100) - 8} textAnchor="middle" fontSize="9.5" fill="#a02525" fontWeight="700">✕ over past {at100}</text>
            </g>
          )}
          {/* hover crosshair */}
          {hover !== null && (
            <line x1={X(hover)} x2={X(hover)} y1={mt} y2={H - mb} stroke="#2a78d6" strokeWidth="1" opacity="0.5" />
          )}
        </svg>
        {hover !== null && (
          <div className="chart-tip" style={{ left: `${(X(hover) / W) * 100}%`, top: 0 }}>
            {hover} pods · CPU {fmtPct(cpuAt(hover))} · Mem {fmtPct(memAt(hover))}
          </div>
        )}
      </div>
    </div>
  );
}

function RunwayPanel({ w, workloads, capacity }) {
  const bp = (strategy, th) => Calc.maxPodsUnder(w, workloads, strategy, capacity, th);
  const cell = (v) => (v === null ? '—' : `${v} pods`);
  return (
    <div className="runway-panel">
      <h4>{w.name}</h4>
      <div className="sub">Expected (weighted) utilization as this workload scales; other workloads held fixed.</div>
      <RunwayChart w={w} workloads={workloads} capacity={capacity} />
      <table className="bp-table">
        <thead>
          <tr><th>Strategy</th><th><span className="bp-warn">△ stays under 85%</span></th><th><span className="bp-crit">✕ stays under 100%</span></th></tr>
        </thead>
        <tbody>
          <tr><td>Expected</td><td>{cell(bp('weighted', 85))}</td><td>{cell(bp('weighted', 100))}</td></tr>
          <tr><td>Worst case</td><td>{cell(bp('worst', 85))}</td><td>{cell(bp('worst', 100))}</td></tr>
        </tbody>
      </table>
    </div>
  );
}

/* ---------- Joint-fit grid ---------- */
const GRID_FILL = { fits: '#cfe6cf', tight: '#f8e6b8', over: '#f2cbcb' };

function JointGrid({ A, B, workloads, capacity }) {
  const [strat, setStrat] = useState('weighted');
  const [hover, setHover] = useState(null); // {a, b}
  const others = workloads.reduce((acc, o) => {
    if (o.id === A.id || o.id === B.id) return acc;
    const d = Calc.workloadDemand(o, strat);
    acc.cpu += d.cpu; acc.mem += d.mem; return acc;
  }, { cpu: 0, mem: 0 });
  const ppA = Calc.perPod(A, strat), ppB = Calc.perPod(B, strat);
  const lim = (pp) => {
    const byC = pp.cpu > 0 && capacity.cpu > 0 ? (capacity.cpu - others.cpu) / pp.cpu : Infinity;
    const byM = pp.mem > 0 && capacity.mem > 0 ? (capacity.mem - others.mem) / pp.mem : Infinity;
    const v = Math.min(byC, byM);
    return v === Infinity ? 20 : Math.max(0, v);
  };
  const aPods = Math.round(Number(A.pods) || 0), bPods = Math.round(Number(B.pods) || 0);
  const aMax = Math.max(Math.ceil(lim(ppA) * 1.15) + 1, aPods + 3, 8);
  const bMax = Math.max(Math.ceil(lim(ppB) * 1.15) + 1, bPods + 3, 8);
  const stepA = Math.max(1, Math.ceil((aMax + 1) / 34));
  const stepB = Math.max(1, Math.ceil((bMax + 1) / 26));
  const as = []; for (let a = 0; a <= aMax; a += stepA) as.push(a);
  const bs = []; for (let b = 0; b <= bMax; b += stepB) bs.push(b);

  const pctAt = (a, b) => ({
    cpu: capacity.cpu > 0 ? ((others.cpu + a * ppA.cpu + b * ppB.cpu) / capacity.cpu) * 100 : 0,
    mem: capacity.mem > 0 ? ((others.mem + a * ppA.mem + b * ppB.mem) / capacity.mem) * 100 : 0,
  });
  const statusAt = (a, b) => {
    const p = pctAt(a, b);
    const worst = Math.max(p.cpu, p.mem);
    return worst > 100 ? 'over' : worst > 85 ? 'tight' : 'fits';
  };

  const cell = 16, ml = 44, mb = 34, mt = 8, mr = 10;
  const W = ml + as.length * cell + mr;
  const H = mt + bs.length * cell + mb;
  const cx = (i) => ml + i * cell;
  const cy = (j) => mt + (bs.length - 1 - j) * cell; // b grows upward
  const nearIdx = (arr, v) => arr.reduce((best, x, i) => (Math.abs(x - v) < Math.abs(arr[best] - v) ? i : best), 0);
  const curI = nearIdx(as, aPods), curJ = nearIdx(bs, bPods);

  const onMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const fx = ((e.clientX - rect.left) / rect.width) * W;
    const fy = ((e.clientY - rect.top) / rect.height) * H;
    const i = Math.floor((fx - ml) / cell);
    const j = bs.length - 1 - Math.floor((fy - mt) / cell);
    if (i >= 0 && i < as.length && j >= 0 && j < bs.length) setHover({ i, j });
    else setHover(null);
  };

  const tickEveryA = Math.max(1, Math.ceil(as.length / 8));
  const tickEveryB = Math.max(1, Math.ceil(bs.length / 6));

  return (
    <div className="joint-section">
      <div className="joint-head">
        <div>
          <h4>Joint fit — {A.name} × {B.name}</h4>
          <div className="sub">Every combination of pod counts; other workloads held fixed.</div>
        </div>
        <span className="seg">
          <button type="button" className={strat === 'weighted' ? 'on' : ''} onClick={() => setStrat('weighted')}>Expected</button>
          <button type="button" className={strat === 'worst' ? 'on' : ''} onClick={() => setStrat('worst')}>Worst case</button>
        </span>
      </div>
      <div className="legend-row">
        <span className="legend-key"><span className="key-swatch" style={{ background: GRID_FILL.fits }} />✓ Fits</span>
        <span className="legend-key"><span className="key-swatch" style={{ background: GRID_FILL.tight }} />△ Tight (&gt;85%)</span>
        <span className="legend-key"><span className="key-swatch" style={{ background: GRID_FILL.over }} />✕ Over (&gt;100%)</span>
        <span className="legend-key">◎ current</span>
      </div>
      <div className="chart-wrap" style={{ maxWidth: Math.min(680, W) }}>
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Fit of ${A.name} pods versus ${B.name} pods`}
             onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
          {bs.map((b, j) => as.map((a, i) => (
            <rect key={a + '-' + b} x={cx(i) + 1} y={cy(j) + 1} width={cell - 2} height={cell - 2} rx="2"
                  fill={GRID_FILL[statusAt(a, b)]} />
          )))}
          {/* current combination */}
          <circle cx={cx(curI) + cell / 2} cy={cy(curJ) + cell / 2} r={cell / 2 - 2.5} fill="none" stroke="#14161a" strokeWidth="2" />
          {/* hover ring */}
          {hover && <rect x={cx(hover.i) + 0.5} y={cy(hover.j) + 0.5} width={cell - 1} height={cell - 1} rx="2" fill="none" stroke="#14161a" strokeWidth="1.2" />}
          {/* axes labels */}
          {as.map((a, i) => (i % tickEveryA === 0 ? <text key={'a' + a} x={cx(i) + cell / 2} y={H - mb + 12} textAnchor="middle" fontSize="9.5" fill="#898781" fontVariant="tabular-nums">{a}</text> : null))}
          {bs.map((b, j) => (j % tickEveryB === 0 ? <text key={'b' + b} x={ml - 6} y={cy(j) + cell / 2 + 3.5} textAnchor="end" fontSize="9.5" fill="#898781" fontVariant="tabular-nums">{b}</text> : null))}
          <text x={ml + (as.length * cell) / 2} y={H - 6} textAnchor="middle" fontSize="10" fill="#52514e">{A.name} pods →</text>
          <text x={12} y={mt + (bs.length * cell) / 2} textAnchor="middle" fontSize="10" fill="#52514e" transform={`rotate(-90 12 ${mt + (bs.length * cell) / 2})`}>{B.name} pods →</text>
        </svg>
        {hover && (() => {
          const a = as[hover.i], b = bs[hover.j];
          const p = pctAt(a, b);
          const st = statusAt(a, b);
          return (
            <div className="chart-tip" style={{ left: `${((cx(hover.i) + cell / 2) / W) * 100}%`, top: 0 }}>
              {A.name} {a} × {B.name} {b} · CPU {fmtPct(p.cpu)} · Mem {fmtPct(p.mem)} · {VERDICT_META[st === 'fits' ? 'fits' : st === 'tight' ? 'tight' : 'over'].label}
            </div>
          );
        })()}
      </div>
    </div>
  );
}

/* ---------- Persistence (graceful: falls back to in-memory when storage is unavailable) ---------- */
const STORAGE_KEY = 'cluster-capacity-planner-v1';
const SCENARIO_VERSION = 2; // v2: all memory values are GB (v1 stored MB)
const migrateScenario = (d) => {
  if (!d || typeof d !== 'object') return null;
  const legacy = !(d.version >= 2);
  const out = {
    capacity: d.capacity && typeof d.capacity === 'object' ? { ...d.capacity } : null,
    workloads: Array.isArray(d.workloads) ? d.workloads.map(normalizeWorkload) : null,
  };
  if (legacy) {
    if (out.capacity && out.capacity.memUnit === 'MiB' && out.capacity.memVal > 0) out.capacity.memVal = out.capacity.memVal / 1024;
    if (out.workloads) out.workloads = out.workloads.map((w) => ({ ...w, memRequest: (Number(w.memRequest) || 0) / 1024 }));
  }
  if (out.capacity) out.capacity.memUnit = out.capacity.memUnit === 'TB' ? 'TB' : 'GB';
  out.sort = d.sort && d.sort.key && (d.sort.dir === 1 || d.sort.dir === -1) ? { key: d.sort.key, dir: d.sort.dir } : null;
  out.snapshot = d.snapshot && Array.isArray(d.snapshot.workloads)
    ? { ...d.snapshot, workloads: d.snapshot.workloads.map(normalizeWorkload) }
    : null;
  out.focusA = typeof d.focusA === 'string' ? d.focusA : null;
  out.focusB = typeof d.focusB === 'string' ? d.focusB : null;
  return out;
};
const storage = (() => {
  try {
    const k = '__ccp_probe__';
    window.localStorage.setItem(k, '1');
    window.localStorage.removeItem(k);
    return window.localStorage;
  } catch (e) { return null; }
})();
const normalizeWorkload = (w) => {
  const base = { ...BLANK, ...w, id: w.id || uid(), cpuLimit: 0, memLimit: 0 };
  if (!(Number(base.memBaseline) > 0)) base.memBaseline = Number(base.memRequest) || 0;
  if (!Array.isArray(w.burstTiers) && w.burstPct > 0 && w.burstCpu > 0) base.burstTiers = [{ pct: w.burstPct, cpu: w.burstCpu, mem: 0 }];
  return base;
};
// Reject impossible imported data loudly instead of silently repairing it.
const importErrors = (workloadList) => {
  const errs = [];
  (workloadList || []).forEach((w, i) => {
    const label = w && w.name ? `"${w.name}"` : `workload #${i + 1}`;
    const n = (v) => Number(v) || 0;
    if (!Number.isFinite(Number(w.pods)) || Number(w.pods) < 0) errs.push(`${label}: pods must be 0 or more.`);
    if (n(w.cpuRequest) < 0 || n(w.memRequest) < 0 || n(w.memBaseline) < 0) errs.push(`${label}: negative resource values are not allowed.`);
    const tiers = Array.isArray(w.burstTiers) ? w.burstTiers : [];
    let sum = 0;
    tiers.forEach((t, j) => {
      const pct = n(t && t.pct), cpu = n(t && t.cpu), mem = n(t && t.mem);
      if (pct < 0 || cpu < 0 || mem < 0) errs.push(`${label}: burst option ${j + 1} has negative values.`);
      if (pct > 100) errs.push(`${label}: burst option ${j + 1} share exceeds 100%.`);
      if (pct > 0 && (cpu > 0 || mem > 0)) sum += pct;
    });
    if (w.burstEnabled && sum > 100) errs.push(`${label}: burst shares add up to ${sum}% — together they cannot exceed 100%.`);
  });
  return errs;
};

const SAVED = (() => {
  if (!storage) return null;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return migrateScenario(JSON.parse(raw));
  } catch (e) { return null; }
})();

/* ---------- App ---------- */
function App() {
  const [memVal, setMemVal] = useState(SAVED && SAVED.capacity && SAVED.capacity.memVal !== undefined ? SAVED.capacity.memVal : 64);
  const [memUnit, setMemUnit] = useState(SAVED && SAVED.capacity && SAVED.capacity.memUnit === 'TB' ? 'TB' : 'GB');
  const [cpuVal, setCpuVal] = useState(SAVED && SAVED.capacity && SAVED.capacity.cpuVal !== undefined ? SAVED.capacity.cpuVal : 24);
  const [cpuUnit, setCpuUnit] = useState(SAVED && SAVED.capacity && SAVED.capacity.cpuUnit === 'millicores' ? 'millicores' : 'cores');
  const [workloads, setWorkloads] = useState(
    SAVED && Array.isArray(SAVED.workloads) ? SAVED.workloads : SAMPLE_WORKLOADS
  );
  const [sort, setSort] = useState(SAVED && SAVED.sort && SAVED.sort.key ? SAVED.sort : null); // {key, dir: 1|-1}
  const [snapshot, setSnapshot] = useState(SAVED ? SAVED.snapshot : null);
  const [importError, setImportError] = useState(null); // {file, errors: []}
  const [focusA, setFocusA] = useState(SAVED ? SAVED.focusA : null);
  const [focusB, setFocusB] = useState(SAVED ? SAVED.focusB : null);

  // Autosave everything whenever it changes
  useEffect(() => {
    if (!storage) return;
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify({ version: SCENARIO_VERSION, capacity: { memVal, memUnit, cpuVal, cpuUnit }, workloads, sort, snapshot, focusA, focusB }));
    } catch (e) { /* quota or private mode — ignore */ }
  }, [memVal, memUnit, cpuVal, cpuUnit, workloads, sort, snapshot, focusA, focusB]);
  const [modal, setModal] = useState(null); // null | {mode:'add'} | {mode:'edit', workload}
  const fileRef = useRef(null);

  const capacity = useMemo(() => ({
    cpu: Calc.toMillicores(Number(cpuVal) || 0, cpuUnit),
    mem: (Number(memVal) || 0) * (memUnit === 'TB' ? 1024 : 1),
  }), [cpuVal, cpuUnit, memVal, memUnit]);

  const assessments = useMemo(
    () => STRATEGIES.map((s) => Calc.assess(workloads, s.key, capacity)),
    [workloads, capacity]
  );

  // Snapshot & delta
  const snapAssessments = useMemo(() => {
    if (!snapshot) return null;
    const scap = {
      cpu: Calc.toMillicores(Number(snapshot.cpuVal) || 0, snapshot.cpuUnit === 'millicores' ? 'millicores' : 'cores'),
      mem: (Number(snapshot.memVal) || 0) * (snapshot.memUnit === 'TB' ? 1024 : 1),
    };
    return STRATEGIES.map((s) => Calc.assess(snapshot.workloads, s.key, scap));
  }, [snapshot]);
  const takeSnapshot = () => setSnapshot(JSON.parse(JSON.stringify({
    memVal, memUnit, cpuVal, cpuUnit, workloads,
    at: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
  })));
  const revertSnapshot = () => {
    if (!snapshot) return;
    setMemVal(snapshot.memVal); setMemUnit(snapshot.memUnit === 'TB' ? 'TB' : 'GB');
    setCpuVal(snapshot.cpuVal); setCpuUnit(snapshot.cpuUnit === 'millicores' ? 'millicores' : 'cores');
    setWorkloads(JSON.parse(JSON.stringify(snapshot.workloads)));
  };

  const bumpPods = (id, d) => setWorkloads((prev) => prev.map((w) => (w.id === id ? { ...w, pods: Math.max(0, Math.round(Number(w.pods) || 0) + d) } : w)));

  // ----- Sorting & pinning -----
  const sortVal = (w, key) => {
    switch (key) {
      case 'name': return String(w.name).toLowerCase();
      case 'pods': return Number(w.pods) || 0;
      case 'cpu': return Number(w.cpuRequest) || 0;
      case 'mem': return Calc.memBaseline(w);
      case 'burst': return Calc.burstTiers(w).reduce((s, t) => s + t.pct, 0);
      case 'gap': { const g = Calc.strandedMem(w); return g.stranded - g.unreserved; }
      case 'footprint': return Calc.workloadDemand(w, 'weighted').cpu;
      case 'room': { const n = Calc.morePodsFit(w, workloads, 'weighted', capacity); return n === null ? -1 : n; }
      default: return 0;
    }
  };
  const sortGroup = (group) => {
    if (!sort) return group;
    return [...group].sort((a, b) => {
      const va = sortVal(a, sort.key), vb = sortVal(b, sort.key);
      const cmp = typeof va === 'string' ? va.localeCompare(vb) : va - vb;
      return cmp * sort.dir;
    });
  };
  const displayWorkloads = useMemo(() => {
    const pinned = workloads.filter((w) => w.pinned);
    const rest = workloads.filter((w) => !w.pinned);
    return [...sortGroup(pinned), ...sortGroup(rest)];
  }, [workloads, sort, capacity]);
  const clickSort = (key) => {
    setSort((s) => {
      if (!s || s.key !== key) return { key, dir: 1 };
      if (s.dir === 1) return { key, dir: -1 };
      return null; // third click clears the sort
    });
  };
  const togglePin = (id) => setWorkloads((prev) => prev.map((w) => (w.id === id ? { ...w, pinned: !w.pinned } : w)));

  const Th = ({ k, label, num }) => (
    <th
      className={(num ? 'num ' : '') + 'sortable'}
      onClick={() => clickSort(k)}
      title="Click to sort"
      aria-sort={sort && sort.key === k ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}
    >
      {label}
      <span className="sort-ind">{sort && sort.key === k ? (sort.dir === 1 ? '▲' : '▼') : ''}</span>
    </th>
  );

  const saveWorkload = (w) => {
    setWorkloads((prev) => {
      const i = prev.findIndex((p) => p.id === w.id);
      if (i === -1) return [...prev, w];
      const next = [...prev]; next[i] = w; return next;
    });
    setModal(null);
  };
  const deleteWorkload = (id) => setWorkloads((prev) => prev.filter((w) => w.id !== id));

  const exportJson = () => {
    const data = { version: SCENARIO_VERSION, capacity: { memVal, memUnit, cpuVal, cpuUnit }, workloads, sort };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'cluster-scenario.json';
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const importJson = (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const reject = (errors) => setImportError({ file: file.name, errors });
      try {
        const parsed = JSON.parse(reader.result);
        // kubectl dump? (kubectl get deploy,sts -A -o json) -> replace workloads, keep capacity
        const k8s = Calc.fromK8sList(parsed);
        if (k8s.length) {
          setWorkloads(k8s.map(normalizeWorkload));
          setImportError(null);
          e.target.value = '';
          return;
        }
        const m = migrateScenario(parsed);
        if (!m || (!m.capacity && !Array.isArray(m.workloads))) {
          reject(['The file is valid JSON but is neither a scenario export nor a kubectl workload dump.']);
          e.target.value = '';
          return;
        }
        if (Array.isArray(m.workloads)) {
          const errs = importErrors(m.workloads);
          if (errs.length) {
            reject(errs);
            e.target.value = '';
            return;
          }
        }
        if (m.capacity) {
          setMemVal(m.capacity.memVal); setMemUnit(m.capacity.memUnit === 'TB' ? 'TB' : 'GB');
          setCpuVal(m.capacity.cpuVal); setCpuUnit(m.capacity.cpuUnit === 'millicores' ? 'millicores' : 'cores');
        }
        if (Array.isArray(m.workloads)) setWorkloads(m.workloads);
        setSort(m.sort || null);
        setImportError(null);
      } catch { reject(['The file is not valid JSON.']); }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const resetAll = () => {
    setWorkloads(SAMPLE_WORKLOADS);
    setMemVal(64); setMemUnit('GB');
    setCpuVal(24); setCpuUnit('cores');
    setSort(null); setSnapshot(null); setFocusA(null); setFocusB(null);
    if (storage) { try { storage.removeItem(STORAGE_KEY); } catch (e) {} }
  };

  const existingNames = (excludeId) =>
    workloads.filter((w) => w.id !== excludeId).map((w) => w.name.toLowerCase());

  return (
    <div>
      <header className="app-header">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M8 1 L14.1 4.5 V11.5 L8 15 L1.9 11.5 V4.5 Z" stroke="#fff" strokeWidth="1.5" strokeLinejoin="round"/>
              <path d="M8 15 V8 M8 8 L1.9 4.5 M8 8 L14.1 4.5" stroke="#fff" strokeWidth="1.2" opacity="0.7"/>
            </svg>
          </div>
          <div>
            <h1>Cluster Capacity Planner</h1>
            <div className="sub">What-if sizing for Kubernetes workloads</div>
          </div>
        </div>
        <div className="header-actions">
          <button className="btn btn-ghost-light" onClick={resetAll} title="Clear saved data and restore the sample scenario">Reset</button>
          <button className="btn btn-ghost-light" onClick={() => fileRef.current && fileRef.current.click()} title="Load a saved scenario, or a live dump: kubectl get deploy,sts -A -o json > cluster.json">Import</button>
          <button className="btn btn-ghost-light" onClick={exportJson}>Export scenario</button>
          <input ref={fileRef} type="file" accept="application/json" style={{ display: 'none' }} onChange={importJson} />
        </div>
      </header>

      <div className="container">
        {importError && (
          <div className="import-banner" role="alert">
            <div className="import-banner-head">
              <strong>✕ Import rejected — {importError.file}</strong>
              <button className="btn-icon" onClick={() => setImportError(null)} aria-label="Dismiss import error">✕</button>
            </div>
            <div className="import-banner-body">
              Nothing was changed. Fix these in the file and import again:
              <ul>
                {importError.errors.slice(0, 8).map((er, i) => <li key={i}>{er}</li>)}
                {importError.errors.length > 8 && <li>…and {importError.errors.length - 8} more</li>}
              </ul>
            </div>
          </div>
        )}
        <div className="grid-main">
          {/* Cluster capacity */}
          <div className="card">
            <div className="card-head">
              <h2>Cluster capacity</h2>
              <span className="hint">Allocatable, not raw</span>
            </div>
            <div className="card-body">
              <div className="cap-field">
                <label htmlFor="cap-cpu">Total available CPU</label>
                <div className="cap-row">
                  <input id="cap-cpu" type="number" min="0" value={cpuVal} onChange={(e) => setCpuVal(e.target.value === '' ? '' : Number(e.target.value))} />
                  <Seg value={cpuUnit} onChange={setCpuUnit} options={[{ value: 'cores', label: 'cores' }, { value: 'millicores', label: 'm' }]} />
                </div>
                <div className="cap-note">{capacity.cpu > 0 ? `${capacity.cpu.toLocaleString()} millicores allocatable` : 'Enter the CPU your scheduler can allocate'}</div>
              </div>
              <div className="cap-field">
                <label htmlFor="cap-mem">Total available memory</label>
                <div className="cap-row">
                  <input id="cap-mem" type="number" min="0" value={memVal} onChange={(e) => setMemVal(e.target.value === '' ? '' : Number(e.target.value))} />
                  <Seg value={memUnit} onChange={setMemUnit} options={[{ value: 'GB', label: 'GB' }, { value: 'TB', label: 'TB' }]} />
                </div>
                <div className="cap-note">{capacity.mem > 0 ? `${fmtMem(capacity.mem)} allocatable` : 'Enter the memory your scheduler can allocate'}</div>
              </div>
            </div>
          </div>

          {/* Strategies — right side */}
          <div>
            <div className="snap-bar">
              {!snapshot ? (
                <button className="btn btn-secondary btn-sm" onClick={takeSnapshot}>◉ Snapshot plan</button>
              ) : (
                <React.Fragment>
                  <span className="snap-note">Comparing vs snapshot ({snapshot.at}) — deltas shown in points</span>
                  <button className="btn btn-secondary btn-sm" onClick={takeSnapshot}>Re-snapshot</button>
                  <button className="btn btn-secondary btn-sm" onClick={revertSnapshot}>Revert to snapshot</button>
                  <button className="btn btn-secondary btn-sm" onClick={() => setSnapshot(null)}>Clear</button>
                </React.Fragment>
              )}
            </div>
            <div className="strategies">
              {STRATEGIES.map((s, i) => (
                <StrategyCard key={s.key} meta={s} assessment={assessments[i]} capacity={capacity} snap={snapAssessments ? snapAssessments[i] : null} />
              ))}
            </div>
          </div>
        </div>

        {/* Workloads — full-width second row */}
        <div className="card workloads-row">
            <div className="card-head">
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
                <h2>Workloads</h2>
                {(() => {
                  const tot = workloads.reduce((acc, w) => {
                    const g = Calc.strandedMem(w);
                    acc.s += g.stranded; acc.u += g.unreserved; return acc;
                  }, { s: 0, u: 0 });
                  return (
                    <span className="hint">
                      {tot.s > 0.005 && <span className="gap-stranded">⤓ {fmtMem(tot.s)} stranded</span>}
                      {tot.s > 0.005 && tot.u > 0.005 && ' · '}
                      {tot.u > 0.005 && <span className="gap-unreserved">△ {fmtMem(tot.u)} unreserved</span>}
                    </span>
                  );
                })()}
              </div>
              <button className="btn btn-primary" onClick={() => setModal({ mode: 'add' })}>+ Add workload</button>
            </div>
            {workloads.length === 0 ? (
              <div className="empty">
                <div className="big">No workloads yet</div>
                <div>Add a workload to see whether it fits your cluster.</div>
              </div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table>
                  <thead>
                    <tr>
                      <th className="pin-col" aria-label="Pinned"></th>
                      <Th k="name" label="Workload" />
                      <Th k="pods" label="Pods" num />
                      <Th k="cpu" label="CPU / pod" num />
                      <Th k="mem" label="Memory / pod" num />
                      <Th k="burst" label="Burst" />
                      <Th k="gap" label="Mem gap" num />
                      <Th k="footprint" label="Footprint" num />
                      <Th k="room" label="Room for" num />
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {displayWorkloads.map((w) => {
                      const d = Calc.workloadDemand(w, 'weighted');
                      const more = Calc.morePodsFit(w, workloads, 'weighted', capacity);
                      return (
                        <tr key={w.id} className={w.pinned ? 'pinned-row' : ''}>
                          <td className="pin-col">
                            <button
                              className={'pin-btn' + (w.pinned ? ' on' : '')}
                              onClick={() => togglePin(w.id)}
                              aria-label={w.pinned ? `Unpin ${w.name}` : `Pin ${w.name} to top`}
                              title={w.pinned ? 'Unpin' : 'Pin to top'}
                            >
                              <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
                                <path d="M9.5 1.5 14.5 6.5 13 8l-.5-.5-3 3.5.5 3-1.5 1.5-3.5-3.5L1.5 15.5 1 15l3.5-3.5L1 8l1.5-1.5 3 .5L9 4l-.5-.5 1-2z" fill={w.pinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
                              </svg>
                            </button>
                          </td>
                          <td><div className="wl-name">{w.name}</div></td>
                          <td className="num">
                            <div className="stepper" title="Shift-click for ±5">
                              <button onClick={(e) => bumpPods(w.id, e.shiftKey ? -5 : -1)} aria-label={`Fewer ${w.name} pods`}>−</button>
                              <span className="stepper-val">{w.pods}</span>
                              <button onClick={(e) => bumpPods(w.id, e.shiftKey ? 5 : 1)} aria-label={`More ${w.name} pods`}>+</button>
                            </div>
                          </td>
                          <td className="num">{fmtCpu(w.cpuRequest)}</td>
                          <td className="num">
                            <div>{fmtMem(Calc.memBaseline(w))}</div>
                            {Calc.memBaseline(w) !== Number(w.memRequest) && <div className="wl-sub">req {fmtMem(w.memRequest)}</div>}
                          </td>
                          <td>
                            {Calc.burstTiers(w).length > 0
                              ? <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                                  {Calc.burstTiers(w).map((t, i) => (
                                    <span key={i} className="burst-tag">
                                      ▲ {t.pct}% @ {[t.cpu > 0 ? fmtCpu(t.cpu) : null, t.mem > 0 ? fmtMem(t.mem) : null].filter(Boolean).join(' · ')}
                                    </span>
                                  ))}
                                </div>
                              : <span className="wl-sub">—</span>}
                          </td>
                          <td className="num">
                            {(() => {
                              const g = Calc.strandedMem(w);
                              if (g.stranded > 0.005) return <span className="gap-stranded" title="Reserved by requests but unused at baseline — reclaimable by lowering requests">⤓ {fmtMem(g.stranded)}</span>;
                              if (g.unreserved > 0.005) return <span className="gap-unreserved" title="Baseline usage above the request — running on unreserved memory">△ {fmtMem(g.unreserved)}</span>;
                              return <span className="wl-sub">—</span>;
                            })()}
                          </td>
                          <td className="num">
                            <div>{fmtCpu(d.cpu)}</div>
                            <div className="wl-sub">{fmtMem(d.mem)}</div>
                          </td>
                          <td className="num">
                            {more === null ? <span className="wl-sub">—</span> : <span title="Additional pods of this workload that fit in remaining expected capacity">+{more} pods</span>}
                          </td>
                          <td className="num" style={{ whiteSpace: 'nowrap' }}>
                            <button className="btn-icon" onClick={() => setModal({ mode: 'edit', workload: w })} aria-label={`Edit ${w.name}`} title="Edit">
                              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M11.3 2.1a1.6 1.6 0 0 1 2.6 2.6l-8.2 8.2-3.2.9.9-3.2 7.9-8.5z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/></svg>
                            </button>
                            <button className="btn-danger-ghost" onClick={() => deleteWorkload(w.id)} aria-label={`Delete ${w.name}`} title="Delete">
                              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2.5 4h11M6.5 4V2.5h3V4m-6 0 .6 9.5h7.8L12.5 4M6.7 6.5v4.5M9.3 6.5v4.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
        </div>

        {/* Scaling runway — every figure here divides by capacity, so it needs one */}
        {workloads.length > 0 && !Calc.capacitySet(capacity) && (
          <div className="card workloads-row">
            <div className="card-head"><h2>Scaling runway</h2></div>
            <div className="empty">
              <div className="big">No capacity set</div>
              <div>Enter your cluster's allocatable CPU and memory above to see runway, break-points, and joint fit.</div>
            </div>
          </div>
        )}
        {workloads.length > 0 && Calc.capacitySet(capacity) && (() => {
          const fA = workloads.find((x) => x.id === focusA) || workloads[0];
          const fB = focusB && focusB !== fA.id ? workloads.find((x) => x.id === focusB) || null : null;
          return (
            <div className="card workloads-row">
              <div className="card-head">
                <h2>Scaling runway</h2>
                <div className="focus-selects">
                  <label htmlFor="focus-a">Focus A</label>
                  <select id="focus-a" value={fA.id} onChange={(e) => setFocusA(e.target.value)}>
                    {workloads.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                  </select>
                  <label htmlFor="focus-b">Focus B</label>
                  <select id="focus-b" value={fB ? fB.id : ''} onChange={(e) => setFocusB(e.target.value || null)}>
                    <option value="">None</option>
                    {workloads.filter((x) => x.id !== fA.id).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                  </select>
                </div>
              </div>
              <div className={'runway-grid' + (fB ? '' : ' single')}>
                <RunwayPanel w={fA} workloads={workloads} capacity={capacity} />
                {fB && <RunwayPanel w={fB} workloads={workloads} capacity={capacity} />}
              </div>
              {fB && <JointGrid A={fA} B={fB} workloads={workloads} capacity={capacity} />}
            </div>
          );
        })()}

        <div className="footnote">
          Sizing compares scheduled demand against allocatable capacity. All memory values are in GB.
          Weighted expected load treats the burst share as an average across pods. Node-level bin-packing and system-reserved overhead are not modeled.
          {' '}{storage ? 'Your inputs save automatically in this browser.' : 'Storage is unavailable in this viewer — use Export scenario to keep your inputs.'}
        </div>
      </div>

      {modal && (
        <WorkloadModal
          initial={modal.mode === 'edit' ? modal.workload : null}
          existingNames={existingNames(modal.mode === 'edit' ? modal.workload.id : null)}
          onSave={saveWorkload}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
