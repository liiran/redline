package main

import (
	"container/list"
	"sync"
	"time"
)

type lruEntry struct {
	key     string
	body    []byte
	expires time.Time
}

// LRU is the edge cache behind the CDN box: a bounded map that drops the least recently used
// entry when full and treats anything older than its TTL as missing.
type LRU struct {
	mu    sync.Mutex
	cap   int
	ttl   time.Duration
	order *list.List
	items map[string]*list.Element
	now   func() time.Time
}

func NewLRU(capacity int, ttl time.Duration) *LRU {
	return &LRU{cap: capacity, ttl: ttl, order: list.New(), items: map[string]*list.Element{}, now: time.Now}
}

func (c *LRU) Get(key string) ([]byte, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	el, ok := c.items[key]
	if !ok {
		return nil, false
	}
	entry := el.Value.(*lruEntry)
	if c.now().After(entry.expires) {
		c.order.Remove(el)
		delete(c.items, key)
		return nil, false
	}
	c.order.MoveToFront(el)
	return entry.body, true
}

func (c *LRU) Set(key string, body []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if el, ok := c.items[key]; ok {
		entry := el.Value.(*lruEntry)
		entry.body = body
		entry.expires = c.now().Add(c.ttl)
		c.order.MoveToFront(el)
		return
	}
	c.items[key] = c.order.PushFront(&lruEntry{key: key, body: body, expires: c.now().Add(c.ttl)})
	for c.order.Len() > c.cap {
		last := c.order.Back()
		c.order.Remove(last)
		delete(c.items, last.Value.(*lruEntry).key)
	}
}

func (c *LRU) Delete(key string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if el, ok := c.items[key]; ok {
		c.order.Remove(el)
		delete(c.items, key)
	}
}

func (c *LRU) Len() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.order.Len()
}
