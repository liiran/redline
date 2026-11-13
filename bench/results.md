# Breaking points measured on real containers

Docker 28.4.0 with 12 CPUs and 15.2 GB (host: AMD Ryzen 5 9600X 6-Core Processor), 2026-11-13.
Each step holds a rate for 4 seconds after 2 to settle; a step passes when p95 is under the design's target (250 ms, or 500 ms for Checkout) and under 1% of requests fail.
Boxes use Redline's default sizes (0.5 CPU per service copy, 1 CPU for Postgres), so the numbers compare designs with each other, not with production hardware.

| Design | Containers | Ready in | Holds | Breaks at | What broke |
| --- | --- | --- | --- | --- | --- |
| URL shortener: 1 API copy, Postgres | 3 | 9.0 s | 400 req/s | 450 req/s | API ran out of CPU |
| … with 3 API copies | 5 | 8.5 s | 1.2k req/s | 1.3k req/s | API ran out of CPU |
| … with 3 API copies and a Redis cache | 6 | 9.3 s | 1k req/s | 1.2k req/s | API ran out of CPU |
| 6 API copies, Postgres limited to 0.2 CPU | 8 | 19.6 s | 1k req/s | 1.2k req/s | Postgres ran out of CPU |
| … with a Redis cache in front of Postgres | 9 | 20.3 s | 2k req/s | 2.3k req/s | API ran out of CPU |
| Cached feed: load balancer, 2 API copies, Redis, Postgres | 6 | 11.1 s | 750 req/s | 820 req/s | API ran out of CPU |
| Checkout: payments API, Postgres, queue and worker | 6 | 8.6 s | 300 req/s | 350 req/s | Mailer ran out of CPU |
