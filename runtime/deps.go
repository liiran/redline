package main

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
)

type Store interface {
	Read(ctx context.Context, key int64) ([]byte, error)
	Write(ctx context.Context, key int64, body []byte) error
	Record(ctx context.Context, key int64, body []byte) error
	Stats() PoolStats
	Close()
}

type KV interface {
	Get(ctx context.Context, key int64) ([]byte, bool, error)
	Set(ctx context.Context, key int64, body []byte) error
	Del(ctx context.Context, key int64) error
}

type Producer interface {
	Add(ctx context.Context, key int64, body []byte) error
}

type PoolStats struct {
	Acquires int64
	Waits    int64
	WaitUs   int64
	InUse    int64
	Max      int64
}

type pgStore struct{ pool *pgxpool.Pool }

func openStore(ctx context.Context, ref DatabaseRef) (*pgStore, error) {
	cfg, err := pgxpool.ParseConfig(ref.DSN)
	if err != nil {
		return nil, err
	}
	size := int32(max(1, ref.Pool))
	cfg.MaxConns = size
	cfg.MinConns = size
	cfg.MaxConnIdleTime = time.Hour
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}
	if err := retry(ctx, 30*time.Second, func() error { return pool.Ping(ctx) }); err != nil {
		pool.Close()
		return nil, fmt.Errorf("can't reach %s: %w", ref.ID, err)
	}
	return &pgStore{pool: pool}, nil
}

func (s *pgStore) Read(ctx context.Context, key int64) ([]byte, error) {
	var body []byte
	err := s.pool.QueryRow(ctx, "SELECT body FROM items WHERE id = $1", key).Scan(&body)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return body, err
}

func (s *pgStore) Write(ctx context.Context, key int64, body []byte) error {
	_, err := s.pool.Exec(ctx,
		"INSERT INTO items (id, body) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET body = EXCLUDED.body, updated_at = now()",
		key, body)
	return err
}

func (s *pgStore) Record(ctx context.Context, key int64, body []byte) error {
	_, err := s.pool.Exec(ctx, "INSERT INTO events (item_id, body) VALUES ($1, $2)", key, body)
	return err
}

func (s *pgStore) Stats() PoolStats {
	st := s.pool.Stat()
	return PoolStats{
		Acquires: st.AcquireCount(),
		Waits:    st.EmptyAcquireCount(),
		WaitUs:   st.AcquireDuration().Microseconds(),
		InUse:    int64(st.AcquiredConns()),
		Max:      int64(st.MaxConns()),
	}
}

func (s *pgStore) Close() { s.pool.Close() }

func openRedis(ctx context.Context, id, addr string) (*redis.Client, error) {
	client := redis.NewClient(&redis.Options{Addr: addr, PoolSize: 256, MinIdleConns: 8, MaxRetries: -1})
	if err := retry(ctx, 30*time.Second, func() error { return client.Ping(ctx).Err() }); err != nil {
		client.Close()
		return nil, fmt.Errorf("can't reach %s: %w", id, err)
	}
	return client, nil
}

type redisKV struct {
	client *redis.Client
	ttl    time.Duration
}

func itemKey(key int64) string { return fmt.Sprintf("item:%d", key) }

func (r *redisKV) Get(ctx context.Context, key int64) ([]byte, bool, error) {
	body, err := r.client.Get(ctx, itemKey(key)).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return body, true, nil
}

func (r *redisKV) Set(ctx context.Context, key int64, body []byte) error {
	return r.client.Set(ctx, itemKey(key), body, r.ttl).Err()
}

func (r *redisKV) Del(ctx context.Context, key int64) error {
	return r.client.Del(ctx, itemKey(key)).Err()
}

type redisProducer struct {
	client *redis.Client
	stream string
}

func (p *redisProducer) Add(ctx context.Context, key int64, body []byte) error {
	return p.client.XAdd(ctx, &redis.XAddArgs{
		Stream: p.stream,
		MaxLen: 200_000,
		Approx: true,
		Values: []any{"key", key, "body", body},
	}).Err()
}

func retry(ctx context.Context, limit time.Duration, fn func() error) error {
	deadline := time.Now().Add(limit)
	for {
		err := fn()
		if err == nil {
			return nil
		}
		if time.Now().After(deadline) || ctx.Err() != nil {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(250 * time.Millisecond):
		}
	}
}
