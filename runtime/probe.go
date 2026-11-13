package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"math/rand/v2"
	"net"
	"net/http"
	"os"
	"strconv"
	"sync"
	"sync/atomic"
	"time"
)

const maxInFlight = 8_192

type window struct {
	sent     atomic.Int64
	ok       atomic.Int64
	timeout  atomic.Int64
	conn     atomic.Int64
	server   atomic.Int64
	client   atomic.Int64
	dropped  atomic.Int64
	hist     Histogram
	mu       sync.Mutex
	failedBy map[string]int64
}

func (w *window) blame(dep string) {
	w.mu.Lock()
	if w.failedBy == nil {
		w.failedBy = map[string]int64{}
	}
	w.failedBy[dep]++
	w.mu.Unlock()
}

type Sample struct {
	Seq      int64                 `json:"seq"`
	T        int64                 `json:"t"`
	Rate     float64               `json:"rate"`
	Sent     int64                 `json:"sent"`
	OK       int64                 `json:"ok"`
	Errors   map[string]int64      `json:"errors"`
	FailedBy map[string]int64      `json:"failedBy"`
	Latency  Latency               `json:"latency"`
	Nodes    map[string]NodeSample `json:"nodes"`
}

type Probe struct {
	cfg      ProbeConfig
	targets  *Balancer
	client   *http.Client
	rate     atomic.Uint64
	inFlight atomic.Int64
	cur      atomic.Pointer[window]
	payload  []byte

	keyMu sync.Mutex
	zipf  *rand.Zipf
	rng   *rand.Rand

	sampleMu sync.Mutex
	samples  []Sample
	seq      int64

	scrapers []scraper
	prepared atomic.Bool
}

func newProbe(cfg ProbeConfig) *Probe {
	rng := rand.New(rand.NewPCG(uint64(time.Now().UnixNano()), 7))
	keys := max(2, cfg.Workload.Keys)
	p := &Probe{
		cfg:     cfg,
		client:  newHTTPClient(),
		payload: bytes.Repeat([]byte("y"), max(16, cfg.Workload.PayloadBytes)),
		rng:     rng,
		zipf:    rand.NewZipf(rng, 1.1, 1, uint64(keys-1)),
	}
	p.cur.Store(&window{})
	return p
}

func runProbe(ctx context.Context, cfg ProbeConfig) error {
	p := newProbe(cfg)
	p.targets = NewBalancer(cfg.Targets, 8080)
	go func() {
		if len(cfg.Targets) > 0 {
			if err := p.targets.Start(ctx, 60*time.Second); err != nil {
				fmt.Fprintln(os.Stderr, "redline:", err)
			}
		}
		p.scrapers = buildScrapers(ctx, cfg.Nodes)
		go p.generate(ctx)
		go p.tick(ctx)
	}()
	return serve(ctx, cfg.Port, p.routes())
}

func (p *Probe) Rate() float64 { return math.Float64frombits(p.rate.Load()) }

func (p *Probe) SetRate(rps float64) {
	if rps < 0 || math.IsNaN(rps) {
		rps = 0
	}
	p.rate.Store(math.Float64bits(math.Min(rps, 200_000)))
}

func (p *Probe) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	mux.HandleFunc("POST /prepare", func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		if err := p.prepare(r.Context()); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, map[string]any{"ms": time.Since(start).Milliseconds()})
	})
	mux.HandleFunc("PUT /rate", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			RPS float64 `json:"rps"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 1024)).Decode(&body); err != nil {
			http.Error(w, "bad rate", http.StatusBadRequest)
			return
		}
		p.SetRate(body.RPS)
		writeJSON(w, map[string]any{"rps": p.Rate()})
	})
	mux.HandleFunc("GET /samples", func(w http.ResponseWriter, r *http.Request) {
		after, _ := strconv.ParseInt(r.URL.Query().Get("after"), 10, 64)
		wait, _ := strconv.Atoi(r.URL.Query().Get("wait"))
		deadline := time.Now().Add(time.Duration(min(max(wait, 0), 5000)) * time.Millisecond)
		for {
			out := p.since(after)
			if len(out) > 0 || time.Now().After(deadline) || r.Context().Err() != nil {
				writeJSON(w, out)
				return
			}
			time.Sleep(50 * time.Millisecond)
		}
	})
	return mux
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func (p *Probe) since(after int64) []Sample {
	p.sampleMu.Lock()
	defer p.sampleMu.Unlock()
	out := []Sample{}
	for _, s := range p.samples {
		if s.Seq > after {
			out = append(out, s)
		}
	}
	return out
}

func (p *Probe) nextKey() (int64, bool) {
	p.keyMu.Lock()
	defer p.keyMu.Unlock()
	return int64(p.zipf.Uint64()) + 1, p.rng.Float64() < p.cfg.Workload.ReadRatio
}

// generate sends requests on a fixed schedule: request n is due at start + n/rate whether or not
// earlier ones have come back, and its latency counts from that moment. A slow system can't
// slow the test down and hide its own delay.
func (p *Probe) generate(ctx context.Context) {
	var started time.Time
	var sent int64
	last := -1.0
	for ctx.Err() == nil {
		rate := p.Rate()
		if rate != last {
			started, sent, last = time.Now(), 0, rate
		}
		if rate <= 0 {
			time.Sleep(20 * time.Millisecond)
			continue
		}
		due := int64(rate * time.Since(started).Seconds())
		for ; sent < due; sent++ {
			intended := started.Add(time.Duration(float64(sent) / rate * float64(time.Second)))
			w := p.cur.Load()
			w.sent.Add(1)
			if p.inFlight.Load() >= maxInFlight {
				w.dropped.Add(1)
				continue
			}
			p.inFlight.Add(1)
			go p.fire(ctx, intended)
		}
		time.Sleep(time.Millisecond)
	}
}

func (p *Probe) fire(ctx context.Context, intended time.Time) {
	defer p.inFlight.Add(-1)
	addr, ok := p.targets.Pick()
	if !ok {
		p.cur.Load().conn.Add(1)
		return
	}
	key, read := p.nextKey()
	timeout := time.Duration(max(100, p.cfg.Workload.TimeoutMs)) * time.Millisecond
	reqCtx, cancel := context.WithDeadline(ctx, intended.Add(timeout))
	defer cancel()
	url := "http://" + addr + "/item/" + strconv.FormatInt(key, 10)
	var req *http.Request
	var err error
	if read {
		req, err = http.NewRequestWithContext(reqCtx, http.MethodGet, url, nil)
	} else {
		req, err = http.NewRequestWithContext(reqCtx, http.MethodPost, url, bytes.NewReader(p.payload))
	}
	if err != nil {
		return
	}
	resp, err := p.client.Do(req)
	elapsed := time.Since(intended)
	w := p.cur.Load()
	if err != nil {
		w.hist.Observe(elapsed)
		if errors.Is(err, context.DeadlineExceeded) || isTimeout(err) {
			w.timeout.Add(1)
		} else {
			w.conn.Add(1)
		}
		return
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	elapsed = time.Since(intended)
	w = p.cur.Load()
	w.hist.Observe(elapsed)
	switch {
	case resp.StatusCode < 400:
		w.ok.Add(1)
	case resp.StatusCode >= 500:
		w.server.Add(1)
		if dep := resp.Header.Get("X-Redline-Failed"); dep != "" {
			w.blame(dep)
		}
	default:
		w.client.Add(1)
	}
}

func isTimeout(err error) bool {
	var ne net.Error
	return errors.As(err, &ne) && ne.Timeout()
}

func (p *Probe) tick(ctx context.Context) {
	next := time.Now().Truncate(time.Second).Add(time.Second)
	for {
		select {
		case <-ctx.Done():
			return
		case <-time.After(time.Until(next)):
		}
		next = next.Add(time.Second)
		w := p.cur.Swap(&window{})
		nodes := p.scrape(ctx)
		w.mu.Lock()
		failedBy := w.failedBy
		w.mu.Unlock()
		sample := Sample{
			T:    time.Now().UnixMilli(),
			Rate: p.Rate(),
			Sent: w.sent.Load(),
			OK:   w.ok.Load(),
			Errors: map[string]int64{
				"timeout": w.timeout.Load(),
				"conn":    w.conn.Load(),
				"server":  w.server.Load(),
				"client":  w.client.Load(),
				"dropped": w.dropped.Load(),
			},
			FailedBy: failedBy,
			Latency:  summarize(w.hist.Snapshot()),
			Nodes:    nodes,
		}
		p.sampleMu.Lock()
		p.seq++
		sample.Seq = p.seq
		p.samples = append(p.samples, sample)
		if len(p.samples) > 7200 {
			p.samples = p.samples[len(p.samples)-7200:]
		}
		p.sampleMu.Unlock()
	}
}

func (p *Probe) scrape(ctx context.Context) map[string]NodeSample {
	ctx, cancel := context.WithTimeout(ctx, 950*time.Millisecond)
	defer cancel()
	out := make(map[string]NodeSample, len(p.scrapers))
	var mu sync.Mutex
	var wg sync.WaitGroup
	for _, s := range p.scrapers {
		wg.Add(1)
		go func(s scraper) {
			defer wg.Done()
			sample := s.Scrape(ctx)
			mu.Lock()
			out[s.ID()] = sample
			mu.Unlock()
		}(s)
	}
	wg.Wait()
	return out
}
