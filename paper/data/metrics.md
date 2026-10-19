# Deep Connect measurements

- **kdf_ms** (ms): n=20, mean 15.5384, sd 0.3069, p50 15.4762, p95 16.1184, min 15.1373, max 16.1504
- **channel_hash_us** (us): n=2000, mean 0.6969, sd 1.2196, p50 0.5, p95 1.2911, min 0.375, max 38.375
- **ws_connect_ms** (ms): n=12, mean 3.8005, sd 4.5851, p50 2.4036, p95 10.1001, min 2.2936, max 18.3306
- **rtt_1k_ms** (ms): n=60, mean 0.4207, sd 0.2136, p50 0.3601, p95 0.6417, min 0.2645, max 1.4977
- **rtt_64k_ms** (ms): n=40, mean 1.048, sd 0.4481, p50 0.9133, p95 1.8373, min 0.78, max 3.3541
- **index_broadcast_ms** (ms): n=30, mean 0.233, sd 0.0312, p50 0.2312, p95 0.2777, min 0.1958, max 0.359

## Seal throughput

| payload | ops/s | MB/s | ms/op |
|---|---|---|---|
| 1 KiB | 81395 | 79.49 | 0.012 |
| 8 KiB | 53826 | 420.52 | 0.019 |
| 64 KiB | 16701 | 1043.83 | 0.060 |
| 256 KiB | 3032 | 757.99 | 0.330 |
| 1 MiB | 1038 | 1037.67 | 0.964 |

## Index scale

| sessions | events | build ms | wire bytes | per session |
|---|---|---|---|---|
| 10 | 440 | 1.07 | 4571 | 457 |
| 50 | 2200 | 1.05 | 23011 | 460 |
| 200 | 8800 | 3.59 | 92561 | 463 |

## Transcripts

| turns | events | export p50 ms | plaintext B | ciphertext B | wire B |
|---|---|---|---|---|---|
| 6 | 16 | 0.01 | 1916 | 2592 | 2634 |
| 200 | 404 | 0.09 | 58577 | 78140 | 78182 |
| 2000 | 4004 | 0.33 | 589982 | 786680 | 786722 |
