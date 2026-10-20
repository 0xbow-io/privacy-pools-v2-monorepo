# Circuits - Benchmark

This document presents benchmark results for all Privacy Pools V2 circuits across multiple tree depth configurations. The system consists of **27 circuits** across 3 types: deposit (1), transact (25 variants from 1x1 to 5x5), and ragequit (1).

### Summary (Config E — current production)

| Metric | Range |
| --- | --- |
| **Constraints** | 2.1K (deposit) to 143K (transact_5x5) |
| **Proof Generation** | 137ms (deposit) to 5.2s (transact_5x5) |
| **Verification** | ~3-12ms (effectively constant, Groth16 property) |
| **Proving Key Size** | 1.2 MB (deposit) to 65.8 MB (transact_5x5) |

Key findings:

- Verification time is effectively constant regardless of circuit size (Groth16 property; variation in the data is measurement noise).
- Transact circuits scale predictably with both inputs and outputs (see "Scaling Analysis" below for the formula refit against Config E).
- Config E raised tree depths from `18/14/14` (former Config D) to `22/18/18` as part of the M-1 audit fix, plus added in-circuit range checks for AW-M-01, AW-L-01, INS-1.
- Compared to Config D, transact_2x2 grew from 50,082 to 63,916 constraints (+28%) and the zkey from 22.1 MB to 26.2 MB (+19%). Proving time stayed close (1.97s → 1.99s).
- Proof size is constant at 256 bytes regardless of NxM (Groth16 property).

## Configuration Comparison

Different tree depths offer trade-offs between capacity and performance. **Config E is the current production configuration; A-D are historical reference points.**

| Config | State | Keystore | ASP | Description |
| --- | --- | --- | --- | --- |
| **A** | 32 | 32 | 32 | Maximum capacity baseline (historical) |
| **B** | 32 | 24 | 24 | Reduced keystore/ASP (historical) |
| **C** | 24 | 20 | 20 | Balanced reduction (historical) |
| **D** | 18 | 14 | 14 | Previous production (pre-M-1) |
| **E** | 22 | 18 | 18 | **Current production** (post-M-1, post-AW-M-01 / AW-L-01 / INS-1) |

### Capacity Analysis

| Config | Max State Leaves | Max Keystore Users | Max ASP Labels |
| --- | --- | --- | --- |
| **A** | 4.3B (2^32) | 4.3B | 4.3B |
| **B** | 4.3B | 16.7M (2^24) | 16.7M |
| **C** | 16.7M | 1M (2^20) | 1M |
| **D** | 262K (2^18) | 16K (2^14) | 16K |
| **E** | **4.2M (2^22)** | **262K (2^18)** | **262K (2^18)** |

Note: the state tree in Config E holds both timestamped commitment leaves and timestamped nullifier leaves (M-0). Capacity is shared across both leaf types.

### Performance Summary

| Config | transact_2x2 Constraints | Proof Time | PKey Size | vs A |
| --- | --- | --- | --- | --- |
| **A** (32/32/32) | 90,918 | 3.23s | 41.0 MB | baseline |
| **B** (32/24/24) | 78,966 | 2.64s | 36.6 MB | -13% / -18% / -11% |
| **C** (24/20/20) | 65,022 | 2.67s | 31.5 MB | -28% / -17% / -23% |
| **D** (18/14/14) | 50,082 | 1.97s | 22.1 MB | -45% / -39% / -46% |
| **E** (22/18/18) | **63,916** | **1.99s** | **26.2 MB** | **-30% / -38% / -36%** |

> Note: Verification time is effectively constant (~3-12ms) regardless of configuration.

> Note: PKey sizes compared across configurations (this table, "Key Findings (Config D vs E)" and the Config D comparison in the summary) come from single-contributor dev setups, so they compare like for like. The committed Config E keys come from the phase-2 trusted-setup ceremony and are ~0.19 MB larger each, since every zkey carries 501 contribution records (see the Config E artifact sizes below and [`packages/circuits/CEREMONY.md`](../../../packages/circuits/CEREMONY.md)).

### Full 5x5 Matrix Summary (Config E)

| Metric | transact_1x1 | transact_2x2 | transact_3x3 | transact_5x5 |
| --- | --- | --- | --- | --- |
| Constraints | 37,672 | 63,916 | 90,175 | 142,741 |
| Proof Time | 1.54s | 1.99s | 3.10s | 5.16s |
| PKey Size | 17.3 MB | 26.4 MB | 39.5 MB | 65.8 MB |

### Key Findings (Config D vs E)

| Circuit | Constraint Change | Proof Time Change | PKey Size Change |
| --- | --- | --- | --- |
| transact_2x2 | 50,082 → 63,916 (+28%) | 1.97s → 1.99s (+1%) | 22.1 → 26.2 MB (+19%) |
| transact_1x1 | 29,266 → 37,672 (+29%) | 1.04s → 1.54s (+48%) | 12.6 → 17.1 MB (+36%) |
| ragequit | 10,496 → 13,440 (+28%) | 0.52s → 0.49s (-6%) | 4.9 → 5.7 MB (+16%) |
| deposit | 1,828 → 2,061 (+13%) | 106ms → 137ms (+29%) | 0.8 → 1.0 MB (+25%) |

The Config D → E constraint growth comes from: M-1 depth bumps (~+8-30% of total constraints depending on N×M), AW-M-01 self-defending `Num2Bits(128)` guards (+128 constraints × `nInputs + mOutputs + 1`), AW-L-01 `IsZero` per output (≈3 constraints × `mOutputs`), INS-1 `Num2Bits(160)` on tokenId/tokenIdOut (≈160 constraints × 2-4 entries), and the circom `2.1.9 → 2.2.3` compiler delta. Capacity grew 16x for the state tree and 16x for the keystore/ASP trees — the headline M-1 outcome.

## Test Environment

| Parameter | Value |
| --- | --- |
| **Hardware** | MacBook Pro M3 Pro, 18GB RAM |
| **Power** | Unplugged (battery power) |
| **Circom Version** | 2.2.3 (Config E); 2.1.9 (Configs A-D, historical) |
| **Proving System** | Groth16 (BN128) |
| **Runtime** | Node.js with snarkjs (WASM) |
| **Samples per Metric** | 5 (with warm-up run) |
| **Benchmark Dates** | May 2026 (Config E); January 2026 (Configs A-D) |

> Note: Results may vary on different hardware. Apple Silicon provides excellent single-thread performance for WASM execution.
> 

## Detailed Results by Configuration

### Config A: Maximum Depth (32/32/32)

### Constraint Analysis

| Circuit | Constraints | Non-Linear | Linear |
| --- | --- | --- | --- |
| deposit | 1,828 | 914 | 914 |
| transact_1x3 | 57,426 | 28,713 | 28,713 |
| transact_1x4 | 59,074 | 29,537 | 29,537 |
| transact_1x5 | 60,734 | 30,367 | 30,367 |
| transact_2x1 | 89,288 | 44,644 | 44,644 |
| transact_2x2 | 90,918 | 45,459 | 45,459 |
| transact_2x3 | 92,560 | 46,280 | 46,280 |
| transact_3x1 | 124,410 | 62,205 | 62,205 |
| transact_3x2 | 126,046 | 63,023 | 63,023 |
| transact_3x3 | 127,694 | 63,847 | 63,847 |
| ragequit | 19,460 | 9,730 | 9,730 |

### Timing Results

Average times from 5 samples (warm-up run excluded):

| Circuit | Witness Gen | Proof Gen | Verification |
| --- | --- | --- | --- |
| deposit | 1.6 ms | 118 ms | 8.7 ms |
| transact_1x3 | 54 ms | 1,943 ms | 8.3 ms |
| transact_1x4 | 64 ms | 1,979 ms | 9.5 ms |
| transact_1x5 | 77 ms | 1,987 ms | 9.1 ms |
| transact_2x1 | 90 ms | 3,357 ms | 11.7 ms |
| transact_2x2 | 90 ms | 3,233 ms | 8.0 ms |
| transact_2x3 | 90 ms | 3,529 ms | 8.7 ms |
| transact_3x1 | 126 ms | 4,013 ms | 8.1 ms |
| transact_3x2 | 118 ms | 5,935 ms | 10.9 ms |
| transact_3x3 | 142 ms | 5,905 ms | 9.6 ms |
| ragequit | 30 ms | 896 ms | 8.2 ms |

### Artifact Sizes

| Circuit | R1CS | WASM | Proving Key | Verification Key |
| --- | --- | --- | --- | --- |
| deposit | 0.3 MB | 2.2 MB | 0.8 MB | 3.5 KB |
| transact_1x3 | 7.7 MB | 3.2 MB | 24.8 MB | 4.9 KB |
| transact_1x4 | 7.9 MB | 3.2 MB | 25.3 MB | 5.1 KB |
| transact_1x5 | 8.1 MB | 3.2 MB | 25.9 MB | 5.3 KB |
| transact_2x1 | 12.0 MB | 3.3 MB | 40.4 MB | 4.7 KB |
| transact_2x2 | 12.2 MB | 3.3 MB | 41.0 MB | 4.9 KB |
| transact_2x3 | 12.4 MB | 3.3 MB | 41.5 MB | 5.1 KB |
| transact_3x1 | 16.7 MB | 3.4 MB | 53.2 MB | 4.9 KB |
| transact_3x2 | 16.9 MB | 3.4 MB | 61.7 MB | 5.1 KB |
| transact_3x3 | 17.1 MB | 3.5 MB | 62.3 MB | 5.3 KB |
| ragequit | 2.6 MB | 3.0 MB | 9.1 MB | 4.3 KB |

### Config B: (32/24/24)

**Benchmarked: January 2026**

Reduced keystore and ASP depths from 32 to 24, maintaining maximum state tree capacity.

### Constraint Analysis

| Circuit | Constraints | Non-Linear | Linear |
| --- | --- | --- | --- |
| deposit | 1,828 | 914 | 914 |
| transact_1x1 | 46,198 | 23,099 | 23,099 |
| transact_1x2 | 47,822 | 23,911 | 23,911 |
| transact_1x3 | 49,458 | 24,729 | 24,729 |
| transact_2x1 | 77,336 | 38,668 | 38,668 |
| transact_2x2 | 78,966 | 39,483 | 39,483 |
| transact_2x3 | 80,608 | 40,304 | 40,304 |
| transact_3x1 | 108,474 | 54,237 | 54,237 |
| transact_3x2 | 110,110 | 55,055 | 55,055 |
| transact_3x3 | 111,758 | 55,879 | 55,879 |
| ragequit | 15,476 | 7,738 | 7,738 |

### Timing Results

Average times from 5 samples (warm-up run excluded):

| Circuit | Witness Gen | Proof Gen | Verification |
| --- | --- | --- | --- |
| deposit | 1.6 ms | 93 ms | 7.8 ms |
| transact_1x1 | 44 ms | 1,522 ms | 8.9 ms |
| transact_1x2 | 45 ms | 1,538 ms | 8.0 ms |
| transact_1x3 | 47 ms | 1,538 ms | 8.0 ms |
| transact_2x1 | 72 ms | 2,607 ms | 7.7 ms |
| transact_2x2 | 73 ms | 2,636 ms | 7.8 ms |
| transact_2x3 | 74 ms | 2,649 ms | 7.8 ms |
| transact_3x1 | 99 ms | 3,062 ms | 8.0 ms |
| transact_3x2 | 102 ms | 3,126 ms | 7.9 ms |
| transact_3x3 | 104 ms | 3,158 ms | 8.6 ms |
| ragequit | 17 ms | 707 ms | 7.8 ms |

### Artifact Sizes

| Circuit | R1CS | WASM | Proving Key | Verification Key |
| --- | --- | --- | --- | --- |
| deposit | 0.3 MB | 2.2 MB | 0.8 MB | 3.5 KB |
| transact_1x1 | 6.2 MB | 3.1 MB | 20.8 MB | 4.5 KB |
| transact_1x2 | 6.4 MB | 3.1 MB | 21.3 MB | 4.7 KB |
| transact_1x3 | 6.6 MB | 3.1 MB | 21.8 MB | 4.9 KB |
| transact_2x1 | 10.4 MB | 3.2 MB | 36.1 MB | 4.7 KB |
| transact_2x2 | 10.6 MB | 3.3 MB | 36.6 MB | 4.9 KB |
| transact_2x3 | 10.8 MB | 3.3 MB | 37.2 MB | 5.1 KB |
| transact_3x1 | 14.6 MB | 3.4 MB | 47.4 MB | 4.9 KB |
| transact_3x2 | 14.8 MB | 3.4 MB | 47.9 MB | 5.1 KB |
| transact_3x3 | 15.0 MB | 3.4 MB | 48.5 MB | 5.3 KB |
| ragequit | 2.1 MB | 3.0 MB | 7.7 MB | 4.3 KB |

---

### Config C: (24/20/20)

**Benchmarked: January 2026**

Balanced reduction across all tree depths for improved performance with moderate capacity.

### Constraint Analysis

| Circuit | Constraints | Non-Linear | Linear |
| --- | --- | --- | --- |
| deposit | 1,828 | 914 | 914 |
| transact_1x1 | 38,230 | 19,115 | 19,115 |
| transact_1x2 | 39,854 | 19,927 | 19,927 |
| transact_1x3 | 41,490 | 20,745 | 20,745 |
| transact_2x1 | 63,392 | 31,696 | 31,696 |
| transact_2x2 | 65,022 | 32,511 | 32,511 |
| transact_2x3 | 66,664 | 33,332 | 33,332 |
| transact_3x1 | 88,554 | 44,277 | 44,277 |
| transact_3x2 | 90,190 | 45,095 | 45,095 |
| transact_3x3 | 91,838 | 45,919 | 45,919 |
| ragequit | 13,484 | 6,742 | 6,742 |

### Timing Results

Average times from 5 samples (warm-up run excluded):

| Circuit | Witness Gen | Proof Gen | Verification |
| --- | --- | --- | --- |
| deposit | 1.6 ms | 94 ms | 8.1 ms |
| transact_1x1 | 37 ms | 1,633 ms | 8.7 ms |
| transact_1x2 | 38 ms | 1,410 ms | 8.0 ms |
| transact_1x3 | 40 ms | 1,428 ms | 8.2 ms |
| transact_2x1 | 60 ms | 2,548 ms | 8.0 ms |
| transact_2x2 | 69 ms | 2,669 ms | 8.6 ms |
| transact_2x3 | 62 ms | 2,718 ms | 8.3 ms |
| transact_3x1 | 84 ms | 2,878 ms | 8.1 ms |
| transact_3x2 | 85 ms | 2,898 ms | 8.1 ms |
| transact_3x3 | 87 ms | 2,953 ms | 9.2 ms |
| ragequit | 15 ms | 503 ms | 8.0 ms |

### Artifact Sizes

| Circuit | R1CS | WASM | Proving Key | Verification Key |
| --- | --- | --- | --- | --- |
| deposit | 0.3 MB | 2.2 MB | 0.8 MB | 3.5 KB |
| transact_1x1 | 5.1 MB | 3.1 MB | 17.9 MB | 4.5 KB |
| transact_1x2 | 5.3 MB | 3.1 MB | 18.4 MB | 4.7 KB |
| transact_1x3 | 5.5 MB | 3.1 MB | 19.0 MB | 4.9 KB |
| transact_2x1 | 8.5 MB | 3.2 MB | 31.0 MB | 4.7 KB |
| transact_2x2 | 8.7 MB | 3.2 MB | 31.5 MB | 4.9 KB |
| transact_2x3 | 8.9 MB | 3.2 MB | 32.1 MB | 5.1 KB |
| transact_3x1 | 11.9 MB | 3.3 MB | 40.1 MB | 4.9 KB |
| transact_3x2 | 12.1 MB | 3.3 MB | 40.7 MB | 5.1 KB |
| transact_3x3 | 12.3 MB | 3.3 MB | 41.2 MB | 5.3 KB |
| ragequit | 1.8 MB | 3.0 MB | 5.9 MB | 4.3 KB |

### Config D: (18/14/14)

**Benchmarked: January 2026**

### Constraint Analysis (Full 5x5 Matrix)

| Circuit | Constraints | Non-Linear | Linear |
| --- | --- | --- | --- |
| deposit | 1,828 | 914 | 914 |
| transact_1x1 | 29,266 | 14,633 | 14,633 |
| transact_1x2 | 30,890 | 15,445 | 15,445 |
| transact_1x3 | 32,526 | 16,263 | 16,263 |
| transact_1x4 | 34,174 | 17,087 | 17,087 |
| transact_1x5 | 35,834 | 17,917 | 17,917 |
| transact_2x1 | 48,452 | 24,226 | 24,226 |
| transact_2x2 | 50,082 | 25,041 | 25,041 |
| transact_2x3 | 51,724 | 25,862 | 25,862 |
| transact_2x4 | 53,378 | 26,689 | 26,689 |
| transact_2x5 | 55,044 | 27,522 | 27,522 |
| transact_3x1 | 67,638 | 33,819 | 33,819 |
| transact_3x2 | 69,274 | 34,637 | 34,637 |
| transact_3x3 | 70,922 | 35,461 | 35,461 |
| transact_3x4 | 72,582 | 36,291 | 36,291 |
| transact_3x5 | 74,254 | 37,127 | 37,127 |
| transact_4x1 | 86,824 | 43,412 | 43,412 |
| transact_4x2 | 88,466 | 44,233 | 44,233 |
| transact_4x3 | 90,120 | 45,060 | 45,060 |
| transact_4x4 | 91,786 | 45,893 | 45,893 |
| transact_4x5 | 93,464 | 46,732 | 46,732 |
| transact_5x1 | 106,010 | 53,005 | 53,005 |
| transact_5x2 | 107,658 | 53,829 | 53,829 |
| transact_5x3 | 109,318 | 54,659 | 54,659 |
| transact_5x4 | 110,990 | 55,495 | 55,495 |
| transact_5x5 | 112,674 | 56,337 | 56,337 |
| ragequit | 10,496 | 5,248 | 5,248 |

### Constraint Matrix (NxM Inputs x Outputs)

| N\M | 1 | 2 | 3 | 4 | 5 |
| --- | --- | --- | --- | --- | --- |
| **1** | 29,266 | 30,890 | 32,526 | 34,174 | 35,834 |
| **2** | 48,452 | 50,082 | 51,724 | 53,378 | 55,044 |
| **3** | 67,638 | 69,274 | 70,922 | 72,582 | 74,254 |
| **4** | 86,824 | 88,466 | 90,120 | 91,786 | 93,464 |
| **5** | 106,010 | 107,658 | 109,318 | 110,990 | 112,674 |

### Timing Results (Full 5x5 Matrix)

Average times from 5 samples (warm-up run excluded):

| Circuit | Witness Gen | Proof Gen | Verification |
| --- | --- | --- | --- |
| deposit | 1.8 ms | 106 ms | 8.0 ms |
| transact_1x1 | 30 ms | 1,041 ms | 9.2 ms |
| transact_1x2 | 31 ms | 1,034 ms | 8.0 ms |
| transact_1x3 | 32 ms | 1,456 ms | 8.7 ms |
| transact_1x4 | 34 ms | 1,394 ms | 8.3 ms |
| transact_1x5 | 35 ms | 1,334 ms | 8.1 ms |
| transact_2x1 | 47 ms | 1,740 ms | 22.0 ms |
| transact_2x2 | 56 ms | 1,967 ms | 9.3 ms |
| transact_2x3 | 57 ms | 1,864 ms | 8.5 ms |
| transact_2x4 | 55 ms | 1,911 ms | 10.1 ms |
| transact_2x5 | 61 ms | 1,895 ms | 9.4 ms |
| transact_3x1 | 64 ms | 2,757 ms | 7.9 ms |
| transact_3x2 | 66 ms | 2,683 ms | 7.9 ms |
| transact_3x3 | 79 ms | 2,996 ms | 10.5 ms |
| transact_3x4 | 69 ms | 2,885 ms | 8.7 ms |
| transact_3x5 | 71 ms | 2,714 ms | 8.7 ms |
| transact_4x1 | 83 ms | 3,089 ms | 9.1 ms |
| transact_4x2 | 101 ms | 3,176 ms | 8.1 ms |
| transact_4x3 | 89 ms | 3,130 ms | 8.9 ms |
| transact_4x4 | 87 ms | 3,037 ms | 8.2 ms |
| transact_4x5 | 94 ms | 3,050 ms | 8.7 ms |
| transact_5x1 | 110 ms | 3,421 ms | 7.9 ms |
| transact_5x2 | 114 ms | 3,666 ms | 8.4 ms |
| transact_5x3 | 104 ms | 3,397 ms | 8.2 ms |
| transact_5x4 | 106 ms | 3,685 ms | 8.1 ms |
| transact_5x5 | 115 ms | 3,547 ms | 7.7 ms |
| ragequit | 13 ms | 524 ms | 9.6 ms |

### Proof Time Matrix (NxM Inputs x Outputs) in seconds

| N\M | 1 | 2 | 3 | 4 | 5 |
| --- | --- | --- | --- | --- | --- |
| **1** | 1.04s | 1.03s | 1.46s | 1.39s | 1.33s |
| **2** | 1.74s | 1.97s | 1.86s | 1.91s | 1.90s |
| **3** | 2.76s | 2.68s | 3.00s | 2.89s | 2.71s |
| **4** | 3.09s | 3.18s | 3.13s | 3.04s | 3.05s |
| **5** | 3.42s | 3.67s | 3.40s | 3.69s | 3.55s |

### Artifact Sizes (Full 5x5 Matrix)

| Circuit | R1CS | WASM | Proving Key | Verification Key |
| --- | --- | --- | --- | --- |
| deposit | 258 KB | 2.2 MB | 0.8 MB | 3.5 KB |
| transact_1x1 | 3.9 MB | 3.1 MB | 12.6 MB | 4.4 KB |
| transact_1x2 | 4.1 MB | 3.1 MB | 13.1 MB | 4.6 KB |
| transact_1x3 | 4.3 MB | 3.1 MB | 15.7 MB | 4.8 KB |
| transact_1x4 | 4.5 MB | 3.1 MB | 16.2 MB | 5.0 KB |
| transact_1x5 | 4.8 MB | 3.1 MB | 16.8 MB | 5.2 KB |
| transact_2x1 | 6.5 MB | 3.1 MB | 21.6 MB | 4.6 KB |
| transact_2x2 | 6.7 MB | 3.1 MB | 22.1 MB | 4.8 KB |
| transact_2x3 | 6.9 MB | 3.2 MB | 22.7 MB | 5.0 KB |
| transact_2x4 | 7.1 MB | 3.2 MB | 23.2 MB | 5.2 KB |
| transact_2x5 | 7.3 MB | 3.2 MB | 23.8 MB | 5.4 KB |
| transact_3x1 | 9.1 MB | 3.2 MB | 32.5 MB | 4.8 KB |
| transact_3x2 | 9.3 MB | 3.2 MB | 33.1 MB | 5.0 KB |
| transact_3x3 | 9.5 MB | 3.2 MB | 33.6 MB | 5.2 KB |
| transact_3x4 | 9.7 MB | 3.2 MB | 34.2 MB | 5.4 KB |
| transact_3x5 | 9.9 MB | 3.2 MB | 34.7 MB | 5.6 KB |
| transact_4x1 | 11.6 MB | 3.3 MB | 39.5 MB | 5.0 KB |
| transact_4x2 | 11.9 MB | 3.3 MB | 40.1 MB | 5.2 KB |
| transact_4x3 | 12.1 MB | 3.3 MB | 40.6 MB | 5.4 KB |
| transact_4x4 | 12.3 MB | 3.3 MB | 41.2 MB | 5.6 KB |
| transact_4x5 | 12.5 MB | 3.3 MB | 41.7 MB | 5.8 KB |
| transact_5x1 | 14.2 MB | 3.4 MB | 46.5 MB | 5.2 KB |
| transact_5x2 | 14.4 MB | 3.4 MB | 47.0 MB | 5.4 KB |
| transact_5x3 | 14.6 MB | 3.4 MB | 47.6 MB | 5.6 KB |
| transact_5x4 | 14.9 MB | 3.4 MB | 48.1 MB | 5.8 KB |
| transact_5x5 | 15.1 MB | 3.4 MB | 48.7 MB | 6.0 KB |
| ragequit | 1.4 MB | 2.9 MB | 4.9 MB | 4.2 KB |

### Proving Key Size Matrix (NxM Inputs x Outputs) in MB

| N\M | 1 | 2 | 3 | 4 | 5 |
| --- | --- | --- | --- | --- | --- |
| **1** | 12.6 | 13.1 | 15.7 | 16.2 | 16.8 |
| **2** | 21.6 | 22.1 | 22.7 | 23.2 | 23.8 |
| **3** | 32.5 | 33.1 | 33.6 | 34.2 | 34.7 |
| **4** | 39.5 | 40.1 | 40.6 | 41.2 | 41.7 |
| **5** | 46.5 | 47.0 | 47.6 | 48.1 | 48.7 |

### Config E: Current Production (22/18/18)

**Benchmarked: May 2026.** First benchmark run after the M-0 / M-1 / AW-M-01 / AW-L-01 / INS-1 audit fixes and the circom `2.1.9 → 2.2.3` bump. Same hardware as Configs A-D (MacBook Pro M3 Pro, 18 GB RAM, unplugged). The zkey, vkey and verifier.sol sizes below were re-measured on 2026-10-20 from the committed phase-2 ceremony keys (see [`packages/circuits/CEREMONY.md`](../../../packages/circuits/CEREMONY.md)); the circuits, r1cs and wasm are unchanged.

### Constraint Analysis (Full 5x5 Matrix)

| Circuit | Constraints | Non-Linear | Linear |
| --- | --- | --- | --- |
| deposit | 2,061 | 1,075 | 986 |
| transact_1x1 | 37,672 | 18,365 | 19,307 |
| transact_1x2 | 39,334 | 19,306 | 20,028 |
| transact_1x3 | 41,004 | 20,253 | 20,751 |
| transact_1x4 | 42,682 | 21,206 | 21,476 |
| transact_1x5 | 44,368 | 22,165 | 22,203 |
| transact_2x1 | 62,249 | 30,125 | 32,124 |
| transact_2x2 | 63,916 | 31,069 | 32,847 |
| transact_2x3 | 65,591 | 32,019 | 33,572 |
| transact_2x4 | 67,274 | 32,975 | 34,299 |
| transact_2x5 | 68,965 | 33,937 | 35,028 |
| transact_3x1 | 86,825 | 41,885 | 44,940 |
| transact_3x2 | 88,496 | 42,832 | 45,664 |
| transact_3x3 | 90,175 | 43,785 | 46,390 |
| transact_3x4 | 91,862 | 44,744 | 47,118 |
| transact_3x5 | 93,557 | 45,709 | 47,848 |
| transact_4x1 | 111,401 | 53,645 | 57,756 |
| transact_4x2 | 113,076 | 54,595 | 58,481 |
| transact_4x3 | 114,759 | 55,551 | 59,208 |
| transact_4x4 | 116,450 | 56,513 | 59,937 |
| transact_4x5 | 118,149 | 57,481 | 60,668 |
| transact_5x1 | 135,977 | 65,405 | 70,572 |
| transact_5x2 | 137,656 | 66,358 | 71,298 |
| transact_5x3 | 139,343 | 67,317 | 72,026 |
| transact_5x4 | 141,038 | 68,282 | 72,756 |
| transact_5x5 | 142,741 | 69,253 | 73,488 |
| ragequit | 13,440 | 6,410 | 7,030 |

### Constraint Matrix (NxM Inputs x Outputs)

|     | M=1 | M=2 | M=3 | M=4 | M=5 |
| --- | --- | --- | --- | --- | --- |
| **N=1** | 37,672 | 39,334 | 41,004 | 42,682 | 44,368 |
| **N=2** | 62,249 | 63,916 | 65,591 | 67,274 | 68,965 |
| **N=3** | 86,825 | 88,496 | 90,175 | 91,862 | 93,557 |
| **N=4** | 111,401 | 113,076 | 114,759 | 116,450 | 118,149 |
| **N=5** | 135,977 | 137,656 | 139,343 | 141,038 | 142,741 |

### Timing Results (Full 5x5 Matrix)

Per-circuit averages over 5 samples. All times in milliseconds.

| Circuit | Witness Gen (ms) | Proof Gen (ms) | Verify (ms) |
| --- | --- | --- | --- |
| deposit | 2.36 | 136.53 | 10.21 |
| transact_1x1 | 44.96 | 1539.06 | 11.88 |
| transact_1x2 | 41.93 | 1356.65 | 8.11 |
| transact_1x3 | 39.70 | 1341.56 | 8.78 |
| transact_1x4 | 44.53 | 1361.58 | 8.24 |
| transact_1x5 | 43.78 | 1372.59 | 8.14 |
| transact_2x1 | 58.86 | 1693.15 | 8.25 |
| transact_2x2 | 102.02 | 1994.22 | 8.59 |
| transact_2x3 | 69.41 | 2719.23 | 4.00 |
| transact_2x4 | 68.23 | 2583.26 | 3.30 |
| transact_2x5 | 87.39 | 2915.54 | 6.11 |
| transact_3x1 | 110.04 | 3130.67 | 3.04 |
| transact_3x2 | 89.93 | 3592.39 | 5.55 |
| transact_3x3 | 95.01 | 3104.01 | 3.20 |
| transact_3x4 | 90.44 | 3135.55 | 3.33 |
| transact_3x5 | 101.21 | 3449.21 | 3.19 |
| transact_4x1 | 119.23 | 3879.58 | 4.18 |
| transact_4x2 | 110.19 | 4714.25 | 4.03 |
| transact_4x3 | 117.91 | 3812.74 | 3.49 |
| transact_4x4 | 110.74 | 3669.05 | 3.46 |
| transact_4x5 | 121.84 | 3701.92 | 3.23 |
| transact_5x1 | 135.39 | 5615.98 | 8.29 |
| transact_5x2 | 142.15 | 5139.82 | 7.74 |
| transact_5x3 | 138.31 | 4866.09 | 7.97 |
| transact_5x4 | 146.68 | 5208.20 | 7.87 |
| transact_5x5 | 143.71 | 5156.23 | 6.69 |
| ragequit | 13.46 | 490.94 | 7.69 |

### Proof Time Matrix (NxM Inputs x Outputs) in seconds

|     | M=1 | M=2 | M=3 | M=4 | M=5 |
| --- | --- | --- | --- | --- | --- |
| **N=1** | 1.54 | 1.36 | 1.34 | 1.36 | 1.37 |
| **N=2** | 1.69 | 1.99 | 2.72 | 2.58 | 2.92 |
| **N=3** | 3.13 | 3.59 | 3.10 | 3.14 | 3.45 |
| **N=4** | 3.88 | 4.71 | 3.81 | 3.67 | 3.70 |
| **N=5** | 5.62 | 5.14 | 4.87 | 5.21 | 5.16 |

### Artifact Sizes (Full 5x5 Matrix)

| Circuit | r1cs (KB) | wasm (KB) | zkey (MB) | vkey (B) | verifier.sol (B) |
| --- | --- | --- | --- | --- | --- |
| deposit | 283 | 2,282 | 1.18 | 3,741 | 8,225 |
| transact_1x1 | 4,964 | 3,163 | 17.30 | 4,528 | 9,784 |
| transact_1x2 | 5,198 | 3,171 | 17.91 | 4,720 | 10,169 |
| transact_1x3 | 5,433 | 3,178 | 18.51 | 4,920 | 10,566 |
| transact_1x4 | 5,669 | 3,184 | 19.12 | 5,116 | 10,959 |
| transact_1x5 | 5,906 | 3,191 | 19.73 | 5,318 | 11,358 |
| transact_2x1 | 8,188 | 3,261 | 25.82 | 4,724 | 10,173 |
| transact_2x2 | 8,423 | 3,269 | 26.42 | 4,921 | 10,567 |
| transact_2x3 | 8,658 | 3,276 | 31.03 | 5,116 | 10,959 |
| transact_2x4 | 8,896 | 3,283 | 31.64 | 5,313 | 11,353 |
| transact_2x5 | 9,134 | 3,290 | 32.25 | 5,509 | 11,746 |
| transact_3x1 | 11,425 | 3,359 | 38.33 | 4,922 | 10,568 |
| transact_3x2 | 11,661 | 3,367 | 38.94 | 5,116 | 10,959 |
| transact_3x3 | 11,899 | 3,374 | 39.55 | 5,314 | 11,354 |
| transact_3x4 | 12,139 | 3,381 | 40.16 | 5,500 | 11,737 |
| transact_3x5 | 12,378 | 3,387 | 40.77 | 5,704 | 12,138 |
| transact_4x1 | 14,636 | 3,454 | 46.85 | 5,116 | 10,959 |
| transact_4x2 | 14,872 | 3,462 | 47.46 | 5,310 | 11,350 |
| transact_4x3 | 15,108 | 3,468 | 48.07 | 5,507 | 11,744 |
| transact_4x4 | 15,346 | 3,475 | 48.68 | 5,706 | 12,140 |
| transact_4x5 | 15,585 | 3,481 | 49.29 | 5,899 | 12,530 |
| transact_5x1 | 17,860 | 3,550 | 63.36 | 5,311 | 11,351 |
| transact_5x2 | 18,096 | 3,558 | 63.97 | 5,509 | 11,746 |
| transact_5x3 | 18,333 | 3,564 | 64.58 | 5,706 | 12,140 |
| transact_5x4 | 18,571 | 3,571 | 65.20 | 5,896 | 12,527 |
| transact_5x5 | 18,811 | 3,578 | 65.81 | 6,095 | 12,923 |
| ragequit | 1,766 | 3,013 | 5.85 | 4,335 | 9,398 |

### Proving Key Size Matrix (NxM Inputs x Outputs) in MB

|     | M=1 | M=2 | M=3 | M=4 | M=5 |
| --- | --- | --- | --- | --- | --- |
| **N=1** | 17.3 | 17.9 | 18.5 | 19.1 | 19.7 |
| **N=2** | 25.8 | 26.4 | 31.0 | 31.6 | 32.3 |
| **N=3** | 38.3 | 38.9 | 39.5 | 40.2 | 40.8 |
| **N=4** | 46.8 | 47.5 | 48.1 | 48.7 | 49.3 |
| **N=5** | 63.4 | 64.0 | 64.6 | 65.2 | 65.8 |

## Scaling Analysis

### Transact Scaling Formulas

The transact circuit constraint count follows a predictable linear pattern based on inputs (N) and outputs (M).

### Config D: Production (18/14/14)

```
constraints(N, M) ≈ 29,266 + (N-1) × 19,186 + (M-1) × 1,642
```

Where:

- **Base (1x1):** 29,266 constraints
- **Per additional input:** +19,186 constraints (exact)
- **Per additional output:** +1,624 to +1,660 constraints (avg ~1,642)

### Config A: Maximum Depth (32/32/32)

```
constraints(N, M) ≈ 53,638 + (N-1) × 34,636 + (M-1) × 1,636
```

Where:

- **Base (1x1):** 53,638 constraints
- **Per additional input:** +34,636 constraints (exact)
- **Per additional output:** +1,624 to +1,648 constraints (avg ~1,636)

> Key Insight: Input scaling dominates, each additional input adds ~19K constraints (Config D) vs ~1.6K per output. This is because each input requires a full Merkle proof verification.
> 

### Component Constraint Breakdown

Measured constraint counts for individual helper components:

| Component | Non-Linear | Linear | Total | Notes |
| --- | --- | --- | --- | --- |
| **BinaryMerkleRoot(32)** | 7,971 | 8,802 | 16,773 | 32-level Merkle proof |
| **NoteCommitment** | 543 | 710 | 1,253 | 2x Poseidon hashes + precommitment |
| **KeystoreLeaf** | 480 | 540 | 1,020 | Poseidon hash + nullifying key |
| **Poseidon(4)** | 300 | 436 | 736 | 4-input hash |
| **Poseidon(2)** | 243 | 274 | 517 | 2-input hash |
| **ValueConservation(2,2)** | 282 | 19 | 301 | 2 inputs, 2 outputs |
| **Num2Bits(128)** | 128 | 1 | 129 | Bit decomposition |

The Merkle proof is the most expensive component, accounting for ~30% of a transact_1x1 circuit.

### Expected Constraint Reduction by Config

Merkle proof constraints scale roughly linearly with depth. Observed reduction:

| Config | Merkle Depth Reduction | Observed Constraint Reduction |
| --- | --- | --- |
| A → B | 32→24 (keystore), 32→24 (ASP) | **-13% (measured)** |
| A → C | 32→24 (state), 32→20 (keystore), 32→20 (ASP) | **-28% (measured)** |
| A → D | 32→18 (state), 32→14 (keystore), 32→14 (ASP) | **-45% (measured)** |

### Constraint Distribution (Config D)

Relative constraint counts:

```
deposit       █░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  1.8K   (2%)
ragequit      ████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  10K    (9%)
transact_1x1  ██████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  29K   (26%)
transact_2x2  ██████████████████░░░░░░░░░░░░░░░░░░░░░░░  50K   (44%)
transact_3x3  █████████████████████████░░░░░░░░░░░░░░░░  71K   (63%)
transact_5x5  ████████████████████████████████████████░  113K (100%)

```

### Proof Generation Time (Config D)

Bars scaled proportionally:

```
deposit       █░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  0.1s  (3%)
ragequit      ███████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  0.5s (14%)
transact_1x1  ██████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  1.0s (28%)
transact_2x2  ██████████████████████████░░░░░░░░░░░░░░░░░░░░░░░░  2.0s (53%)
transact_3x3  ████████████████████████████████████████░░░░░░░░░░  3.0s (81%)
transact_5x5  ██████████████████████████████████████████████████  3.7s (100%)

```

---

## On-Chain Footprint

Proof size and public signals determine on-chain verification cost.

### Proof Size

Groth16 proofs have a constant base size plus public signals:

```
Proof Size = 128 bytes (base) + 32 bytes × (public signals)
```

| Circuit | Public Signals | Proof Size |
| --- | --- | --- |
| deposit | 3 | 128 + 96 = **224 bytes** |
| transact_1x1 | 8 | 128 + 256 = **384 bytes** |
| transact_2x2 | 10 | 128 + 320 = **448 bytes** |
| transact_3x3 | 12 | 128 + 384 = **512 bytes** |
| transact_4x4 | 14 | 128 + 448 = **576 bytes** |
| transact_5x5 | 16 | 128 + 512 = **640 bytes** |
| ragequit | 7 | 128 + 224 = **352 bytes** |

Public signals scale as: `6 + N + M` for transact_NxM.

> Note: Base 128 bytes = 2 G1 points + 1 G2 point. Actual on-chain calldata costs depend on encoding and EIP-4844 blob usage.
> 

### Public Signal Definitions

**Deposit (3 signals)**

- Inputs: `tokenId`, `value`
- Outputs: `outputCommitment`

**Transact (6 + N + M signals)**

- Inputs: `stateRoot`, `keystoreRoot`, `associationSetRoot`, `amountOut`, `tokenIdOut`, `context`
- Outputs: `nullifierHashes[N]`, `outputCommitments[M]`

**Ragequit (7 signals)**

- Inputs: `keystoreRoot`, `ownerAddress`, `value`, `tokenId`, `label`
- Outputs: `nullifierHash`, `commitment`

### Transact Public Signal Counts

| Variant | Public Inputs | Public Outputs | Total |
| --- | --- | --- | --- |
| transact_1x1 | 6 | 1 + 1 = 2 | 8 |
| transact_2x2 | 6 | 2 + 2 = 4 | 10 |
| transact_3x3 | 6 | 3 + 3 = 6 | 12 |
| transact_4x4 | 6 | 4 + 4 = 8 | 14 |
| transact_5x5 | 6 | 5 + 5 = 10 | 16 |