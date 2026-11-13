# Breaking points measured on real containers

Docker 28.4.0 with 12 CPUs and 15.2 GB (host: AMD Ryzen 5 9600X 6-Core Processor), 2026-11-13.
Each step holds a rate for 4 seconds after 2 to settle; a step passes when p95 is under the design's target (250 ms, or 500 ms for Checkout) and under 1% of requests fail.
Boxes use Redline's default sizes (0.5 CPU per service copy, 1 CPU for Postgres), so the numbers compare designs with each other, not with production hardware.

| Design | Containers | Ready in | Holds | Breaks at | What broke |
| --- | --- | --- | --- | --- | --- |
| URL shortener: 1 API copy, Postgres | 3 | 7.9 s | 400 req/s | 450 req/s | API ran out of CPU |
| … with 3 API copies | 5 | 7.8 s | 1.2k req/s | 1.3k req/s | API ran out of CPU |
| … with 3 API copies and a Redis cache | 6 | 9.4 s | 1.2k req/s | 1.3k req/s | API ran out of CPU |
| Cached feed: load balancer, 2 API copies, Redis, Postgres | 6 | 9.5 s | 750 req/s | 820 req/s | API ran out of CPU |
| Checkout: payments API, Postgres, queue and worker | 6 | 7.7 s | 350 req/s | 400 req/s | Orders API ran out of CPU |
