# How well Redline reads drawings

48 synthetic hand-drawn sketches from eval/cases.ts, read by claude-opus-5-5 via Claude Code.
Clean sketches are flat and sharp. Hard ones are tilted, blurred, saved as JPEG, have glare, and carry decoys that must not
become boxes: a title, words on arrows, a sticky note and a crossed-out box. Some are 8-box systems.

| Measure | All (48) | Clean (24) | Hard (24) |
| --- | --- | --- | --- |
| Read exactly right (every box, kind and arrow) | 46 (95.8%) | 24 (100.0%) | 22 (91.7%) |
| Runnable as read | 100.0% | 100.0% | 100.0% |
| Boxes found | 100.0% | 100.0% | 100.0% |
| Boxes made up | 0 | 0 | 0 |
| Kinds right | 100.0% | 100.0% | 100.0% |
| Arrows right | 99.2% | 100.0% | 98.6% |
| Arrows made up | 1 | 0 | 1 |
| Stacked copies counted right | 12 of 14 | 6 of 8 | 6 of 6 |
| Box position overlap (mean IoU) | 0.87 | 0.84 | 0.89 |
| Time per sketch (median) | 4.4 s | 4.2 s | 5.6 s |
| Time per sketch (p90) | 9.5 s | 6.0 s | 9.8 s |
| Cost | $1.48 | $0.69 | $0.79 |

## Every miss

- case-01 (three-tier, left to right, paper, Bradley Hand, stacked copies): boxes 3/3, kinds 3/3, arrows 2/2, stacked copies miscounted
- case-20 (cached, left to right, whiteboard, Segoe Print, stacked copies): boxes 5/5, kinds 5/5, arrows 4/4, stacked copies miscounted
- case-34 (hard, big, left to right, whiteboard, Comic Sans MS, two heads Catalog-MySQL, no head Kafka-Jobs, title, arrow words, arrow words, sticky note, crossed out, tilted -5 degrees): boxes 8/8, kinds 8/8, arrows 7/8
- case-35 (hard, microservices, left to right, whiteboard, Ink Free, two heads App-Mongo, two heads App-Web server, title, arrow words, arrow words, crossed out, tilted 5 degrees): boxes 6/6, kinds 6/6, arrows 5/6 +1 extra
