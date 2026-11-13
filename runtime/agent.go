package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net"
	"net/http"
	"os"
	"strconv"
	"sync/atomic"
	"time"

	"github.com/redis/go-redis/v9"
)

type namedStore struct {
	id    string
	store Store
}

type namedKV struct {
	id string
	kv KV
}

type namedProducer struct {
	id       string
	producer Producer
}

type namedCall struct {
	id  string
	bal *Balancer
}

type Agent struct {
	cfg     AgentConfig
	m       *AgentMetrics
	stores  []namedStore
	caches  []namedKV
	queues  []namedProducer
	calls   []namedCall
	up      *Balancer
	edge    *LRU
	client  *http.Client
	payload []byte
	ready   atomic.Bool
	slots   chan struct{}
}

// Concurrent requests a copy works on at once, like a server's thread pool. The rest wait
// their turn without burning CPU, so an overloaded box still answers Redline's own checks.
func slotsFor(mode string) int {
	switch mode {
	case "lb", "cdn":
		return 512
	case "external":
		return 0
	default:
		return 64
	}
}

type depError struct {
	dep string
	err error
}

func (e *depError) Error() string { return fmt.Sprintf("%s: %v", e.dep, e.err) }

func newHTTPClient() *http.Client {
	transport := &http.Transport{
		DialContext:         (&net.Dialer{Timeout: 2 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		MaxIdleConns:        4096,
		MaxIdleConnsPerHost: 1024,
		IdleConnTimeout:     60 * time.Second,
		DisableCompression:  true,
	}
	return &http.Client{Transport: transport}
}

func newAgent(cfg AgentConfig) *Agent {
	payload := bytes.Repeat([]byte("x"), max(16, cfg.PayloadBytes))
	a := &Agent{cfg: cfg, m: &AgentMetrics{}, client: newHTTPClient(), payload: payload}
	if n := slotsFor(cfg.Mode); n > 0 {
		a.slots = make(chan struct{}, n)
	}
	return a
}

func runAgent(ctx context.Context, cfg AgentConfig) error {
	calibrate()
	a := newAgent(cfg)
	go func() {
		if err := a.connect(ctx); err != nil {
			fmt.Fprintln(os.Stderr, "redline:", err)
			os.Exit(1)
		}
		a.ready.Store(true)
		if cfg.Mode == "worker" {
			a.startWorkers(ctx)
		}
	}()
	return serve(ctx, cfg.Port, a.routes())
}

func (a *Agent) connect(ctx context.Context) error {
	for _, ref := range a.cfg.Databases {
		store, err := openStore(ctx, ref)
		if err != nil {
			return err
		}
		a.stores = append(a.stores, namedStore{ref.ID, store})
	}
	for _, ref := range a.cfg.Caches {
		client, err := openRedis(ctx, ref.ID, ref.Addr)
		if err != nil {
			return err
		}
		a.caches = append(a.caches, namedKV{ref.ID, &redisKV{client: client, ttl: time.Duration(max(1, ref.TTLSec)) * time.Second}})
	}
	for _, ref := range a.cfg.Queues {
		client, err := openRedis(ctx, ref.ID, ref.Addr)
		if err != nil {
			return err
		}
		a.queues = append(a.queues, namedProducer{ref.ID, &redisProducer{client: client, stream: ref.Stream}})
	}
	for _, ref := range a.cfg.Calls {
		host, port := splitURL(ref.URL)
		bal := NewBalancer([]string{host}, port)
		if err := bal.Start(ctx, 30*time.Second); err != nil {
			return err
		}
		a.calls = append(a.calls, namedCall{ref.ID, bal})
	}
	if len(a.cfg.Upstreams) > 0 {
		a.up = NewBalancer(a.cfg.Upstreams, a.cfg.Port)
		if err := a.up.Start(ctx, 30*time.Second); err != nil {
			return err
		}
	}
	if a.cfg.Mode == "cdn" {
		a.edge = NewLRU(200_000, time.Duration(max(1, a.cfg.TTLSec))*time.Second)
	}
	return nil
}

func splitURL(raw string) (string, int) {
	host := raw
	for _, prefix := range []string{"http://", "https://"} {
		if len(host) > len(prefix) && host[:len(prefix)] == prefix {
			host = host[len(prefix):]
		}
	}
	h, p, err := net.SplitHostPort(host)
	if err != nil {
		return host, 80
	}
	port, _ := strconv.Atoi(p)
	return h, port
}

func (a *Agent) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) {
		if !a.ready.Load() {
			http.Error(w, "starting", http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
	})
	mux.HandleFunc("GET /metrics", func(w http.ResponseWriter, _ *http.Request) {
		snap := a.m.Snapshot(a.cfg.ID, a.cfg.Mode)
		for _, s := range a.stores {
			st := s.store.Stats()
			snap.PoolAcquire += st.Acquires
			snap.PoolWaits += st.Waits
			snap.PoolWaitUs += st.WaitUs
			snap.PoolInUse += st.InUse
			snap.PoolMax += st.Max
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(snap)
	})
	mux.HandleFunc("/item/{key}", a.measure(a.handleItem))
	return mux
}

func (a *Agent) measure(next func(http.ResponseWriter, *http.Request) int) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !a.ready.Load() {
			http.Error(w, "starting", http.StatusServiceUnavailable)
			return
		}
		start := time.Now()
		a.m.InFlight.Add(1)
		if a.slots != nil {
			a.m.Waiting.Add(1)
			select {
			case a.slots <- struct{}{}:
				a.m.Waiting.Add(-1)
			case <-r.Context().Done():
				a.m.Waiting.Add(-1)
				a.m.InFlight.Add(-1)
				a.m.Requests.Add(1)
				a.m.Errors.Add(1)
				a.m.Hist.Observe(time.Since(start))
				return
			}
		}
		status := next(w, r)
		if a.slots != nil {
			<-a.slots
		}
		a.m.InFlight.Add(-1)
		a.m.Requests.Add(1)
		if status >= 400 {
			a.m.Errors.Add(1)
		}
		a.m.Hist.Observe(time.Since(start))
	}
}

func fail(w http.ResponseWriter, status int, err error) int {
	var dep *depError
	if errors.As(err, &dep) {
		w.Header().Set("X-Redline-Failed", dep.dep)
	}
	http.Error(w, err.Error(), status)
	return status
}

func (a *Agent) handleItem(w http.ResponseWriter, r *http.Request) int {
	key, err := strconv.ParseInt(r.PathValue("key"), 10, 64)
	if err != nil || key < 0 {
		http.Error(w, "bad key", http.StatusBadRequest)
		return http.StatusBadRequest
	}
	switch a.cfg.Mode {
	case "lb":
		return a.forward(w, r, key, false)
	case "cdn":
		return a.forward(w, r, key, true)
	case "external":
		return a.stand(w, r)
	}
	if r.Method == http.MethodGet {
		return a.read(w, r, key)
	}
	if r.Method == http.MethodPost || r.Method == http.MethodPut {
		return a.write(w, r, key)
	}
	http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	return http.StatusMethodNotAllowed
}

func (a *Agent) read(w http.ResponseWriter, r *http.Request, key int64) int {
	ctx := r.Context()
	work(a.cfg.WorkMs)
	body, err := a.lookup(ctx, key)
	if err != nil {
		return fail(w, http.StatusServiceUnavailable, err)
	}
	if err := a.callAll(ctx, http.MethodGet, key, nil); err != nil {
		return fail(w, http.StatusBadGateway, err)
	}
	if body == nil {
		body = a.payload
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	_, _ = w.Write(body)
	return http.StatusOK
}

func (a *Agent) lookup(ctx context.Context, key int64) ([]byte, error) {
	for _, c := range a.caches {
		start := time.Now()
		body, ok, err := c.kv.Get(ctx, key)
		a.m.Dep(c.id).Record(start, err)
		if err != nil {
			return nil, &depError{c.id, err}
		}
		if ok {
			a.m.Hits.Add(1)
			return body, nil
		}
	}
	if len(a.caches) > 0 {
		a.m.Misses.Add(1)
	}
	var body []byte
	for _, s := range a.stores {
		start := time.Now()
		found, err := s.store.Read(ctx, key)
		a.m.Dep(s.id).Record(start, err)
		if err != nil {
			return nil, &depError{s.id, err}
		}
		if found != nil {
			body = found
		}
	}
	if body == nil {
		body = a.payload
	}
	if len(a.stores) > 0 {
		for _, c := range a.caches {
			start := time.Now()
			err := c.kv.Set(ctx, key, body)
			a.m.Dep(c.id).Record(start, err)
			if err != nil {
				return nil, &depError{c.id, err}
			}
		}
	}
	return body, nil
}

func (a *Agent) write(w http.ResponseWriter, r *http.Request, key int64) int {
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		http.Error(w, "bad body", http.StatusBadRequest)
		return http.StatusBadRequest
	}
	if len(body) == 0 {
		body = a.payload
	}
	work(a.cfg.WorkMs)
	if err := a.apply(r.Context(), key, body, false); err != nil {
		return fail(w, http.StatusServiceUnavailable, err)
	}
	if err := a.callAll(r.Context(), http.MethodPost, key, body); err != nil {
		return fail(w, http.StatusBadGateway, err)
	}
	w.WriteHeader(http.StatusOK)
	return http.StatusOK
}

// apply makes a write land everywhere this box points: the databases, then the caches are
// cleared so the next read sees it, then a job goes on each queue.
func (a *Agent) apply(ctx context.Context, key int64, body []byte, asEvent bool) error {
	for _, s := range a.stores {
		start := time.Now()
		var err error
		if asEvent {
			err = s.store.Record(ctx, key, body)
		} else {
			err = s.store.Write(ctx, key, body)
		}
		a.m.Dep(s.id).Record(start, err)
		if err != nil {
			return &depError{s.id, err}
		}
	}
	for _, c := range a.caches {
		start := time.Now()
		err := c.kv.Del(ctx, key)
		a.m.Dep(c.id).Record(start, err)
		if err != nil {
			return &depError{c.id, err}
		}
	}
	for _, q := range a.queues {
		start := time.Now()
		err := q.producer.Add(ctx, key, body[:min(len(body), 64)])
		a.m.Dep(q.id).Record(start, err)
		if err != nil {
			return &depError{q.id, err}
		}
	}
	return nil
}

func (a *Agent) callAll(ctx context.Context, method string, key int64, body []byte) error {
	for _, c := range a.calls {
		addr, ok := c.bal.Pick()
		if !ok {
			return &depError{c.id, errors.New("no address")}
		}
		start := time.Now()
		status, err := a.send(ctx, method, "http://"+addr+"/item/"+strconv.FormatInt(key, 10), body)
		if err == nil && status >= 400 {
			err = fmt.Errorf("answered %d", status)
		}
		a.m.Dep(c.id).Record(start, err)
		if err != nil {
			return &depError{c.id, err}
		}
	}
	return nil
}

func (a *Agent) send(ctx context.Context, method, url string, body []byte) (int, error) {
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, url, reader)
	if err != nil {
		return 0, err
	}
	resp, err := a.client.Do(req)
	if err != nil {
		return 0, err
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	return resp.StatusCode, nil
}

func (a *Agent) forward(w http.ResponseWriter, r *http.Request, key int64, edge bool) int {
	work(a.cfg.WorkMs)
	if edge && r.Method == http.MethodGet {
		if body, ok := a.edge.Get(strconv.FormatInt(key, 10)); ok {
			a.m.Hits.Add(1)
			_, _ = w.Write(body)
			return http.StatusOK
		}
		a.m.Misses.Add(1)
	}
	addr, ok := a.up.Pick()
	if !ok {
		http.Error(w, "nothing behind this box", http.StatusBadGateway)
		return http.StatusBadGateway
	}
	var body []byte
	if r.Method != http.MethodGet {
		var err error
		body, err = io.ReadAll(io.LimitReader(r.Body, 1<<20))
		if err != nil {
			http.Error(w, "bad body", http.StatusBadRequest)
			return http.StatusBadRequest
		}
	}
	req, err := http.NewRequestWithContext(r.Context(), r.Method, "http://"+addr+r.URL.RequestURI(), bytes.NewReader(body))
	if err != nil {
		return fail(w, http.StatusBadGateway, err)
	}
	start := time.Now()
	resp, err := a.client.Do(req)
	dep := a.m.Dep(hostID(addr, a.cfg.Upstreams))
	if err != nil {
		dep.Record(start, err)
		return fail(w, http.StatusBadGateway, err)
	}
	defer resp.Body.Close()
	payload, err := io.ReadAll(resp.Body)
	if resp.StatusCode >= 400 && err == nil {
		err = fmt.Errorf("answered %d", resp.StatusCode)
	}
	dep.Record(start, err)
	if failed := resp.Header.Get("X-Redline-Failed"); failed != "" {
		w.Header().Set("X-Redline-Failed", failed)
	}
	if edge {
		if r.Method == http.MethodGet && resp.StatusCode == http.StatusOK {
			a.edge.Set(strconv.FormatInt(key, 10), payload)
		} else if r.Method != http.MethodGet {
			a.edge.Delete(strconv.FormatInt(key, 10))
		}
	}
	w.WriteHeader(resp.StatusCode)
	_, _ = w.Write(payload)
	return resp.StatusCode
}

// hostID names the dependency a forwarded request went to. A box with one upstream reports
// under that name; with several it reports under "upstream", since the address alone can't say.
func hostID(_ string, upstreams []string) string {
	if len(upstreams) == 1 {
		return upstreams[0]
	}
	return "upstream"
}

func (a *Agent) stand(w http.ResponseWriter, r *http.Request) int {
	delay := a.cfg.LatencyMs * (0.9 + 0.2*rand.Float64())
	select {
	case <-time.After(time.Duration(delay * float64(time.Millisecond))):
	case <-r.Context().Done():
		return 499
	}
	if r.Method == http.MethodGet {
		_, _ = w.Write(a.payload)
		return http.StatusOK
	}
	w.WriteHeader(http.StatusOK)
	return http.StatusOK
}

func (a *Agent) startWorkers(ctx context.Context) {
	host, _ := os.Hostname()
	for _, ref := range a.cfg.Consume {
		client, err := openRedis(ctx, ref.ID, ref.Addr)
		if err != nil {
			fmt.Fprintln(os.Stderr, "redline:", err)
			os.Exit(1)
		}
		ensureGroup(ctx, client, ref.Stream, ref.Group)
		for i := 0; i < 4; i++ {
			go a.consume(ctx, client, ref, fmt.Sprintf("%s-%d", host, i))
		}
	}
}

func ensureGroup(ctx context.Context, client *redis.Client, stream, group string) {
	err := client.XGroupCreateMkStream(ctx, stream, group, "0").Err()
	if err != nil && !isBusyGroup(err) {
		fmt.Fprintln(os.Stderr, "redline: can't create the consumer group:", err)
	}
}

func isBusyGroup(err error) bool {
	return err != nil && len(err.Error()) >= 9 && err.Error()[:9] == "BUSYGROUP"
}

func (a *Agent) consume(ctx context.Context, client *redis.Client, ref ConsumeRef, name string) {
	for ctx.Err() == nil {
		streams, err := client.XReadGroup(ctx, &redis.XReadGroupArgs{
			Group:    ref.Group,
			Consumer: name,
			Streams:  []string{ref.Stream, ">"},
			Count:    16,
			Block:    time.Second,
		}).Result()
		if errors.Is(err, redis.Nil) {
			continue
		}
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			ensureGroup(ctx, client, ref.Stream, ref.Group)
			time.Sleep(200 * time.Millisecond)
			continue
		}
		for _, stream := range streams {
			for _, msg := range stream.Messages {
				a.process(ctx, msg)
				client.XAck(ctx, ref.Stream, ref.Group, msg.ID)
			}
		}
	}
}

func (a *Agent) process(ctx context.Context, msg redis.XMessage) {
	start := time.Now()
	a.m.InFlight.Add(1)
	defer func() {
		a.m.InFlight.Add(-1)
		a.m.Hist.Observe(time.Since(start))
	}()
	key, _ := strconv.ParseInt(fmt.Sprint(msg.Values["key"]), 10, 64)
	body := []byte(fmt.Sprint(msg.Values["body"]))
	work(a.cfg.WorkMs)
	jobCtx, cancel := context.WithTimeout(ctx, time.Duration(max(100, a.cfg.TimeoutMs))*time.Millisecond)
	defer cancel()
	err := a.apply(jobCtx, key, body, true)
	if err == nil {
		err = a.callAll(jobCtx, http.MethodPost, key, body)
	}
	if err != nil {
		a.m.Failed.Add(1)
		return
	}
	a.m.Processed.Add(1)
}
