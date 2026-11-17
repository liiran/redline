package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/redis/go-redis/v9"
)

type DepRate struct {
	CallsPS  float64 `json:"callsPs"`
	ErrorsPS float64 `json:"errorsPs"`
	AvgMs    float64 `json:"avgMs"`
}

type NodeSample struct {
	Kind      string             `json:"kind"`
	Up        int                `json:"up"`
	Error     string             `json:"error,omitempty"`
	RPS       float64            `json:"rps,omitempty"`
	ErrorsPS  float64            `json:"errorsPs,omitempty"`
	InFlight  int64              `json:"inFlight,omitempty"`
	Waiting   int64              `json:"waiting,omitempty"`
	Latency   *Latency           `json:"latency,omitempty"`
	Deps      map[string]DepRate `json:"deps,omitempty"`
	HitsPS    float64            `json:"hitsPs,omitempty"`
	MissesPS  float64            `json:"missesPs,omitempty"`
	Processed float64            `json:"processedPs,omitempty"`
	Failed    float64            `json:"failedPs,omitempty"`
	PoolInUse int64              `json:"poolInUse,omitempty"`
	PoolMax   int64              `json:"poolMax,omitempty"`
	PoolWaits float64            `json:"poolWaitsPs,omitempty"`
	PoolWait  float64            `json:"poolWaitMs,omitempty"`
	TPS       float64            `json:"tps,omitempty"`
	Active    int64              `json:"active,omitempty"`
	Conns     int64              `json:"conns,omitempty"`
	OpsPS     float64            `json:"opsPs,omitempty"`
	MemoryMB  float64            `json:"memoryMb,omitempty"`
	Backlog   int64              `json:"backlog,omitempty"`
	Length    int64              `json:"length,omitempty"`
}

type scraper interface {
	ID() string
	Scrape(ctx context.Context) NodeSample
}

func buildScrapers(ctx context.Context, nodes []ProbeNode) []scraper {
	out := make([]scraper, 0, len(nodes))
	for _, node := range nodes {
		switch node.Type {
		case "agent":
			out = append(out, &agentScraper{node: node, client: &http.Client{Timeout: 900 * time.Millisecond}})
		case "postgres":
			out = append(out, &pgScraper{node: node})
		case "redis":
			client := redis.NewClient(&redis.Options{Addr: node.Addr, PoolSize: 4, MaxRetries: -1})
			out = append(out, &redisScraper{node: node, client: client})
		}
	}
	return out
}

type agentScraper struct {
	node   ProbeNode
	client *http.Client
	prev   *AgentSnapshot
	prevAt time.Time
}

func (s *agentScraper) ID() string { return s.node.ID }

func (s *agentScraper) Scrape(ctx context.Context) NodeSample {
	out := NodeSample{Kind: s.node.Kind}
	hosts, err := net.DefaultResolver.LookupHost(ctx, s.node.Host)
	if err != nil {
		out.Error = "can't be found"
		return out
	}
	var mu sync.Mutex
	var wg sync.WaitGroup
	var total AgentSnapshot
	total.Deps = map[string]DepSnapshot{}
	for _, host := range hosts {
		wg.Add(1)
		go func(host string) {
			defer wg.Done()
			snap, err := s.fetch(ctx, host)
			if err != nil {
				return
			}
			mu.Lock()
			defer mu.Unlock()
			out.Up++
			addSnapshot(&total, snap)
		}(host)
	}
	wg.Wait()
	if out.Up == 0 {
		out.Error = "not answering"
		return out
	}
	now := time.Now()
	out.InFlight = total.InFlight
	out.Waiting = total.Waiting
	out.PoolInUse = total.PoolInUse
	out.PoolMax = total.PoolMax
	if s.prev != nil {
		secs := now.Sub(s.prevAt).Seconds()
		if secs <= 0 {
			secs = 1
		}
		prev := s.prev
		per := func(a, b int64) float64 { return round2(float64(max(0, a-b)) / secs) }
		out.RPS = per(total.Requests, prev.Requests)
		out.ErrorsPS = per(total.Errors, prev.Errors)
		out.HitsPS = per(total.Hits, prev.Hits)
		out.MissesPS = per(total.Misses, prev.Misses)
		out.Processed = per(total.Processed, prev.Processed)
		out.Failed = per(total.Failed, prev.Failed)
		out.PoolWaits = per(total.PoolWaits, prev.PoolWaits)
		if acquires := total.PoolAcquire - prev.PoolAcquire; acquires > 0 {
			out.PoolWait = round2(float64(total.PoolWaitUs-prev.PoolWaitUs) / float64(acquires) / 1000)
		}
		lat := summarize(diffCounts(total.Hist, prev.Hist))
		out.Latency = &lat
		out.Deps = map[string]DepRate{}
		for name, dep := range total.Deps {
			before := prev.Deps[name]
			calls := dep.Calls - before.Calls
			rate := DepRate{CallsPS: per(dep.Calls, before.Calls), ErrorsPS: per(dep.Errors, before.Errors)}
			if calls > 0 {
				rate.AvgMs = round2(float64(dep.Micros-before.Micros) / float64(calls) / 1000)
			}
			out.Deps[name] = rate
		}
	}
	s.prev = &total
	s.prevAt = now
	return out
}

func (s *agentScraper) fetch(ctx context.Context, host string) (AgentSnapshot, error) {
	var snap AgentSnapshot
	url := fmt.Sprintf("http://%s/metrics", net.JoinHostPort(host, strconv.Itoa(s.node.Port)))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return snap, err
	}
	resp, err := s.client.Do(req)
	if err != nil {
		return snap, err
	}
	defer resp.Body.Close()
	err = json.NewDecoder(resp.Body).Decode(&snap)
	return snap, err
}

func addSnapshot(total *AgentSnapshot, snap AgentSnapshot) {
	total.Requests += snap.Requests
	total.Errors += snap.Errors
	total.InFlight += snap.InFlight
	total.Waiting += snap.Waiting
	total.Hits += snap.Hits
	total.Misses += snap.Misses
	total.Processed += snap.Processed
	total.Failed += snap.Failed
	total.PoolAcquire += snap.PoolAcquire
	total.PoolWaits += snap.PoolWaits
	total.PoolWaitUs += snap.PoolWaitUs
	total.PoolInUse += snap.PoolInUse
	total.PoolMax += snap.PoolMax
	total.Hist = sumInto(total.Hist, snap.Hist)
	for name, dep := range snap.Deps {
		cur := total.Deps[name]
		cur.Calls += dep.Calls
		cur.Errors += dep.Errors
		cur.Micros += dep.Micros
		total.Deps[name] = cur
	}
}

type pgScraper struct {
	node   ProbeNode
	conn   *pgx.Conn
	prevTx int64
	prevAt time.Time
}

func (s *pgScraper) ID() string { return s.node.ID }

func (s *pgScraper) Scrape(ctx context.Context) NodeSample {
	out := NodeSample{Kind: s.node.Kind}
	if s.conn == nil || s.conn.IsClosed() {
		conn, err := pgx.Connect(ctx, s.node.DSN)
		if err != nil {
			out.Error = "not answering"
			return out
		}
		s.conn = conn
	}
	var tx, active, conns int64
	err := s.conn.QueryRow(ctx, `
		SELECT (SELECT xact_commit + xact_rollback FROM pg_stat_database WHERE datname = current_database()),
		       (SELECT count(*) FILTER (WHERE state = 'active') - 1 FROM pg_stat_activity WHERE datname = current_database()),
		       (SELECT count(*) - 1 FROM pg_stat_activity WHERE datname = current_database())`).Scan(&tx, &active, &conns)
	if err != nil {
		out.Error = "not answering"
		_ = s.conn.Close(context.Background())
		s.conn = nil
		return out
	}
	out.Up = 1
	out.Active = max(0, active)
	out.Conns = max(0, conns)
	now := time.Now()
	if !s.prevAt.IsZero() {
		// pg_stat_database counts this scraper's own query too; one a second is noise.
		out.TPS = round2(max(0, float64(tx-s.prevTx-1)) / now.Sub(s.prevAt).Seconds())
	}
	s.prevTx, s.prevAt = tx, now
	return out
}

type redisScraper struct {
	node     ProbeNode
	client   *redis.Client
	prevOps  int64
	prevHits int64
	prevMiss int64
	prevAt   time.Time
}

func (s *redisScraper) ID() string { return s.node.ID }

func parseInfo(info string) map[string]string {
	out := map[string]string{}
	for _, line := range strings.Split(info, "\n") {
		line = strings.TrimSpace(line)
		if k, v, ok := strings.Cut(line, ":"); ok {
			out[k] = v
		}
	}
	return out
}

func (s *redisScraper) Scrape(ctx context.Context) NodeSample {
	out := NodeSample{Kind: s.node.Kind}
	info, err := s.client.Info(ctx, "stats", "memory").Result()
	if err != nil {
		out.Error = "not answering"
		return out
	}
	out.Up = 1
	fields := parseInfo(info)
	num := func(key string) int64 {
		v, _ := strconv.ParseInt(fields[key], 10, 64)
		return v
	}
	ops, hits, misses := num("total_commands_processed"), num("keyspace_hits"), num("keyspace_misses")
	out.MemoryMB = round2(float64(num("used_memory")) / (1 << 20))
	now := time.Now()
	if !s.prevAt.IsZero() {
		secs := now.Sub(s.prevAt).Seconds()
		// INFO itself is one command; the backlog checks below add a few more.
		out.OpsPS = round2(max(0, float64(ops-s.prevOps-4)) / secs)
		out.HitsPS = round2(float64(max(0, hits-s.prevHits)) / secs)
		out.MissesPS = round2(float64(max(0, misses-s.prevMiss)) / secs)
	}
	s.prevOps, s.prevHits, s.prevMiss, s.prevAt = ops, hits, misses, now
	if s.node.Stream != "" {
		out.Length, _ = s.client.XLen(ctx, s.node.Stream).Result()
		groups, err := s.client.XInfoGroups(ctx, s.node.Stream).Result()
		if err == nil {
			for _, g := range groups {
				out.Backlog = max(out.Backlog, max(0, g.Lag)+g.Pending)
			}
		}
	}
	return out
}

func (p *Probe) prepare(ctx context.Context) error {
	keys := max(2, p.cfg.Workload.Keys)
	size := max(16, p.cfg.Workload.PayloadBytes)
	for _, node := range p.cfg.Nodes {
		switch node.Type {
		case "postgres":
			conn, err := connectRetry(ctx, node.DSN)
			if err != nil {
				return fmt.Errorf("can't reach %s: %w", node.ID, err)
			}
			_, err = conn.Exec(ctx, `
				CREATE TABLE IF NOT EXISTS items (id bigint PRIMARY KEY, body bytea NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
				CREATE TABLE IF NOT EXISTS events (id bigserial PRIMARY KEY, item_id bigint NOT NULL, body bytea NOT NULL, created_at timestamptz NOT NULL DEFAULT now());`)
			if err == nil {
				_, err = conn.Exec(ctx, `INSERT INTO items (id, body) SELECT g, convert_to(repeat('x', $2::int), 'UTF8') FROM generate_series(1, $1::int) g ON CONFLICT DO NOTHING`, keys, size)
			}
			if err == nil {
				_, err = conn.Exec(ctx, "ANALYZE items")
			}
			_ = conn.Close(ctx)
			if err != nil {
				return fmt.Errorf("can't set up %s: %w", node.ID, err)
			}
		case "redis":
			if node.Stream == "" {
				continue
			}
			client := redis.NewClient(&redis.Options{Addr: node.Addr})
			for _, group := range node.Groups {
				ensureGroup(ctx, client, node.Stream, group)
			}
			client.Close()
		}
	}
	p.prepared.Store(true)
	return nil
}

func connectRetry(ctx context.Context, dsn string) (*pgx.Conn, error) {
	var conn *pgx.Conn
	err := retry(ctx, 30*time.Second, func() error {
		c, err := pgx.Connect(ctx, dsn)
		if err == nil {
			conn = c
		}
		return err
	})
	return conn, err
}
