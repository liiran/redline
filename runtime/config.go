package main

import (
	"encoding/json"
	"fmt"
	"os"
)

type DatabaseRef struct {
	ID   string `json:"id"`
	DSN  string `json:"dsn"`
	Pool int    `json:"pool"`
}

type CacheRef struct {
	ID     string `json:"id"`
	Addr   string `json:"addr"`
	TTLSec int    `json:"ttlSec"`
}

type QueueRef struct {
	ID     string `json:"id"`
	Addr   string `json:"addr"`
	Stream string `json:"stream"`
}

type ConsumeRef struct {
	ID     string `json:"id"`
	Addr   string `json:"addr"`
	Stream string `json:"stream"`
	Group  string `json:"group"`
}

type CallRef struct {
	ID  string `json:"id"`
	URL string `json:"url"`
}

type AgentConfig struct {
	ID           string        `json:"id"`
	Mode         string        `json:"mode"`
	Port         int           `json:"port"`
	WorkMs       float64       `json:"workMs"`
	TTLSec       int           `json:"ttlSec"`
	LatencyMs    float64       `json:"latencyMs"`
	TimeoutMs    int           `json:"timeoutMs"`
	PayloadBytes int           `json:"payloadBytes"`
	Upstreams    []string      `json:"upstreams"`
	Databases    []DatabaseRef `json:"databases"`
	Caches       []CacheRef    `json:"caches"`
	Queues       []QueueRef    `json:"queues"`
	Consume      []ConsumeRef  `json:"consume"`
	Calls        []CallRef     `json:"calls"`
}

type Workload struct {
	ReadRatio    float64 `json:"readRatio"`
	Keys         int     `json:"keys"`
	PayloadBytes int     `json:"payloadBytes"`
	SloP95Ms     int     `json:"sloP95Ms"`
	TimeoutMs    int     `json:"timeoutMs"`
}

type ProbeNode struct {
	ID     string   `json:"id"`
	Kind   string   `json:"kind"`
	Type   string   `json:"type"`
	Host   string   `json:"host,omitempty"`
	Port   int      `json:"port,omitempty"`
	DSN    string   `json:"dsn,omitempty"`
	Addr   string   `json:"addr,omitempty"`
	Stream string   `json:"stream,omitempty"`
	Groups []string `json:"groups,omitempty"`
}

type ProbeConfig struct {
	Port     int         `json:"port"`
	Targets  []string    `json:"targets"`
	Workload Workload    `json:"workload"`
	Nodes    []ProbeNode `json:"nodes"`
}

func loadConfig(into any) error {
	raw := os.Getenv("REDLINE_CONFIG")
	if raw == "" {
		return fmt.Errorf("REDLINE_CONFIG is not set")
	}
	if err := json.Unmarshal([]byte(raw), into); err != nil {
		return fmt.Errorf("REDLINE_CONFIG is not valid: %w", err)
	}
	return nil
}
