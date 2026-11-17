package main

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestHistogramPercentilesStayWithinBucketError(t *testing.T) {
	var h Histogram
	for i := 1; i <= 1000; i++ {
		h.Observe(time.Duration(i) * time.Millisecond)
	}
	lat := summarize(h.Snapshot())
	if lat.Count != 1000 {
		t.Fatalf("count = %d", lat.Count)
	}
	check := func(name string, got, want float64) {
		if got < want || got > want*1.09 {
			t.Errorf("%s = %.2f, want %.0f to %.0f", name, got, want, want*1.09)
		}
	}
	check("p50", lat.P50, 500)
	check("p95", lat.P95, 950)
	check("p99", lat.P99, 990)
}

func TestHistogramDiffGivesOnlyTheNewWindow(t *testing.T) {
	var h Histogram
	h.Observe(time.Second)
	before := h.Snapshot()
	h.Observe(2 * time.Millisecond)
	lat := summarize(diffCounts(h.Snapshot(), before))
	if lat.Count != 1 || lat.P99 > 3 {
		t.Fatalf("got %+v, want one fast request", lat)
	}
}

func TestLRUEvictsOldestAndExpires(t *testing.T) {
	now := time.Unix(0, 0)
	c := NewLRU(2, time.Second)
	c.now = func() time.Time { return now }
	c.Set("a", []byte("1"))
	c.Set("b", []byte("2"))
	c.Get("a")
	c.Set("c", []byte("3"))
	if _, ok := c.Get("b"); ok {
		t.Error("b should be evicted, it was used least recently")
	}
	if _, ok := c.Get("a"); !ok {
		t.Error("a should still be there")
	}
	now = now.Add(2 * time.Second)
	if _, ok := c.Get("a"); ok {
		t.Error("a should have expired")
	}
	if c.Len() != 1 {
		t.Errorf("len = %d, want 1", c.Len())
	}
}

func TestBalancerRotatesOverEveryCopy(t *testing.T) {
	b := NewBalancer([]string{"api", "api-b"}, 8080)
	b.lookup = func(_ context.Context, host string) ([]string, error) {
		if host == "api" {
			return []string{"10.0.0.2", "10.0.0.1"}, nil
		}
		return []string{"10.0.0.9"}, nil
	}
	if err := b.Refresh(context.Background()); err != nil {
		t.Fatal(err)
	}
	seen := map[string]int{}
	for i := 0; i < 300; i++ {
		addr, _ := b.Pick()
		seen[addr]++
	}
	if len(seen) != 3 {
		t.Fatalf("picked %v", seen)
	}
	for addr, n := range seen {
		if n != 100 {
			t.Errorf("%s got %d of 300", addr, n)
		}
	}
}

func TestBalancerReportsWhenNothingResolves(t *testing.T) {
	b := NewBalancer([]string{"ghost"}, 8080)
	b.lookup = func(context.Context, string) ([]string, error) { return nil, errors.New("no such host") }
	if err := b.Refresh(context.Background()); err == nil || !strings.Contains(err.Error(), "ghost") {
		t.Fatalf("err = %v", err)
	}
	if _, ok := b.Pick(); ok {
		t.Error("pick should fail with no addresses")
	}
}

type fakeStore struct {
	mu     sync.Mutex
	rows   map[int64][]byte
	reads  int
	events int
	fail   error
}

func (s *fakeStore) Read(_ context.Context, key int64) ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.reads++
	return s.rows[key], s.fail
}

func (s *fakeStore) Write(_ context.Context, key int64, body []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.fail != nil {
		return s.fail
	}
	s.rows[key] = body
	return nil
}

func (s *fakeStore) Record(context.Context, int64, []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.events++
	return s.fail
}

func (s *fakeStore) Stats() PoolStats { return PoolStats{Max: 10} }
func (s *fakeStore) Close()           {}

type fakeKV struct {
	mu   sync.Mutex
	data map[int64][]byte
}

func (k *fakeKV) Get(_ context.Context, key int64) ([]byte, bool, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	v, ok := k.data[key]
	return v, ok, nil
}

func (k *fakeKV) Set(_ context.Context, key int64, body []byte) error {
	k.mu.Lock()
	defer k.mu.Unlock()
	k.data[key] = body
	return nil
}

func (k *fakeKV) Del(_ context.Context, key int64) error {
	k.mu.Lock()
	defer k.mu.Unlock()
	delete(k.data, key)
	return nil
}

type fakeQueue struct{ added atomic.Int64 }

func (q *fakeQueue) Add(context.Context, int64, []byte) error {
	q.added.Add(1)
	return nil
}

func newTestAgent(t *testing.T) (*Agent, *fakeStore, *fakeKV, *fakeQueue, *httptest.Server) {
	t.Helper()
	a := newAgent(AgentConfig{ID: "api", Mode: "service", PayloadBytes: 32})
	store := &fakeStore{rows: map[int64][]byte{7: []byte("seven")}}
	kv := &fakeKV{data: map[int64][]byte{}}
	queue := &fakeQueue{}
	a.stores = []namedStore{{"postgres", store}}
	a.caches = []namedKV{{"redis", kv}}
	a.queues = []namedProducer{{"jobs", queue}}
	a.ready.Store(true)
	server := httptest.NewServer(a.routes())
	t.Cleanup(server.Close)
	return a, store, kv, queue, server
}

func get(t *testing.T, url string) (int, string, http.Header) {
	t.Helper()
	resp, err := http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(body), resp.Header
}

func TestServiceReadsThroughTheCache(t *testing.T) {
	a, store, kv, _, server := newTestAgent(t)
	for i := 0; i < 3; i++ {
		status, body, _ := get(t, server.URL+"/item/7")
		if status != 200 || body != "seven" {
			t.Fatalf("read %d: %d %q", i, status, body)
		}
	}
	if store.reads != 1 {
		t.Errorf("database read %d times, want 1 (then the cache answers)", store.reads)
	}
	if string(kv.data[7]) != "seven" {
		t.Error("the cache was not filled")
	}
	if a.m.Hits.Load() != 2 || a.m.Misses.Load() != 1 {
		t.Errorf("hits %d misses %d, want 2 and 1", a.m.Hits.Load(), a.m.Misses.Load())
	}
	snap := a.m.Snapshot("api", "service")
	if snap.Requests != 3 || snap.Deps["postgres"].Calls != 1 || snap.Deps["redis"].Calls != 4 {
		t.Errorf("snapshot = %+v", snap)
	}
}

func TestServiceWriteLandsEverywhere(t *testing.T) {
	_, store, kv, queue, server := newTestAgent(t)
	kv.data[9] = []byte("stale")
	resp, err := http.Post(server.URL+"/item/9", "text/plain", strings.NewReader("fresh"))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status %d", resp.StatusCode)
	}
	if string(store.rows[9]) != "fresh" {
		t.Error("the database did not get the write")
	}
	if _, ok := kv.data[9]; ok {
		t.Error("the stale cache entry was not cleared")
	}
	if queue.added.Load() != 1 {
		t.Error("no job was queued")
	}
}

func TestServiceNamesTheFailingDependency(t *testing.T) {
	a, store, _, _, server := newTestAgent(t)
	store.fail = errors.New("too many connections")
	status, _, header := get(t, server.URL+"/item/3")
	if status != http.StatusServiceUnavailable || header.Get("X-Redline-Failed") != "postgres" {
		t.Fatalf("status %d, failed %q", status, header.Get("X-Redline-Failed"))
	}
	if a.m.Errors.Load() != 1 {
		t.Errorf("errors = %d", a.m.Errors.Load())
	}
}

func TestServiceRejectsBadKeysAndRefusesBeforeReady(t *testing.T) {
	a, _, _, _, server := newTestAgent(t)
	if status, _, _ := get(t, server.URL+"/item/abc"); status != 400 {
		t.Errorf("bad key status %d", status)
	}
	a.ready.Store(false)
	if status, _, _ := get(t, server.URL+"/health"); status != 503 {
		t.Errorf("health before ready = %d", status)
	}
}

func TestLoadBalancerForwardsAndCDNCaches(t *testing.T) {
	var hits atomic.Int64
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		_, _ = w.Write([]byte("from-backend " + r.URL.Path))
	}))
	defer backend.Close()
	host, port := splitURL(backend.URL)

	for _, mode := range []string{"lb", "cdn"} {
		hits.Store(0)
		a := newAgent(AgentConfig{ID: mode, Mode: mode, Upstreams: []string{"api"}, Port: port, TTLSec: 60})
		a.up = NewBalancer([]string{"api"}, port)
		a.up.lookup = func(context.Context, string) ([]string, error) { return []string{host}, nil }
		if err := a.up.Refresh(context.Background()); err != nil {
			t.Fatal(err)
		}
		if mode == "cdn" {
			a.edge = NewLRU(10, time.Minute)
		}
		a.ready.Store(true)
		front := httptest.NewServer(a.routes())
		for i := 0; i < 3; i++ {
			status, body, _ := get(t, front.URL+"/item/5")
			if status != 200 || body != "from-backend /item/5" {
				t.Fatalf("%s: %d %q", mode, status, body)
			}
		}
		front.Close()
		want := int64(3)
		if mode == "cdn" {
			want = 1
		}
		if hits.Load() != want {
			t.Errorf("%s: backend saw %d requests, want %d", mode, hits.Load(), want)
		}
	}
}

func TestExternalStandInTakesItsTime(t *testing.T) {
	a := newAgent(AgentConfig{ID: "pay", Mode: "external", LatencyMs: 40})
	a.ready.Store(true)
	server := httptest.NewServer(a.routes())
	defer server.Close()
	start := time.Now()
	if status, _, _ := get(t, server.URL+"/item/1"); status != 200 {
		t.Fatalf("status %d", status)
	}
	if d := time.Since(start); d < 35*time.Millisecond {
		t.Errorf("answered in %v, want about 40ms", d)
	}
}

func TestWorkBurnsTime(t *testing.T) {
	calibrate()
	start := time.Now()
	work(20)
	d := time.Since(start)
	if d < 10*time.Millisecond || d > 200*time.Millisecond {
		t.Errorf("work(20) took %v", d)
	}
}

func TestProbeHoldsTheRateItIsGiven(t *testing.T) {
	var served atomic.Int64
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		served.Add(1)
		w.WriteHeader(200)
	}))
	defer target.Close()
	host, port := splitURL(target.URL)
	p := newProbe(ProbeConfig{Workload: Workload{ReadRatio: 0.9, Keys: 1000, PayloadBytes: 64, TimeoutMs: 1000}})
	p.targets = NewBalancer([]string{"t"}, port)
	p.targets.lookup = func(context.Context, string) ([]string, error) { return []string{host}, nil }
	if err := p.targets.Refresh(context.Background()); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	go p.generate(ctx)
	p.SetRate(500)
	time.Sleep(2 * time.Second)
	cancel()
	time.Sleep(100 * time.Millisecond)
	got := served.Load()
	if got < 950 || got > 1050 {
		t.Errorf("sent %d requests in 2s at 500/s, want about 1000", got)
	}
	w := p.cur.Load()
	if w.ok.Load() < 900 {
		t.Errorf("ok = %d", w.ok.Load())
	}
}

func TestParseInfoAndSplitURL(t *testing.T) {
	info := parseInfo("# Stats\r\ntotal_commands_processed:42\r\nkeyspace_hits:7\r\n")
	if info["total_commands_processed"] != "42" || info["keyspace_hits"] != "7" {
		t.Errorf("info = %v", info)
	}
	if host, port := splitURL("http://api:8080"); host != "api" || port != 8080 {
		t.Errorf("split = %s %d", host, port)
	}
}

func TestProbeOnlyAnswersOnLocalhost(t *testing.T) {
	handler := localOnly(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) }))
	for host, want := range map[string]int{
		"127.0.0.1:54184":           http.StatusOK,
		"localhost:7000":            http.StatusOK,
		"127.0.0.1":                 http.StatusOK,
		"evil.example:54184":        http.StatusForbidden,
		"127.0.0.1.evil.example:80": http.StatusForbidden,
		"":                          http.StatusForbidden,
	} {
		req := httptest.NewRequest(http.MethodPut, "/rate", strings.NewReader(`{"rps":1}`))
		req.Host = host
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != want {
			t.Errorf("Host %q: got %d, want %d", host, rec.Code, want)
		}
	}
}
