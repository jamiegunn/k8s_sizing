const Calc = require('./src/calc.js');
const assert = require('assert');
const approx = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

// Unit conversions (memory is GB-native; only CPU converts)
approx(Calc.toMillicores(2, 'cores'), 2000);
approx(Calc.toMillicores(500, 'millicores'), 500);

const web = {
  name: 'web', pods: 10,
  cpuRequest: 200, cpuLimit: 400,
  memRequest: 0.5, memLimit: 1,
  burstEnabled: true, burstTiers: [{ pct: 10, cpu: 800 }],
};
const db = {
  name: 'db', pods: 3,
  cpuRequest: 1000, cpuLimit: 2000,
  memRequest: 4, memLimit: 8,
  burstEnabled: false, burstTiers: [],
};

// Baseline: web 10*200=2000 cpu, 10*0.5=5 GB; db 3*1000=3000, 3*4=12 GB
let t = Calc.totals([web, db], 'baseline');
approx(t.cpu, 5000); approx(t.mem, 17);

// Weighted: web cpu/pod = 0.9*200 + 0.1*800 = 260 -> 2600; db unchanged 3000
t = Calc.totals([web, db], 'weighted');
approx(t.cpu, 5600); approx(t.mem, 17);

// Worst: web cpu/pod = max(400, 800, 200)=800 -> 8000; mem 1*10=10 GB
//        db cpu/pod = max(2000,0,1000)=2000 -> 6000; mem 8*3=24 GB
t = Calc.totals([web, db], 'worst');
approx(t.cpu, 14000); approx(t.mem, 34);

// Assess: capacity 16 cores / 32 GB
const cap = { cpu: 16000, mem: 32 };
let a = Calc.assess([web, db], 'baseline', cap);
approx(a.cpu.pct, 31.25); approx(a.mem.pct, 53.125);
assert.equal(a.verdict, 'fits'); assert.equal(a.binding, 'mem');
approx(a.cpu.headroom, 11000); approx(a.mem.headroom, 15);

a = Calc.assess([web, db], 'worst', cap);
approx(a.cpu.pct, 87.5); approx(a.mem.pct, 106.25);
assert.equal(a.cpu.status, 'tight');
assert.equal(a.mem.status, 'over');
assert.equal(a.verdict, 'over'); assert.equal(a.binding, 'mem');

// Tight band boundary: exactly 85% is fits, just above is tight, exactly 100 is tight, >100 over
const one = { name: 'x', pods: 1, cpuRequest: 850, cpuLimit: 0, memRequest: 1, memLimit: 0, burstEnabled: false };
a = Calc.assess([one], 'baseline', { cpu: 1000, mem: 1000 });
assert.equal(a.cpu.status, 'fits');
a = Calc.assess([{ ...one, cpuRequest: 851 }], 'baseline', { cpu: 1000, mem: 1000 });
assert.equal(a.cpu.status, 'tight');
a = Calc.assess([{ ...one, cpuRequest: 1000 }], 'baseline', { cpu: 1000, mem: 1000 });
assert.equal(a.cpu.status, 'tight');
a = Calc.assess([{ ...one, cpuRequest: 1001 }], 'baseline', { cpu: 1000, mem: 1000 });
assert.equal(a.cpu.status, 'over');

// Burst disabled means tiers ignored even if set
const sneaky = { ...web, burstEnabled: false };
approx(Calc.totals([sneaky], 'weighted').cpu, 2000);
approx(Calc.totals([sneaky], 'worst').cpu, 4000); // limit 400 * 10

// No limits set: worst falls back to request/burst
const noLim = { name: 'n', pods: 2, cpuRequest: 100, cpuLimit: 0, memRequest: 0.25, memLimit: 0, burstEnabled: true, burstTiers: [{ pct: 50, cpu: 300 }] };
t = Calc.totals([noLim], 'worst');
approx(t.cpu, 600); approx(t.mem, 0.5);
t = Calc.totals([noLim], 'weighted');
approx(t.cpu, 2 * (0.5 * 100 + 0.5 * 300)); // 400

// --- Multi-tier burst (3 options) ---
const multi = {
  name: 'm', pods: 10, cpuRequest: 200, cpuLimit: 400, memRequest: 0.5, memLimit: 1,
  burstEnabled: true,
  burstTiers: [{ pct: 10, cpu: 800 }, { pct: 5, cpu: 1200 }, { pct: 2, cpu: 2000 }],
};
// weighted/pod = 0.83*200 + 0.10*800 + 0.05*1200 + 0.02*2000 = 166 + 80 + 60 + 40 = 346
approx(Calc.totals([multi], 'weighted').cpu, 3460);
// worst/pod = max(400, 2000, 200) = 2000
approx(Calc.totals([multi], 'worst').cpu, 20000);
// baseline unchanged
approx(Calc.totals([multi], 'baseline').cpu, 2000);

// Empty/partial tiers are ignored
const partial = { ...multi, burstTiers: [{ pct: 10, cpu: 800 }, { pct: 0, cpu: 500 }, { pct: 5, cpu: 0 }] };
approx(Calc.totals([partial], 'weighted').cpu, 10 * (0.9 * 200 + 0.1 * 800)); // 2600
approx(Calc.totals([partial], 'worst').cpu, 8000); // max(400,800,200)=800

// Legacy single-tier fields still work (imported old scenarios)
const legacy = { ...multi, burstTiers: undefined, burstPct: 10, burstCpu: 800 };
approx(Calc.totals([legacy], 'weighted').cpu, 2600);
approx(Calc.totals([legacy], 'worst').cpu, 8000);

// morePodsFit: weighted web eff cpu 260, mem 0.5 GB. Remaining under weighted: cpu 16000-5600=10400, mem 32-17=15
// byCpu = floor(10400/260)=40, byMem = floor(15/0.5)=30 -> 30
assert.equal(Calc.morePodsFit(web, [web, db], 'weighted', cap), 30);
// Over capacity -> 0
assert.equal(Calc.morePodsFit(web, [web, db], 'worst', cap), 0);

// Overcommit: cpu limits = 10*400 + 3*2000 = 10000 -> 0.625x; mem = 10*1+3*8=34 -> 1.0625x
const oc = Calc.overcommit([web, db], cap);
approx(oc.cpu, 0.625); approx(oc.mem, 1.0625);
// Limit fallback to request
const ocf = Calc.overcommit([noLim], { cpu: 1000, mem: 1 });
approx(ocf.cpu, 0.2); approx(ocf.mem, 0.5);

// --- Baseline memory (defaults to request; may exceed it) ---
const bm = { name: 'bm', pods: 4, cpuRequest: 500, cpuLimit: 0, memRequest: 0.5, memBaseline: 0.75, memLimit: 0, burstEnabled: false };
approx(Calc.memBaseline(bm), 0.75);
approx(Calc.totals([bm], 'baseline').mem, 3);   // 4 * 0.75, NOT 4 * 0.5
approx(Calc.totals([bm], 'weighted').mem, 3);
approx(Calc.totals([bm], 'worst').mem, 3);
// default: baseline == request when unset
approx(Calc.memBaseline({ memRequest: 2 }), 2);

// --- Burst tiers with memory ---
const bt = {
  name: 'bt', pods: 10, cpuRequest: 200, cpuLimit: 0, memRequest: 0.5, memBaseline: 0.5, memLimit: 0,
  burstEnabled: true,
  burstTiers: [{ pct: 10, cpu: 800, mem: 2 }],
};
// weighted mem/pod = 0.9*0.5 + 0.1*2 = 0.65 -> 6.5 ; cpu = 0.9*200+0.1*800=260 -> 2600
approx(Calc.totals([bt], 'weighted').mem, 6.5);
approx(Calc.totals([bt], 'weighted').cpu, 2600);
// worst mem/pod = max(0.5, 2) = 2 -> 20
approx(Calc.totals([bt], 'worst').mem, 20);
// baseline untouched by tiers
approx(Calc.totals([bt], 'baseline').mem, 5);

// Tier without mem falls back to baseline memory
const btNoMem = { ...bt, memBaseline: 0.75, burstTiers: [{ pct: 10, cpu: 800, mem: 0 }] };
approx(Calc.totals([btNoMem], 'weighted').mem, 7.5); // (0.9*0.75 + 0.1*0.75) * 10
approx(Calc.totals([btNoMem], 'worst').mem, 7.5);

// Memory-only tier (no burst CPU): cpu falls back to baseline request
const memOnly = { ...bt, burstTiers: [{ pct: 20, cpu: 0, mem: 4 }] };
approx(Calc.totals([memOnly], 'weighted').cpu, 2000); // cpu unchanged
approx(Calc.totals([memOnly], 'weighted').mem, 10 * (0.8 * 0.5 + 0.2 * 4)); // 12
approx(Calc.totals([memOnly], 'worst').mem, 40);

// --- maxPodsUnder (break-point math) ---
// web: weighted pp = {cpu 260, mem 0.5}; db fixed = {cpu 3000, mem 12}
// 100%: cpu room = floor((16000-3000)/260)=50 ; mem room = floor((32-12)/0.5)=40 -> 40
assert.equal(Calc.maxPodsUnder(web, [web, db], 'weighted', cap, 100), 40);
// 85%: cpu floor((13600-3000)/260)=40 ; mem floor((27.2-12)/0.5)=30 -> 30
assert.equal(Calc.maxPodsUnder(web, [web, db], 'weighted', cap, 85), 30);
// Worst strategy: web pp = {cpu 800, mem 1}; db fixed = {cpu 6000, mem 24}
// 100%: cpu floor(10000/800)=12 ; mem floor(8/1)=8 -> 8
assert.equal(Calc.maxPodsUnder(web, [web, db], 'worst', cap, 100), 8);
// Current pods (10) + morePodsFit under weighted should equal maxPodsUnder at 100%
assert.equal(10 + Calc.morePodsFit(web, [web, db], 'weighted', cap), Calc.maxPodsUnder(web, [web, db], 'weighted', cap, 100));
// Others already over threshold -> clamps to 0
assert.equal(Calc.maxPodsUnder(web, [web, { ...db, pods: 300 }], 'weighted', cap, 100), 0);
// Workload with no demand -> null
assert.equal(Calc.maxPodsUnder({ id: 'z', pods: 1, cpuRequest: 0, memRequest: 0, burstEnabled: false }, [web], 'weighted', cap, 100), null);

// --- Kubernetes quantity parsing ---
approx(Calc.parseCpuQty('250m'), 250);
approx(Calc.parseCpuQty('1'), 1000);
approx(Calc.parseCpuQty('1.5'), 1500);
approx(Calc.parseCpuQty(''), 0);
approx(Calc.parseMemQty('1Gi'), 1);
approx(Calc.parseMemQty('512Mi'), 0.5);
approx(Calc.parseMemQty('1536Mi'), 1.5);
approx(Calc.parseMemQty('2Ti'), 2048);
approx(Calc.parseMemQty('1073741824'), 1);          // plain bytes
approx(Calc.parseMemQty('1G'), 1e9 / (1024 ** 3));  // decimal G -> ~0.931 GB
assert.equal(Calc.parseMemQty('garbage'), 0);

// --- kubectl dump mapping ---
const dump = {
  kind: 'List',
  items: [
    {
      kind: 'Deployment', metadata: { name: 'checkout' },
      spec: { replicas: 6, template: { spec: { containers: [
        { resources: { requests: { cpu: '250m', memory: '512Mi' } } },
        { resources: { requests: { cpu: '50m', memory: '128Mi' } } },   // sidecar sums in
      ] } } },
    },
    {
      kind: 'StatefulSet', metadata: { name: 'kafka' },
      spec: { replicas: 3, template: { spec: { containers: [
        { resources: { requests: { cpu: '1', memory: '4Gi' } } },
      ] } } },
    },
    { kind: 'Service', metadata: { name: 'ignored' } },                  // non-workload kinds skipped
    { kind: 'Deployment', metadata: { name: 'no-requests' },
      spec: { replicas: 2, template: { spec: { containers: [{}] } } } }, // missing requests -> zeros
  ],
};
const mapped = Calc.fromK8sList(dump);
assert.equal(mapped.length, 3);
assert.equal(mapped[0].name, 'checkout');
assert.equal(mapped[0].pods, 6);
approx(mapped[0].cpuRequest, 300);
approx(mapped[0].memRequest, 0.625);
approx(mapped[0].memBaseline, 0.625);
assert.equal(mapped[1].name, 'kafka');
approx(mapped[1].cpuRequest, 1000);
approx(mapped[1].memRequest, 4);
assert.equal(mapped[2].name, 'no-requests');
approx(mapped[2].cpuRequest, 0);
// Not a k8s dump -> []
assert.equal(Calc.fromK8sList({ capacity: {}, workloads: [] }).length, 0);

// --- Stranded memory ---
const st = Calc.strandedMem({ pods: 4, memRequest: 2, memBaseline: 1.5 });
approx(st.stranded, 2); approx(st.unreserved, 0);
const un = Calc.strandedMem({ pods: 4, memRequest: 0.5, memBaseline: 0.75 });
approx(un.stranded, 0); approx(un.unreserved, 1);
const eq = Calc.strandedMem({ pods: 4, memRequest: 1, memBaseline: 1 });
approx(eq.stranded, 0); approx(eq.unreserved, 0);

// --- No capacity set: never a verdict, never 0% ---
// Utilization is undefined without a divisor. Reporting 0% (and therefore "fits")
// for an unset capacity is a wrong answer in the reassuring direction.
a = Calc.assess([web], 'baseline', { cpu: 0, mem: 0 });
assert.equal(a.capacitySet, false);
assert.strictEqual(a.cpu.pct, null); assert.strictEqual(a.mem.pct, null);
assert.strictEqual(a.cpu.headroom, null); assert.strictEqual(a.mem.headroom, null);
assert.equal(a.cpu.status, 'none'); assert.equal(a.mem.status, 'none');
assert.equal(a.verdict, 'none'); assert.equal(a.binding, 'none');
// Demand is still reported — it's known, only the comparison isn't
approx(a.cpu.used, 2000); approx(a.mem.used, 5);

// One resource missing is still no verdict — half a picture is not a verdict
a = Calc.assess([web], 'baseline', { cpu: 16000, mem: 0 });
assert.equal(a.capacitySet, false);
approx(a.cpu.pct, 12.5); assert.equal(a.cpu.status, 'fits'); // the known side still resolves
assert.strictEqual(a.mem.pct, null); assert.equal(a.mem.status, 'none');
assert.equal(a.verdict, 'none'); assert.equal(a.binding, 'none');

// Missing/garbage capacity objects don't throw
assert.equal(Calc.assess([web], 'baseline', null).verdict, 'none');
assert.equal(Calc.capacitySet({ cpu: 16000, mem: 32 }), true);
assert.equal(Calc.capacitySet({ cpu: 16000, mem: -1 }), false);
assert.equal(Calc.capacitySet(null), false);

// Derived pod counts are unknowable without capacity -> null (renders as "—"), not 0
assert.strictEqual(Calc.morePodsFit(web, [web, db], 'weighted', { cpu: 0, mem: 0 }), null);
assert.strictEqual(Calc.maxPodsUnder(web, [web, db], 'weighted', { cpu: 0, mem: 0 }, 85), null);
// ...but a real capacity still behaves exactly as before
assert.equal(Calc.assess([web, db], 'baseline', cap).capacitySet, true);
assert.equal(Calc.morePodsFit(web, [web, db], 'weighted', cap), 30);
assert.equal(Calc.maxPodsUnder(web, [web, db], 'weighted', cap, 85), 30);

console.log('ALL TESTS PASSED');
