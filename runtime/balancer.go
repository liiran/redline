package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"sort"
	"sync"
	"sync/atomic"
	"time"
)

// Balancer spreads requests over every container behind one or more names. Docker's DNS
// returns one address per copy, so a name with three copies gets every third request each.
type Balancer struct {
	names  []string
	port   int
	lookup func(ctx context.Context, host string) ([]string, error)

	mu    sync.RWMutex
	addrs []string
	next  atomic.Uint64
}

func NewBalancer(names []string, port int) *Balancer {
	return &Balancer{names: names, port: port, lookup: net.DefaultResolver.LookupHost}
}

func (b *Balancer) Refresh(ctx context.Context) error {
	var all []string
	var lastErr error
	for _, name := range b.names {
		ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
		hosts, err := b.lookup(ctx, name)
		cancel()
		if err != nil {
			lastErr = fmt.Errorf("can't find %s: %w", name, err)
			continue
		}
		for _, host := range hosts {
			all = append(all, net.JoinHostPort(host, fmt.Sprint(b.port)))
		}
	}
	if len(all) == 0 {
		if lastErr == nil {
			lastErr = errors.New("nothing to send requests to")
		}
		return lastErr
	}
	sort.Strings(all)
	b.mu.Lock()
	b.addrs = all
	b.mu.Unlock()
	return nil
}

func (b *Balancer) Pick() (string, bool) {
	b.mu.RLock()
	defer b.mu.RUnlock()
	if len(b.addrs) == 0 {
		return "", false
	}
	i := b.next.Add(1) - 1
	return b.addrs[i%uint64(len(b.addrs))], true
}

func (b *Balancer) Addrs() []string {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return append([]string(nil), b.addrs...)
}

// Start resolves until it works once, then keeps the list fresh in the background.
func (b *Balancer) Start(ctx context.Context, wait time.Duration) error {
	deadline := time.Now().Add(wait)
	for {
		err := b.Refresh(ctx)
		if err == nil {
			break
		}
		if time.Now().After(deadline) || ctx.Err() != nil {
			return err
		}
		time.Sleep(250 * time.Millisecond)
	}
	go func() {
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				_ = b.Refresh(ctx)
			}
		}
	}()
	return nil
}
