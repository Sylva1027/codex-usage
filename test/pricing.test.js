import assert from "node:assert/strict";
import test from "node:test";

import { estimateCostForEvents, estimateCostForGroups, estimateEventCost, getPricingCatalog, setPricingCatalog, resetPricingCatalog, LONG_CONTEXT_INPUT_THRESHOLD } from "../src/pricing.js";

test("API cost estimate prices uncached input, cached input, and output separately", () => {
  const estimate = estimateCostForEvents([
    {
      model: "gpt-6-sol",
      detailMask: 15,
      cacheWriteTokens: 0,
      cacheWriteKnown: true,
      contextLevel: "short",
      serviceTier: "standard",
      total: { total: 110, input: 100, cached: 20, output: 10, reasoning: 4 },
    },
  ]);

  assert.equal(estimate.inputUsd, 0.00016);
  assert.equal(estimate.cachedInputUsd, 0.000004);
  assert.equal(estimate.outputUsd, 0.0001);
  assert.equal(estimate.totalUsd, 0.000264);
  assert.equal(estimate.cacheHitRate, 0.2);
  assert.equal(estimate.modelCount, 1);
  assert.equal(estimate.pricedTokens, 110);
  assert.equal(estimate.unpricedTokens, 0);
});

test("unknown prices and incomplete details use minimum catalog rates", () => {
  const estimate = estimateCostForEvents([
    {
      model: "gpt-6-sol",
      detailMask: 3,
      total: { total: 30, input: 25, cached: 5, output: 0 },
    },
    {
      model: "custom-review-model",
      detailMask: 15,
      total: { total: 50, input: 40, cached: 10, output: 10 },
    },
    {
      model: "Unknown model",
      detailMask: 15,
      total: { total: 20, input: 15, cached: 5, output: 5 },
    },
  ]);

  assert.ok(Math.abs(estimate.totalUsd - 0.00010265) < 1e-12);
  assert.equal(estimate.cacheHitRate, 20 / 80);
  assert.equal(estimate.modelCount, 2);
  assert.equal(estimate.pricedTokens, 100);
  assert.equal(estimate.unpricedTokens, 0);
  assert.equal(estimate.minimumEstimatedTokens, 95);
  assert.deepEqual(estimate.unpricedModels, []);
  assert.deepEqual(estimate.minimumRateModels, ["custom-review-model", "Unknown model"]);
});
test("grouped store rows produce the same aggregate as individual events", () => {
  const event = {
    model: "gpt-6-luna",
    detailMask: 15,
    total: { total: 120, input: 100, cached: 60, output: 20 },
  };
  const expected = estimateCostForEvents([event]);
  const actual = estimateCostForGroups([
    { model: event.model, detailMask: event.detailMask, ...event.total },
  ]);

  assert.deepEqual(actual, expected);
});

test("long-context rates apply to the full request only when input exceeds 272K", () => {
  const base = {
    model: "gpt-6-sol",
    detailMask: 7,
    cacheWriteTokens: 0,
    cacheWriteKnown: true,
    serviceTier: "standard",
  };
  assert.equal(LONG_CONTEXT_INPUT_THRESHOLD, 272_000);
  const exact = estimateEventCost({
    ...base,
    contextLevel: "short",
    total: { total: 272_000, input: 272_000, cached: 0, output: 0 },
  });
  const over = estimateEventCost({
    ...base,
    contextLevel: "long",
    total: { total: 272_101, input: 272_001, cached: 0, output: 100 },
  });
  assert.equal(exact.inputUsd, 0.544);
  assert.equal(over.inputUsd, 1.088004);
  assert.equal(over.outputUsd, 0.0015);
});

test("Fast and legacy priority service tiers double the Standard estimate", () => {
  const event = {
    model: "gpt-6-sol",
    detailMask: 7,
    cacheWriteTokens: 0,
    cacheWriteKnown: true,
    contextLevel: "short",
    total: { total: 110, input: 100, cached: 20, output: 10 },
  };
  const standard = estimateEventCost({ ...event, serviceTier: "standard" });
  const fast = estimateEventCost({ ...event, serviceTier: "fast" });
  const priority = estimateEventCost({ ...event, serviceTier: "priority" });
  const unknown = estimateEventCost(event);
  assert.equal(fast.totalUsd, standard.totalUsd * 2);
  assert.equal(priority.totalUsd, fast.totalUsd);
  assert.equal(unknown.totalUsd, standard.totalUsd);
  assert.equal(unknown.serviceTierUnknownTokens, 110);
  assert.ok(unknown.unpricedReasons.includes("service-tier-unknown-standard-scenario"));
});

test("missing cache-write detail prices known cache and uses lowest eligible input rate", () => {
  const estimate = estimateEventCost({
    model: "gpt-6-sol",
    detailMask: 7,
    contextLevel: "short",
    serviceTier: "standard",
    total: { total: 110, input: 100, cached: 20, output: 10 },
  });
  assert.equal(estimate.inputUsd, 0.00016);
  assert.equal(estimate.cachedInputUsd, 0.000004);
  assert.equal(estimate.cacheWriteInputUsd, 0);
  assert.equal(estimate.outputUsd, 0.0001);
  assert.equal(estimate.totalUsd, 0.000264);
  assert.equal(estimate.pricedTokens, 110);
  assert.equal(estimate.unpricedTokens, 0);
  assert.equal(estimate.minimumEstimatedTokens, 80);
  assert.equal(estimate.cacheWriteUnknownTokens, 80);
});
test("missing cache-write detail selects the cheaper eligible custom rate", () => {
  const catalog = getPricingCatalog();
  catalog.models["gpt-6-sol"].short.input = 3;
  catalog.models["gpt-6-sol"].short.cachedInput = 0.3;
  catalog.models["gpt-6-sol"].short.cacheWrite = 1;
  try {
    setPricingCatalog({ checkedAt: catalog.checkedAt, models: catalog.models });
    const estimate = estimateEventCost({
      model: "gpt-6-sol",
      detailMask: 7,
      contextLevel: "short",
      serviceTier: "standard",
      total: { total: 110, input: 100, cached: 20, output: 10 },
    });
    assert.ok(Math.abs(estimate.totalUsd - 0.000186) < 1e-12);
    assert.equal(estimate.cacheWriteInputUsd, 0.00008);
    assert.equal(estimate.minimumEstimatedTokens, 80);
    assert.equal(estimate.cacheWriteUnknownTokens, 80);
  } finally {
    resetPricingCatalog();
  }
});
test("known total and output infer input while preserving known cached tokens", () => {
  const estimate = estimateEventCost({
    model: "gpt-6-sol",
    detailMask: 6,
    contextLevel: "short",
    serviceTier: "standard",
    total: { total: 110, cached: 20, output: 10 },
  });
  assert.equal(estimate.totalUsd, 0.000264);
  assert.equal(estimate.cachedInputUsd, 0.000004);
  assert.equal(estimate.minimumEstimatedTokens, 80);
  assert.equal(estimate.cacheWriteUnknownTokens, 80);
  assert.equal(estimate.pricedTokens, 110);
});