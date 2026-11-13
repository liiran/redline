package main

import (
	"math"
	"sync"
	"sync/atomic"
	"time"
)

const (
	histBuckets = 200
	histBaseUs  = 50.0
	histGrowth  = 1.08
)

// Histogram counts latencies in log-spaced buckets, so any percentile is within 8% of the truth.
type Histogram struct {
	counts [histBuckets]atomic.Int64
}

func bucketOf(d time.Duration) int {
	us := float64(d.Microseconds())
	if us <= histBaseUs {
		return 0
	}
	i := int(math.Log(us/histBaseUs) / math.Log(histGrowth))
	if i >= histBuckets {
		return histBuckets - 1
	}
	return i
}

func bucketUpperMs(i int) float64 {
	return histBaseUs * math.Pow(histGrowth, float64(i+1)) / 1000
}

func (h *Histogram) Observe(d time.Duration) {
	h.counts[bucketOf(d)].Add(1)
}

func (h *Histogram) Snapshot() []int64 {
	out := make([]int64, histBuckets)
	for i := range h.counts {
		out[i] = h.counts[i].Load()
	}
	return out
}

func diffCounts(now, before []int64) []int64 {
	out := make([]int64, len(now))
	for i := range now {
		out[i] = now[i]
		if i < len(before) {
			out[i] -= before[i]
		}
	}
	return out
}

func sumInto(dst, src []int64) []int64 {
	if dst == nil {
		dst = make([]int64, len(src))
	}
	for i := range src {
		if i < len(dst) {
			dst[i] += src[i]
		}
	}
	return dst
}

type Latency struct {
	Count int64   `json:"count"`
	P50   float64 `json:"p50"`
	P95   float64 `json:"p95"`
	P99   float64 `json:"p99"`
	Max   float64 `json:"max"`
}

func summarize(counts []int64) Latency {
	var total int64
	for _, c := range counts {
		total += c
	}
	out := Latency{Count: total}
	if total == 0 {
		return out
	}
	pick := func(q float64) float64 {
		target := int64(math.Ceil(q * float64(total)))
		var seen int64
		for i, c := range counts {
			seen += c
			if seen >= target {
				return round2(bucketUpperMs(i))
			}
		}
		return round2(bucketUpperMs(len(counts) - 1))
	}
	out.P50, out.P95, out.P99 = pick(0.50), pick(0.95), pick(0.99)
	for i := len(counts) - 1; i >= 0; i-- {
		if counts[i] > 0 {
			out.Max = round2(bucketUpperMs(i))
			break
		}
	}
	return out
}

func round2(v float64) float64 {
	return math.Round(v*100) / 100
}

type DepStats struct {
	Calls  atomic.Int64
	Errors atomic.Int64
	Micros atomic.Int64
}

func (d *DepStats) Record(start time.Time, err error) {
	d.Calls.Add(1)
	d.Micros.Add(time.Since(start).Microseconds())
	if err != nil {
		d.Errors.Add(1)
	}
}

type DepSnapshot struct {
	Calls  int64 `json:"calls"`
	Errors int64 `json:"errors"`
	Micros int64 `json:"micros"`
}

type AgentSnapshot struct {
	ID          string                 `json:"id"`
	Mode        string                 `json:"mode"`
	Requests    int64                  `json:"requests"`
	Errors      int64                  `json:"errors"`
	InFlight    int64                  `json:"inFlight"`
	Waiting     int64                  `json:"waiting"`
	Hist        []int64                `json:"hist"`
	Deps        map[string]DepSnapshot `json:"deps"`
	Hits        int64                  `json:"hits"`
	Misses      int64                  `json:"misses"`
	Processed   int64                  `json:"processed"`
	Failed      int64                  `json:"failed"`
	PoolWaits   int64                  `json:"poolWaits"`
	PoolAcquire int64                  `json:"poolAcquires"`
	PoolWaitUs  int64                  `json:"poolWaitMicros"`
	PoolInUse   int64                  `json:"poolInUse"`
	PoolMax     int64                  `json:"poolMax"`
}

type AgentMetrics struct {
	Requests  atomic.Int64
	Errors    atomic.Int64
	InFlight  atomic.Int64
	Waiting   atomic.Int64
	Hits      atomic.Int64
	Misses    atomic.Int64
	Processed atomic.Int64
	Failed    atomic.Int64
	Hist      Histogram

	mu   sync.Mutex
	deps map[string]*DepStats
}

func (m *AgentMetrics) Dep(id string) *DepStats {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.deps == nil {
		m.deps = map[string]*DepStats{}
	}
	d, ok := m.deps[id]
	if !ok {
		d = &DepStats{}
		m.deps[id] = d
	}
	return d
}

func (m *AgentMetrics) Snapshot(id, mode string) AgentSnapshot {
	m.mu.Lock()
	deps := make(map[string]DepSnapshot, len(m.deps))
	for name, d := range m.deps {
		deps[name] = DepSnapshot{Calls: d.Calls.Load(), Errors: d.Errors.Load(), Micros: d.Micros.Load()}
	}
	m.mu.Unlock()
	return AgentSnapshot{
		ID:        id,
		Mode:      mode,
		Requests:  m.Requests.Load(),
		Errors:    m.Errors.Load(),
		InFlight:  m.InFlight.Load(),
		Waiting:   m.Waiting.Load(),
		Hist:      m.Hist.Snapshot(),
		Deps:      deps,
		Hits:      m.Hits.Load(),
		Misses:    m.Misses.Load(),
		Processed: m.Processed.Load(),
		Failed:    m.Failed.Load(),
	}
}
