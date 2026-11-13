package main

import (
	"sync/atomic"
	"time"
)

var (
	itersPerMs atomic.Int64
	sink       atomic.Uint64
)

func spin(iters int64) uint64 {
	x := uint64(0x9E3779B97F4A7C15)
	for i := int64(0); i < iters; i++ {
		x ^= x << 13
		x ^= x >> 7
		x ^= x << 17
	}
	return x
}

// calibrate measures how much spinning one unthrottled millisecond of CPU holds. It keeps the
// fastest of many short rounds, so a container's CPU limit doesn't lower the figure.
func calibrate() {
	const round = 20_000
	best := time.Duration(1 << 62)
	for i := 0; i < 40; i++ {
		start := time.Now()
		sink.Add(spin(round))
		if d := time.Since(start); d > 0 && d < best {
			best = d
		}
		if i%8 == 7 {
			time.Sleep(2 * time.Millisecond)
		}
	}
	per := int64(float64(round) / (float64(best) / float64(time.Millisecond)))
	if per < 1000 {
		per = 1000
	}
	itersPerMs.Store(per)
}

// work burns a fixed amount of CPU. Under a CPU limit or contention it takes longer, the way
// real request handling does.
func work(ms float64) {
	if ms <= 0 {
		return
	}
	sink.Add(spin(int64(ms * float64(itersPerMs.Load()))))
}
