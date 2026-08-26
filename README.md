# Cluster Capacity Planner

What-if capacity sizing for Kubernetes workloads. The build produces a **single
self-contained `index.html` at the project root** — React, styles, and app code
all inlined — that runs offline in any browser.

## What this answers

**"Do we need to buy more capacity, or do we have headroom?"**

That is a coarse-grained planning question, and this is deliberately not a scheduler
simulation. It compares total demand against total allocatable capacity, which is the
right model for a procurement decision: you buy cores and GB in aggregate, and where
individual pods land doesn't change how much metal you need to order.

It does **not** predict whether a plan will actually schedule. *Fits* means you have
enough capacity in total — not that the scheduler can place every pod. The gap between
those two is listed under [Out of scope](#out-of-scope-by-design).

## Project layout

```
src/index.html    HTML template with injection markers
src/styles.css    All styles (theme, layout, components)
src/calc.js       Capacity calculation engine (pure JS, unit-tested)
src/app.jsx       React application (JSX)
vendor/           React + ReactDOM UMD production builds (inlined at build time)
build.js          Assembles everything into ./index.html
calc.test.js      Unit tests for the calculation engine
index.html        BUILD OUTPUT — the single-file app (do not edit by hand)
```

## Commands

```bash
npm install    # once — installs Babel (used to precompile the JSX)
npm test       # run the calculation engine tests
npm run build  # write ./index.html (the only deliverable)
```

Edit anything under `src/`, then `npm run build`. The `index.html` at the root
is the one file you open, share, or deploy — it has no external dependencies.

## Business rules

### Units

- CPU is entered in millicores or cores; all math runs in millicores (1 core = 1,000 m).
- Memory is entered and calculated in **GB everywhere** — there is no MB anywhere in the app.
  Cluster capacity can also be entered in TB (1 TB = 1,024 GB); values ≥ 1,024 GB display as TB.
- Cluster capacity is treated as **allocatable** (what the scheduler can hand out), not raw node capacity.

### Workload model

- A workload = name (unique, case-insensitive) + pod count + per-pod resources.
- Pods are whole numbers and may be 0 (useful for "what if this workload is gone").
- Per-pod resources: **CPU request** (millicores) and **memory request** (GB). Limits are out of scope — we don't use them.
- **Baseline memory usage** (GB) is the memory a pod actually runs at. It defaults to the
  memory request and may be set higher (or lower) than the request. **All memory math uses
  the baseline, never the request** — the request is kept for reference only.
- Baseline CPU is the CPU request.

### Burst options

- A workload may optionally burst, with up to **3 burst options**.
- Each option = **share of pods (%)** + **burst CPU (millicores)** and/or **burst memory (GB)**.
- An option must have a share between 1 and 100% and at least one of burst CPU / burst memory.
- A burst CPU or burst memory of 0 means that resource stays at the pod's baseline for that option.
- Burst CPU, when set, must be higher than the baseline CPU request.
- The shares of all active options combined cannot exceed 100% of the workload's pods.
  The form enforces this, and a scenario import containing impossible data — shares past
  100%, negative resources or pods — is **rejected outright** with an error banner listing
  every problem; nothing is applied. (The engine additionally ignores any share past 100%
  as a last-resort guard, but rejected imports never reach it.)
- Options with a share of 0 — or with neither burst CPU nor burst memory — are ignored
  (that's how you skip unused option slots).

### Sizing strategies (computed side by side)

For each workload, per-pod demand under the three strategies:

| Strategy | CPU per pod | Memory per pod |
|---|---|---|
| **Baseline** | CPU request | baseline memory |
| **Expected (weighted)** | (1 − Σ shares) × request + Σ (share × option CPU) | (1 − Σ shares) × baseline + Σ (share × option memory) |
| **Worst case** | max(request, all option CPUs) | max(baseline, all option memories) |

- Weighted treats each burst share as an average across the workload's pods (fractional pods are fine).
- Worst case assumes every pod runs at the hottest value of each resource simultaneously.
- Cluster totals are the sum over all workloads; each strategy compares totals to available capacity.

### Verdicts & derived figures

- Utilization = total demand ÷ available capacity, per resource, per strategy.
- Verdict thresholds: **Fits** ≤ 85% · **Tight** > 85% and ≤ 100% · **Over capacity** > 100%.
  A strategy's overall verdict is driven by its worse resource.
- The 85% ceiling is the app's **packing allowance**. Nothing here models fragmentation,
  rolling-update surge or per-node waste explicitly; the 15% margin stands in for all of it
  in aggregate. Plan to *Fits* — planning to 100% means a cluster that can't absorb a deploy.
- **No capacity set** is a fourth, distinct state — not a verdict. When a resource's capacity
  is blank or 0 there is nothing to divide by, so its utilization and headroom are unknown
  (shown as "—", never 0%) and its status is *No capacity set*. If **either** resource is
  missing, the strategy's overall verdict is *No capacity set* too — half a picture is not a
  verdict. Demand itself is still shown, since that part is known. The scaling runway,
  break-points and joint-fit grid are hidden until both capacities are entered, because every
  figure in them divides by capacity.
- **Binding constraint** = the resource with the higher utilization (or "balanced" when equal);
  undefined, and not shown, while either capacity is unset.
- **Headroom** = available − used, per resource (negative headroom is shown as "short").
- **Room for +N pods** (workload table) = how many more pods of that workload fit into the
  remaining *expected (weighted)* capacity, constrained by whichever resource runs out first.
  It is 0 when the cluster is already over capacity under the weighted strategy, and "—"
  for a workload with no CPU or memory demand at all — or when capacity is unset.

### Out of scope (by design)

Everything here is a schedulability concern rather than a procurement one, so leaving it
out doesn't change the buy/don't-buy answer.

- Requests vs. limits distinction — limits were removed; only requests + baselines are modeled.
- Node-level bin-packing and per-node fragmentation — covered in aggregate by the 85% threshold.
- Max pods per node, rolling-update surge, HPA/VPA replica changes, affinity and anti-affinity,
  topology spread, taints, and namespace quotas.
- System-reserved / kubelet overhead (enter allocatable capacity to account for it).
- **DaemonSets** are not imported — model one as an ordinary workload with **pods = node
  count**. That is arithmetically exact, since a DaemonSet runs one pod per node. Two things
  to keep in mind: the pod count has to be updated by hand whenever the cluster resizes, and
  DaemonSet demand grows with the very node count you're solving for, so a large expansion
  wants a second pass.
- **initContainers** are not counted. They run before the app containers and are gone at
  steady state, which is what the baseline models.

  **The one exception worth checking:** native sidecars (Kubernetes 1.28+) are declared in
  `initContainers` with `restartPolicy: Always` and run for the pod's entire lifetime —
  service meshes, log shippers, secret agents. Those are permanent consumption, typically
  100–200 MB and 50–100m per pod, and the import currently misses them. To see whether it
  affects you:

  ```bash
  kubectl get pods -A -o json \
    | jq '[.items[].spec.initContainers // [] | .[] | select(.restartPolicy=="Always")] | length'
  ```

  Anything above 0 means those requests need adding to the affected workloads by hand.

### What-if tools

- **Pod steppers**: −/+ on each workload row (shift-click = ±5). Pods may be 0 ("what if it's gone").
- **Snapshot & delta**: freeze the current plan; strategy cards then show each utilization's
  drift vs. the snapshot in points. Revert restores the snapshot state; Re-snapshot rebases it.
- **Break-points**: per focus workload and strategy, the highest pod count that keeps both
  resources at or under 85% and 100%, with all other workloads held fixed.
- **Scaling runway**: per focus workload, expected (weighted) CPU/memory utilization as it
  scales, with 85%/100% thresholds, the current pod count, and the over-capacity point marked.
- **Joint-fit grid**: with two focus workloads, every (A pods × B pods) combination is graded
  Fits (≤85%) / Tight (≤100%) / Over (>100%) — toggleable between expected and worst case.
- **Stranded memory** (Mem gap column): request − baseline, × pods. Positive = reserved but
  unused at baseline (reclaimable by lowering requests); negative = baseline above the
  request (running on unreserved memory). Totals appear in the Workloads header.

### Workloads table behavior

- Every column is sortable: first click ascending, second descending, third clears the sort
  (back to insertion order). Burst sorts by total burst share; Footprint by weighted CPU.
- Rows can be pinned. Pinned rows always sit above unpinned rows regardless of the active
  sort; the sort is applied within the pinned group and the unpinned group separately.
- Sort choice and pins persist along with the scenario.

### Importing from a live cluster

Dump your workloads and import the file directly — the app recognizes kubectl JSON:

```bash
kubectl get deployments,statefulsets -A -o json > cluster.json
```

Import `cluster.json` via the Import button. Deployments and StatefulSets map to workloads
(replicas → pods; container CPU/memory requests summed per pod; Ki/Mi/Gi/Ti and decimal
K/M/G/T quantities converted to GB). Baselines default to the requests — adjust them from
`kubectl top pods` observations, and add burst options by hand. Cluster capacity is left
untouched by a kubectl import; a kubectl dump replaces the current workload list.

**What an import leaves out.** Deployments and StatefulSets are the only kinds read —
DaemonSets, Jobs/CronJobs, bare pods and operator-managed workloads are skipped and must be
added by hand (see [Out of scope](#out-of-scope-by-design)), as are init/sidecar containers.
A container with no requests, or a quantity the parser can't read, contributes **0**. Every
one of these omissions makes the cluster look emptier than it is, so an imported plan is a
floor on real demand, not a full picture — spot-check anything that lands at zero, and treat
a comfortable *Fits* right after an import with suspicion.

### Persistence & data

- Everything auto-saves to browser storage on every change — capacity, workloads, sort,
  pins, snapshot, and focus selections — and restores on reopen (works when the file is
  opened in a browser). The Reset button clears all of it, including the snapshot, sort,
  and focus choices, and restores the sample scenario.
- Export scenario writes a versioned JSON file; importing one replaces the whole state,
  capacity included (unlike a kubectl import, which replaces only the workload list).
  Older exports (MB-era, single-burst, limits, no baseline) are migrated automatically:
  MB values ÷ 1,024, legacy single bursts become option 1, limits are dropped, missing
  baselines default to the request.

## License

MIT — see [LICENSE](LICENSE).

Vendored React and ReactDOM are copyright Facebook, Inc. and its affiliates, also under
the MIT license. Their `@license` headers are preserved in `vendor/` and inlined verbatim
into the built `index.html`, so attribution travels with the single-file deliverable.

## Notes

- Vendored React versions: 18.3.1 (`react` and `react-dom` UMD production builds).
