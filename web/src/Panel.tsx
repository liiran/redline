import { Button } from "@ui-sdk/react/button"
import { AlertTriangle, ArrowLeftRight, Check, CircleAlert, Gauge, Loader2, Play, Square, Trash2, X } from "lucide-react"
import { useEffect, useState } from "react"
import { compact, findBottleneck, ms, nodeHealth, percent } from "../../shared/analyze.ts"
import { CATALOG, SETTING_INFO, edgeRole, settingsFor, type Kind, type SettingKey } from "../../shared/catalog.ts"
import { nodeSettings, type Design, type DesignNode } from "../../shared/design.ts"
import { errorRate } from "../../shared/samples.ts"
import { containerCount, cpuBudget, type Issue } from "../../shared/validate.ts"
import { addClient, findBreakingPoint, flipEdge, openSaved, removeSelection, run, setRate, stopRamp, tryChange } from "./actions.ts"
import type { RampResult, SessionView, TestRow } from "./api.ts"
import { Chart } from "./Chart.tsx"
import { Field, KindSelect, NumberField, Range } from "./Controls.tsx"
import { KindIcon } from "./kinds.tsx"
import { useApp } from "./store.ts"

const RATES = [0, 10, 25, 50, 100, 150, 200, 300, 400, 500, 750, 1000, 1500, 2000, 3000, 4000, 5000, 7500, 10_000, 15_000, 20_000]

const ROLE_TEXT: Record<string, string> = {
  traffic: "Users send their requests here.",
  upstream: "Passes requests on to it.",
  database: "Reads and writes rows in it.",
  cache: "Checks it before the database, and fills it after a miss.",
  produce: "Puts a job on it after each write.",
  consume: "The worker takes jobs from it.",
  call: "Calls it on every request and waits for the answer.",
}

export function Panel({ design, issues }: { design: Design; issues: Issue[] }) {
  const selected = useApp((s) => s.selected)
  const session = useApp((s) => s.session)
  const designId = useApp((s) => s.designId)
  const node = design.nodes.find((n) => n.id === selected)
  const edge = design.edges.find((e) => e.id === selected)
  const mine = session?.designId === designId
  const active = session && mine && session.phase !== "stopped"
  const elsewhere = session && !mine && (session.phase === "ready" || session.phase === "starting")

  return (
    <aside className="panel" aria-label="Details">
      {node && <BoxSection key={node.id} design={design} node={node} />}
      {edge && <EdgeSection design={design} edgeId={edge.id} />}
      {elsewhere && (
        <section className="section">
          <div className="notice">
            <AlertTriangle aria-hidden />
            <span>“{session.design.name}” is running. Running this design stops it.</span>
            <button className="btn sm" style={{ marginLeft: "auto" }} onClick={() => session.designId && openSaved(session.designId)}>
              Open it
            </button>
          </div>
        </section>
      )}
      {active ? <LiveSections session={session} design={design} /> : <DesignSections design={design} issues={issues} stopped={mine ? session : null} />}
    </aside>
  )
}

function DesignSections({ design, issues, stopped }: { design: Design; issues: Issue[]; stopped: SessionView | null }) {
  const status = useApp((s) => s.status)
  const tests = useApp((s) => s.tests)
  const edit = useApp((s) => s.edit)
  const errors = issues.filter((i) => i.level === "error")
  const dockerOk = status?.docker.ok
  const w = design.workload
  const setWorkload = (patch: Partial<Design["workload"]>, key: string) =>
    edit((d) => ({ ...d, workload: { ...d.workload, ...patch } }), { coalesce: `workload:${key}` })

  return (
    <>
      <section className="section">
        <h2>
          Design
          <span className="hint">{design.nodes.length} boxes</span>
        </h2>
        <div className="stats">
          <div className="stat">
            <div className="value">{containerCount(design)}</div>
            <div className="label">containers</div>
          </div>
          <div className="stat" data-bad={status?.docker.ok && cpuBudget(design) > status.docker.cpus ? "" : undefined}>
            <div className="value">{compact(cpuBudget(design))}</div>
            <div className="label">CPU cores</div>
          </div>
          <div className="stat" data-bad={errors.length ? "" : undefined}>
            <div className="value">{errors.length}</div>
            <div className="label">{errors.length === 1 ? "problem" : "problems"}</div>
          </div>
        </div>
        {issues.length > 0 && (
          <ul className="issues" style={{ marginTop: 12 }}>
            {issues.map((issue, i) => (
              <li key={`${issue.message}${i}`} className="issue" data-level={issue.level}>
                {issue.level === "error" ? <CircleAlert aria-hidden /> : <AlertTriangle aria-hidden />}
                <span>{issue.message}</span>
                {issue.fix?.kind === "flip-edge" && (
                  <button className="btn sm" onClick={() => flipEdge((issue.fix as { edgeId: string }).edgeId)}>
                    Flip
                  </button>
                )}
                {issue.fix?.kind === "add-client" && (
                  <button className="btn sm" onClick={addClient}>
                    Add
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {stopped?.phase === "failed" && stopped.error && (
          <div className="notice bad" style={{ marginTop: 12 }}>
            <CircleAlert aria-hidden />
            <span>Last run failed: {stopped.error}</span>
          </div>
        )}
        <div className="row" style={{ marginTop: 14 }}>
          <Button className="btn primary" style={{ flex: 1 }} disabled={errors.length > 0 || !dockerOk} onClick={run}>
            <Play aria-hidden /> Run in Docker
          </Button>
        </div>
        {!dockerOk && status && (
          <p className="field-hint" style={{ marginTop: 8 }}>
            {status.docker.ok ? "" : status.docker.error}
          </p>
        )}
      </section>

      <section className="section">
        <h2>Traffic</h2>
        <Field label="Reads" value={`${Math.round(w.readRatio * 100)}% reads · ${Math.round((1 - w.readRatio) * 100)}% writes`} hint="A read fetches one item. A write saves one, clears it from caches and queues a job.">
          <Range label="Share of reads" value={Math.round(w.readRatio * 100)} min={0} max={100} step={5} onChange={(v) => setWorkload({ readRatio: v / 100 }, "reads")} />
        </Field>
        <Field label="Target response time" value={`p95 under ${ms(w.sloP95Ms)}`} hint="A step passes when 95% of requests answer within this, and under 1% fail.">
          <NumberField label="Target in ms" value={w.sloP95Ms} min={10} max={10_000} step={50} onChange={(v) => setWorkload({ sloP95Ms: Math.round(v) }, "slo")} />
        </Field>
        <Field label="Items in the database" value={compact(w.keys)} hint="A few popular items get most of the traffic, as on real sites.">
          <NumberField label="Items" value={w.keys} min={1000} max={1_000_000} step={10_000} onChange={(v) => setWorkload({ keys: Math.round(v) }, "keys")} />
        </Field>
      </section>

      {tests.length > 0 && <History tests={tests} />}
    </>
  )
}

function BoxSection({ design, node }: { design: Design; node: DesignNode }) {
  const edit = useApp((s) => s.edit)
  const session = useApp((s) => s.session)
  const samples = useApp((s) => s.samples)
  const info = CATALOG[node.kind]
  const settings = nodeSettings(node)
  const [label, setLabel] = useState(node.label)
  useEffect(() => setLabel(node.label), [node.label])

  const update = (patch: Partial<DesignNode>, key: string) =>
    edit((d) => ({ ...d, nodes: d.nodes.map((n) => (n.id === node.id ? { ...n, ...patch } : n)) }), { coalesce: `${node.id}:${key}` })
  const setSetting = (key: SettingKey, value: number) => update({ settings: { ...node.settings, [key]: value } }, key)
  const setKind = (kind: Kind) => update({ kind, settings: {} }, "kind")

  const designId = useApp((s) => s.designId)
  const live = session?.phase === "ready" && session.designId === designId && session.design.nodes.some((n) => n.id === node.id)
  const health = live ? nodeHealth(design, node, samples.at(-1), samples.at(-2)) : null
  const deps = live ? samples.at(-1)?.nodes[node.id]?.deps : undefined
  const changed = live && JSON.stringify(session!.design.nodes.find((n) => n.id === node.id)?.settings ?? {}) !== JSON.stringify(node.settings)

  return (
    <section className="section">
      <h2>
        <span className="box-icon" style={{ width: 24, height: 24 }}>
          <KindIcon kind={node.kind} />
        </span>
        {info.title}
        <button className="btn ghost sm icon" style={{ marginLeft: "auto" }} aria-label="Delete box" onClick={() => removeSelection([node.id])}>
          <Trash2 aria-hidden />
        </button>
      </h2>
      <Field label="Name">
        <input
          className="text-input"
          value={label}
          maxLength={40}
          onChange={(e) => setLabel(e.target.value)}
          onBlur={() => label.trim() && label.trim() !== node.label && update({ label: label.trim() }, "label")}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        />
      </Field>
      <Field label="Kind" hint={`${info.blurb} Runs as: ${info.runs}.`}>
        <KindSelect value={node.kind} onChange={setKind} allowClient={!design.nodes.some((n) => n.kind === "client" && n.id !== node.id)} />
      </Field>
      {info.editable.map((key) => {
        const meta = SETTING_INFO[key]
        const value = settings[key]
        return (
          <Field key={key} label={meta.label} value={`${compact(value)}${meta.unit ? ` ${meta.unit}` : ""}`} hint={meta.hint}>
            {key === "cpus" || key === "workMs" ? (
              <Range label={meta.label} value={value} min={meta.min} max={meta.max} step={meta.step} onChange={(v) => setSetting(key, v)} />
            ) : (
              <NumberField label={meta.label} value={value} min={meta.min} max={meta.max} step={meta.step} onChange={(v) => setSetting(key, settingsFor(node.kind, { [key]: v })[key])} />
            )}
          </Field>
        )
      })}
      {changed && <p className="field-hint">These settings apply on the next run.</p>}
      {health && (
        <div style={{ marginTop: 12 }}>
          <p className="eyebrow">Right now</p>
          <p className="num">{health.lines[0]}</p>
          <p className="num muted">{health.lines[1]}</p>
          {deps && Object.keys(deps).length > 0 && (
            <ul className="steps" style={{ marginTop: 8 }}>
              {Object.entries(deps).map(([id, dep]) => (
                <li key={id} className="step" style={{ gridTemplateColumns: "1fr auto auto" }}>
                  <span>{design.nodes.find((n) => n.id === id)?.label ?? id}</span>
                  <span className="muted">{compact(dep.callsPs ?? 0)}/s</span>
                  <span className="muted">{ms(dep.avgMs ?? 0)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}

function EdgeSection({ design, edgeId }: { design: Design; edgeId: string }) {
  const edge = design.edges.find((e) => e.id === edgeId)!
  const from = design.nodes.find((n) => n.id === edge.from)
  const to = design.nodes.find((n) => n.id === edge.to)
  if (!from || !to) return null
  const role = edgeRole(from.kind, to.kind)
  return (
    <section className="section">
      <h2>
        Arrow
        <button className="btn ghost sm icon" style={{ marginLeft: "auto" }} aria-label="Delete arrow" onClick={() => removeSelection([], [edge.id])}>
          <Trash2 aria-hidden />
        </button>
      </h2>
      <p>
        <strong>{from.label}</strong> → <strong>{to.label}</strong>
      </p>
      <p className="muted" style={{ marginTop: 4 }}>
        {role ? ROLE_TEXT[role] : "This arrow can't work as drawn."}
      </p>
      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn sm" onClick={() => flipEdge(edge.id)} disabled={edgeRole(to.kind, from.kind) === null}>
          <ArrowLeftRight aria-hidden /> Flip direction
        </button>
      </div>
    </section>
  )
}

function stepsOf(session: SessionView) {
  const step = session.step
  const order = ["images", "containers", "data", "ready"] as const
  const at = step.startsWith("Getting images") ? 0 : step.startsWith("Starting") ? 1 : step.startsWith("Filling") || step === "Getting ready" ? 2 : 3
  const labels = {
    images: "Get images (first run builds Redline's runtime)",
    containers: `Start ${session.containers} containers and wait until healthy`,
    data: "Fill databases and queues",
    ready: "Ready for traffic",
  }
  return order.map((key, i) => ({ key, label: labels[key], state: i < at ? "done" : i === at ? "doing" : "todo" }))
}

function LiveSections({ session, design }: { session: SessionView; design: Design }) {
  const samples = useApp((s) => s.samples)
  const tests = useApp((s) => s.tests)
  const indexOf = (rate: number) => Math.max(0, RATES.findIndex((r) => r >= rate))
  const [rateIndex, setRateIndex] = useState(() => indexOf(session.rate))
  const ramp = session.ramp
  const rampRunning = !!ramp?.running

  useEffect(() => {
    if (!rampRunning) setRateIndex(indexOf(session.rate))
  }, [session.rate, rampRunning])

  if (session.phase === "starting" || session.phase === "stopping") {
    return (
      <section className="section">
        <h2>
          {session.phase === "stopping" ? "Stopping" : "Starting"}
          <span className="hint num">{Math.round((Date.now() - session.startedAt) / 1000)} s</span>
        </h2>
        <ul className="progress">
          {stepsOf(session).map((step) => (
            <li key={step.key} data-state={step.state}>
              {step.state === "done" ? <Check aria-hidden /> : step.state === "doing" ? <Loader2 className="spin" aria-hidden /> : <span style={{ width: 14 }} />}
              {step.label}
            </li>
          ))}
        </ul>
        {session.log.length > 0 && <pre className="log">{session.log.slice(-12).join("\n")}</pre>}
      </section>
    )
  }

  if (session.phase === "failed") {
    return (
      <section className="section">
        <h2>Couldn't start</h2>
        <div className="notice bad">
          <CircleAlert aria-hidden />
          <span>{session.error}</span>
        </div>
        {session.log.length > 0 && <pre className="log">{session.log.slice(-20).join("\n")}</pre>}
        <div className="row" style={{ marginTop: 12 }}>
          <Button className="btn" onClick={run}>
            Try again
          </Button>
        </div>
      </section>
    )
  }

  const last = samples.at(-1)
  const recent = samples.slice(-5)
  const answered = recent.length ? recent.reduce((s, x) => s + x.ok, 0) / recent.length : 0
  const p95 = last?.latency.p95 ?? 0
  const errors = last ? errorRate(last) : 0
  const t0 = samples[0]?.t ?? 0
  const throughput = samples.map((s) => ({ t: (s.t - t0) / 1000, a: s.ok, b: s.rate, bad: s.errors.timeout + s.errors.server + s.errors.conn }))
  const latency = samples.filter((s) => s.latency.count > 0).map((s) => ({ t: (s.t - t0) / 1000, a: s.latency.p95 }))
  const live = last && last.rate > 0 ? findBottleneck(session.design, samples.slice(-3)) : null
  const designChanged = JSON.stringify(session.design) !== JSON.stringify(design)

  return (
    <>
      <section className="section">
        <h2>
          <span className="dot live" />
          Live
          <span className="hint">{session.readyMs ? `up in ${(session.readyMs / 1000).toFixed(1)} s` : ""}</span>
        </h2>
        <div className="big">
          <div>
            <div className="value">{compact(answered)}</div>
            <div className="label">answered /s</div>
          </div>
          <div data-bad={p95 > design.workload.sloP95Ms ? "" : undefined}>
            <div className="value">{last?.latency.count ? ms(p95) : "–"}</div>
            <div className="label">p95</div>
          </div>
          <div data-bad={errors > 0.01 ? "" : undefined}>
            <div className="value">{percent(errors)}</div>
            <div className="label">failed</div>
          </div>
        </div>
        {designChanged && (
          <div className="notice" style={{ marginTop: 12 }}>
            <AlertTriangle aria-hidden />
            <span>You changed the design since this run started.</span>
            <Button className="btn sm" style={{ marginLeft: "auto" }} onClick={run}>
              Run the new design
            </Button>
          </div>
        )}
      </section>

      <section className="section">
        <h2>
          Traffic
          <span className="hint num">{rampRunning ? `test at ${compact(ramp!.current ?? 0)} req/s` : `${compact(indexOf(session.rate) === rateIndex ? session.rate : (RATES[rateIndex] ?? 0))} req/s`}</span>
        </h2>
        <Range
          label="Requests per second"
          value={Math.max(0, rateIndex)}
          min={0}
          max={RATES.length - 1}
          step={1}
          onChange={(i) => setRateIndex(i)}
          onCommit={(i) => !rampRunning && setRate(RATES[i] ?? 0)}
        />
        <div className="row" style={{ marginTop: 12 }}>
          {rampRunning ? (
            <Button className="btn" style={{ flex: 1 }} onClick={stopRamp}>
              <Square aria-hidden /> Stop the test
            </Button>
          ) : (
            <Button className="btn primary" style={{ flex: 1 }} onClick={findBreakingPoint}>
              <Gauge aria-hidden /> Find the breaking point
            </Button>
          )}
        </div>
        <p className="field-hint" style={{ marginTop: 8 }}>
          Steps the traffic up until answers get slower than p95 {ms(design.workload.sloP95Ms)} or more than 1% fail. About a minute.
        </p>
      </section>

      {live && !rampRunning && !ramp?.result && (
        <section className="section">
          <p className="eyebrow">Under strain now</p>
          <div className="finding">
            <strong>{live.title}</strong>
            <p>{live.detail}</p>
          </div>
        </section>
      )}

      {ramp && (ramp.steps.length > 0 || ramp.running) && (
        <section className="section">
          <h2>Breaking point</h2>
          {ramp.result ? <Result result={ramp.result} /> : null}
          <ul className="steps" style={{ marginTop: ramp.result ? 14 : 0 }}>
            {ramp.steps.map((step, i) => (
              <li key={`${step.rate}-${i}`} className="step" data-pass={step.pass}>
                {step.pass ? <Check aria-hidden /> : <X aria-hidden />}
                <span className="num">{compact(step.rate)}/s</span>
                <span className="why" title={step.reason}>
                  {step.reason}
                </span>
              </li>
            ))}
            {ramp.running && ramp.current !== null && (
              <li className="step">
                <Loader2 className="spin" aria-hidden />
                <span className="num">{compact(ramp.current)}/s</span>
                <span className="why">measuring…</span>
              </li>
            )}
          </ul>
        </section>
      )}

      <section className="section">
        <h2>Throughput</h2>
        <Chart points={throughput} label="Requests answered and sent per second" unit="rps" />
        <div className="legend">
          <span>
            <i />
            answered
          </span>
          <span>
            <i className="dash" />
            sent
          </span>
          <span>
            <i className="red" />
            failed
          </span>
        </div>
        <h2 style={{ marginTop: 16 }}>Response time (p95)</h2>
        <Chart points={latency} label="95th percentile response time" unit="ms" limit={design.workload.sloP95Ms} limitLabel="target" />
      </section>

      {tests.length > 0 && <History tests={tests} />}
    </>
  )
}

function Result({ result }: { result: RampResult }) {
  return (
    <div className="result">
      <div>
        <p className="eyebrow">{result.cancelled ? "Stopped early. Held at least" : result.failedAt ? "Holds" : "Held every step up to"}</p>
        <div className="capacity">
          {result.capacity ? compact(result.capacity) : "0"}
          <small>req/s</small>
        </div>
        {result.failedAt && (
          <p className="muted" style={{ marginTop: 2 }}>
            Broke at {compact(result.failedAt)} req/s
          </p>
        )}
      </div>
      {result.finding && (
        <div className="finding">
          <strong>{result.finding.title}</strong>
          <p>{result.finding.detail}</p>
        </div>
      )}
      {result.probeLimited && (
        <div className="notice">
          <AlertTriangle aria-hidden />
          <span>The load generator itself hit its limit, so the real ceiling may be higher.</span>
        </div>
      )}
      {result.suggestions.length > 0 && (
        <div className="compare">
          <p className="eyebrow" style={{ margin: 0 }}>
            Try next
          </p>
          {result.suggestions.slice(0, 3).map((s) => (
            <div key={s.id} className="suggestion">
              <div>
                <strong>{s.title}</strong>
                <span>{s.detail}</span>
              </div>
              <button className="btn sm" onClick={() => tryChange(s.change)}>
                Apply
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function History({ tests }: { tests: TestRow[] }) {
  const best = Math.max(1, ...tests.map((t) => t.result.capacity ?? 0))
  const shown = tests.slice(0, 6)
  const first = tests.at(-1)?.result.capacity ?? 0
  const latest = tests[0]?.result.capacity ?? 0
  return (
    <section className="section">
      <h2>
        Tests of this design
        {tests.length > 1 && first > 0 && latest > 0 && <span className="hint num">{(latest / first).toFixed(1)}× the first</span>}
      </h2>
      <div className="compare">
        {shown.map((test, i) => (
          <div key={test.id} className="compare-row" data-latest={i === 0 ? "" : undefined}>
            <span className="muted">
              {new Date(test.startedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} · {summary(test)}
            </span>
            <strong className="num">{test.result.capacity ? `${compact(test.result.capacity)}/s` : "–"}</strong>
            <div className="bar">
              <span style={{ width: `${((test.result.capacity ?? 0) / best) * 100}%` }} />
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

function summary(test: TestRow) {
  const nodes = test.design.nodes.filter((n) => n.kind !== "client")
  const kinds = new Map<string, number>()
  for (const n of nodes) kinds.set(CATALOG[n.kind].title, (kinds.get(CATALOG[n.kind].title) ?? 0) + nodeSettings(n).replicas)
  return [...kinds.entries()].map(([k, n]) => (n > 1 ? `${n} ${k.toLowerCase()}s` : k.toLowerCase())).join(", ")
}

