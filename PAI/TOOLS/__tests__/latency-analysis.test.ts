import { describe, expect, test } from "bun:test";

import {
  analyze,
  computeCV,
  computeMean,
  computePerModelStats,
  computeStddev,
  confidenceScore,
  detectTierMismatch,
  filterArtifacts,
  generateProposal,
  parseJsonlLines,
  tierFromMean,
  type LatencyEntry,
  type ModelStats,
  type RoutingConfig,
} from "../analyze-latency";

// ─── Statistics primitives ─────────────────────────────────────────────────────

describe("computeMean", () => {
  test("empty array returns 0", () => {
    expect(computeMean([])).toBe(0);
  });
  test("basic arithmetic mean", () => {
    expect(computeMean([10, 20, 30])).toBe(20);
  });
  test("single value returns the value", () => {
    expect(computeMean([42])).toBe(42);
  });
});

describe("computeStddev", () => {
  test("fewer than 2 values returns 0", () => {
    expect(computeStddev([])).toBe(0);
    expect(computeStddev([5])).toBe(0);
  });
  test("computes sample stddev (N-1)", () => {
    // values [2,4,4,4,5,5,7,9] -> mean 5, sample stddev ≈ 2.138
    const sd = computeStddev([2, 4, 4, 4, 5, 5, 7, 9]);
    expect(sd).toBeGreaterThan(2.1);
    expect(sd).toBeLessThan(2.2);
  });
});

describe("computeCV", () => {
  test("CV is stddev / mean", () => {
    const cv = computeCV([100, 100, 100, 100]);
    expect(cv).toBe(0); // zero variance
  });
  test("CV scales with dispersion", () => {
    const tight = computeCV([100, 102, 98, 101]);
    const loose = computeCV([10, 200, 50, 150]);
    expect(loose).toBeGreaterThan(tight);
  });
});

// ─── Tier classification ───────────────────────────────────────────────────────

describe("tierFromMean", () => {
  test("fast for <150ms", () => {
    expect(tierFromMean(50)).toBe("fast");
    expect(tierFromMean(149)).toBe("fast");
  });
  test("standard for 150-4999ms", () => {
    expect(tierFromMean(150)).toBe("standard");
    expect(tierFromMean(2500)).toBe("standard");
    expect(tierFromMean(4999)).toBe("standard");
  });
  test("smart for >=5000ms", () => {
    expect(tierFromMean(5000)).toBe("smart");
    expect(tierFromMean(8500)).toBe("smart");
  });
});

describe("detectTierMismatch", () => {
  test("fast-tier model with mean 500ms is mismatched (proposed standard)", () => {
    const r = detectTierMismatch("fast", 500);
    expect(r.mismatched).toBe(true);
    expect(r.proposedTier).toBe("standard");
  });
  test("standard-tier model with mean 80ms is mismatched (proposed fast)", () => {
    const r = detectTierMismatch("standard", 80);
    expect(r.mismatched).toBe(true);
    expect(r.proposedTier).toBe("fast");
  });
  test("standard-tier model with mean 2500ms is correct", () => {
    const r = detectTierMismatch("standard", 2500);
    expect(r.mismatched).toBe(false);
    expect(r.proposedTier).toBe("standard");
  });
  test("smart-tier model with mean 7000ms is correct", () => {
    const r = detectTierMismatch("smart", 7000);
    expect(r.mismatched).toBe(false);
  });
});

// ─── Confidence scoring ────────────────────────────────────────────────────────

describe("confidenceScore", () => {
  test("high: count>=10 AND CV<1.0", () => {
    expect(confidenceScore(15, 0.4)).toBe("high");
    expect(confidenceScore(10, 0.99)).toBe("high");
  });
  test("medium: 3<=count<=9 AND CV<2.0", () => {
    expect(confidenceScore(5, 0.5)).toBe("medium");
    expect(confidenceScore(9, 1.9)).toBe("medium");
  });
  test("low: count<3 OR CV>=2.0", () => {
    expect(confidenceScore(2, 0.1)).toBe("low");
    expect(confidenceScore(20, 2.5)).toBe("low");
    expect(confidenceScore(5, 2.5)).toBe("low");
  });
});

// ─── Filtering ─────────────────────────────────────────────────────────────────

describe("filterArtifacts", () => {
  test("removes entries whose model_selected isn't in config", () => {
    const entries: LatencyEntry[] = [
      mkEntry("qwen2.5-coder:7b-instruct-q4_K_M", 100, "success"),
      mkEntry("haiku", 500, "success"),
      mkEntry("sonnet", 8000, "error"),
      mkEntry("__latency_test_xyz", 5, "success"),
      mkEntry("gemma4:e4b", 320, "success"),
    ];
    const routing = new Set<string>([
      "qwen2.5-coder:7b-instruct-q4_K_M",
      "gemma4:e4b",
    ]);
    const { kept, filtered } = filterArtifacts(entries, routing);
    expect(kept.length).toBe(2);
    expect(filtered).toBe(3);
  });
});

// ─── JSONL parsing (graceful malformed handling) ───────────────────────────────

describe("parseJsonlLines", () => {
  test("parses good lines and skips malformed ones", () => {
    const content = [
      JSON.stringify({
        timestamp: "2026-05-09T00:00:00Z",
        model_selected: "qwen2.5-coder:7b",
        tier_used: "fast",
        backend: "ollama",
        latency_ms: 100,
        status: "success",
      }),
      "this is not json",
      JSON.stringify({ wrong: "shape" }), // missing required fields
      JSON.stringify({
        timestamp: "2026-05-09T00:00:01Z",
        model_selected: "gemma4:e4b",
        tier_used: "standard",
        backend: "ollama",
        latency_ms: 320,
        status: "success",
      }),
      "", // blank lines should be ignored, not counted as malformed
    ].join("\n");
    const { entries, malformed } = parseJsonlLines(content);
    expect(entries.length).toBe(2);
    expect(malformed).toBe(2);
  });
});

// ─── Per-model stats + proposal generation ────────────────────────────────────

describe("computePerModelStats + generateProposal", () => {
  test("excludes error entries from stats", () => {
    const entries: LatencyEntry[] = [
      mkEntry("m1", 100, "success"),
      mkEntry("m1", 110, "success"),
      mkEntry("m1", 30000, "error"),
    ];
    const stats = computePerModelStats(entries);
    expect(stats.length).toBe(1);
    expect(stats[0].count).toBe(2);
    expect(stats[0].mean).toBe(105);
  });

  test("generateProposal assigns correct tier from mean and confidence", () => {
    // Fast-tier model with observed standard-tier mean.
    const stat: ModelStats = {
      model: "qwen2.5-coder:7b-instruct-q4_K_M",
      count: 12,
      mean: 800,
      stddev: 200,
      min: 600,
      max: 1100,
      cv: 0.25,
    };
    const proposal = generateProposal(stat, "fast");
    expect(proposal.proposedTier).toBe("standard");
    expect(proposal.confidence).toBe("high");
    expect(proposal.changed).toBe(true);
  });

  test("generateProposal does not flag changed when confidence is low", () => {
    const stat: ModelStats = {
      model: "rare-model",
      count: 1,
      mean: 8000,
      stddev: 0,
      min: 8000,
      max: 8000,
      cv: 0,
    };
    const proposal = generateProposal(stat, "fast");
    expect(proposal.confidence).toBe("low");
    expect(proposal.changed).toBe(false);
  });
});

// ─── End-to-end analyze() ──────────────────────────────────────────────────────

describe("analyze", () => {
  test("filters artifacts and produces proposals only for known models", () => {
    const config: RoutingConfig = {
      version: 1,
      models: {
        "qwen2.5-coder:7b": { tier: "fast" },
        "gemma4:e4b": { tier: "standard" },
      },
    };
    const lines = [
      ...Array.from({ length: 12 }, (_, i) =>
        JSON.stringify({
          timestamp: `2026-05-09T00:00:${String(i).padStart(2, "0")}Z`,
          model_selected: "qwen2.5-coder:7b",
          tier_used: "fast",
          backend: "ollama",
          latency_ms: 600 + i * 5,
          status: "success",
        }),
      ),
      JSON.stringify({
        timestamp: "2026-05-09T01:00:00Z",
        model_selected: "haiku",
        tier_used: "standard",
        backend: "claude",
        latency_ms: 8000,
        status: "success",
      }),
    ].join("\n");
    const result = analyze(lines, config);
    expect(result.totalEntries).toBe(13);
    expect(result.artifactEntries).toBe(1);
    expect(result.validEntries).toBe(12);
    const p = result.proposals.find((q) => q.model === "qwen2.5-coder:7b");
    expect(p).toBeDefined();
    expect(p!.currentTier).toBe("fast");
    expect(p!.proposedTier).toBe("standard");
    expect(p!.changed).toBe(true);
  });
});

// ─── helpers ───────────────────────────────────────────────────────────────────

function mkEntry(
  model: string,
  latency_ms: number,
  status: string,
): LatencyEntry {
  return {
    timestamp: "2026-05-09T00:00:00Z",
    model_selected: model,
    tier_used: "standard",
    backend: "ollama",
    latency_ms,
    status,
  };
}
