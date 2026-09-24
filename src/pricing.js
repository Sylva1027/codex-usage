import { createHash } from "node:crypto";

export const API_PRICING_CHECKED_AT = "2026-09-23";
export const API_PRICING_VERSION = "2026-09-23";
export const API_PRICING_MODE = "minimum-fallback-scenario";
export const API_PRICING_SOURCE = "https://developers.openai.com/api/docs/pricing";
export const LONG_CONTEXT_INPUT_THRESHOLD = 272_000;

const USD_PER_MILLION_TOKENS = 1_000_000;
const DETAIL_INPUT = 1;
const DETAIL_CACHED = 2;
const DETAIL_OUTPUT = 4;
const DETAIL_INCONSISTENT = 16;
const MODEL_PRICES = Object.freeze({
  "gpt-6-astra": Object.freeze({ short: { input: 10, cachedInput: 1, cacheWrite: 12.5, output: 50 }, long: { input: 20, cachedInput: 2, cacheWrite: 25, output: 75 } }),
  "gpt-6-sol": Object.freeze({ short: { input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 10 }, long: { input: 4, cachedInput: 0.4, cacheWrite: 5, output: 15 } }),
  "gpt-6-luna": Object.freeze({ short: { input: 0.1, cachedInput: 0.01, cacheWrite: 0.125, output: 0.5 }, long: { input: 0.2, cachedInput: 0.02, cacheWrite: 0.25, output: 0.75 } }),
  "gpt-5.6-sol": Object.freeze({ short: { input: 4, cachedInput: 0.4, cacheWrite: 5, output: 20 }, long: { input: 8, cachedInput: 0.8, cacheWrite: 10, output: 30 } }),
  "gpt-5.6-terra": Object.freeze({ short: { input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 12 }, long: { input: 4, cachedInput: 0.4, cacheWrite: 5, output: 18 } }),
  "gpt-5.6-luna": Object.freeze({ short: { input: 0.2, cachedInput: 0.02, cacheWrite: 0.25, output: 1.2 }, long: { input: 0.4, cachedInput: 0.04, cacheWrite: 0.5, output: 1.8 } }),
});

const PRICE_ALIASES = Object.freeze({
  "gpt-5.6": "gpt-5.6-sol",
  "gpt-daybreak-blue-latest": "gpt-5.6-sol",
});

// Custom rates reprice all indexed events so the dashboard remains internally
// consistent. The original token counts and recorded price versions are retained.
let activePricing = { checkedAt: API_PRICING_CHECKED_AT, version: API_PRICING_VERSION, models: MODEL_PRICES };

export const API_TOKEN_PRICES = Object.freeze(Object.fromEntries(
  Object.entries(MODEL_PRICES).map(([model, rates]) => [model, rates.short]),
));

export function getPricingCatalog() {
  return { checkedAt: activePricing.checkedAt, version: activePricing.version,
    source: API_PRICING_SOURCE, models: structuredClone(activePricing.models) };
}

export function validatePricingCatalog(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Pricing must be an object.");
  const checkedAt = value.checkedAt;
  if (typeof checkedAt !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(checkedAt) ||
      Number.isNaN(Date.parse(`${checkedAt}T00:00:00Z`)) ||
      new Date(`${checkedAt}T00:00:00Z`).toISOString().slice(0, 10) !== checkedAt) {
    throw new Error("Pricing date must be a valid YYYY-MM-DD date.");
  }
  const models = value.models;
  if (!models || typeof models !== "object" || Array.isArray(models)) throw new Error("Model prices are required.");
  const keys = Object.keys(models);
  if (keys.length < Object.keys(MODEL_PRICES).length || keys.length > 100 ||
      Object.keys(MODEL_PRICES).some((key) => !Object.hasOwn(models, key))) {
    throw new Error("All built-in models must have prices.");
  }
  const normalized = {};
  for (const model of keys.sort()) {
    if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(model)) throw new Error(`Invalid model name: ${model}`);
    const contexts = models[model];
    if (!contexts || typeof contexts !== "object" || Array.isArray(contexts)) throw new Error(`Invalid rates for ${model}`);
    normalized[model] = {};
    for (const context of ["short", "long"]) {
      const rates = contexts[context];
      if (!rates || typeof rates !== "object" || Array.isArray(rates)) throw new Error(`Missing ${context} rates for ${model}`);
      normalized[model][context] = {};
      for (const field of ["input", "cachedInput", "cacheWrite", "output"]) {
        if (typeof rates[field] !== "number" || !Number.isFinite(rates[field]) || rates[field] < 0) {
          throw new Error(`Invalid ${context} ${field} rate for ${model}`);
        }
        normalized[model][context][field] = rates[field];
      }
    }
  }
  return { checkedAt, models: normalized };
}

export function setPricingCatalog(value) {
  const catalog = validatePricingCatalog(value);
  const hash = createHash("sha256").update(JSON.stringify(catalog)).digest("hex").slice(0, 12);
  activePricing = { ...catalog, version: `${catalog.checkedAt}-${hash}` };
  return getPricingCatalog();
}

export function resetPricingCatalog() {
  activePricing = { checkedAt: API_PRICING_CHECKED_AT, version: API_PRICING_VERSION, models: MODEL_PRICES };
}

export function pricingVersionForTimestamp(_timestamp) {
  return activePricing.version;
}

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function usageFields(event = {}) {
  const usage = event.total || event.usage || event;
  const mask = Number.isInteger(event.detailMask) ? event.detailMask : 0;
  const has = (key, bit) => Number.isInteger(event.detailMask) ? Boolean(mask & bit) : Object.hasOwn(usage, key);
  return {
    total: finiteNonNegative(usage.total) ?? 0,
    input: finiteNonNegative(usage.input),
    cached: finiteNonNegative(usage.cached),
    output: finiteNonNegative(usage.output),
    inputKnown: has("input", DETAIL_INPUT) && finiteNonNegative(usage.input) !== null,
    cachedKnown: has("cached", DETAIL_CACHED) && finiteNonNegative(usage.cached) !== null,
    outputKnown: has("output", DETAIL_OUTPUT) && finiteNonNegative(usage.output) !== null,
    inconsistent: Boolean(mask & DETAIL_INCONSISTENT),
  };
}

function normalizeModel(value) {
  const model = String(value || "Unknown model").trim() || "Unknown model";
  const lower = model.toLocaleLowerCase();
  if (activePricing.models[lower]) return { name: model, key: lower };
  if (PRICE_ALIASES[lower]) return { name: model, key: PRICE_ALIASES[lower] };
  for (const known of Object.keys(activePricing.models)) {
    if (lower.startsWith(`${known}-`)) return { name: model, key: known };
  }
  return { name: model, key: "" };
}

function normalizeServiceTier(value) {
  const tier = String(value || "").trim().toLocaleLowerCase();
  if (tier === "fast" || tier === "priority") return "fast";
  if (tier === "default" || tier === "standard") return "standard";
  return "unknown";
}

function minimumRatesFor(modelKey, contextLevel) {
  const catalogs = modelKey ? [activePricing.models[modelKey]] : Object.values(activePricing.models);
  const contexts = contextLevel === "unknown" ? ["short", "long"] : [contextLevel];
  const candidates = catalogs.flatMap((catalog) => contexts.map((context) => catalog?.[context]).filter(Boolean));
  if (!candidates.length) return null;
  const rates = {};
  for (const category of ["input", "cachedInput", "cacheWrite", "output"]) {
    rates[category] = Math.min(...candidates.map((candidate) => candidate[category]));
  }
  return rates;
}

function minimumCategory(rates, categories) {
  return categories.reduce((lowest, category) =>
    rates[category] < rates[lowest] ? category : lowest, categories[0]);
}

function estimateEventCost(event = {}) {
  const model = normalizeModel(event.model);
  const usage = usageFields(event);
  const total = usage.total || (usage.input || 0) + (usage.output || 0);
  const version = activePricing.version;
  const contextLevel = event.contextLevel === "long" ? "long" : event.contextLevel === "short" ? "short" : "unknown";
  const serviceTier = normalizeServiceTier(event.serviceTier ?? event.service_tier);
  const multiplier = serviceTier === "fast" ? 2 : 1;
  const rates = minimumRatesFor(model.key, contextLevel);
  const minimumModelRate = !model.key;
  const cacheWriteTokens = finiteNonNegative(event.cacheWriteTokens);
  const cacheWriteKnown = event.cacheWriteKnown === true || (Number.isInteger(event.detailMask) && Boolean(event.detailMask & 32));
  const knownOrInferredInput = usage.inputKnown ? usage.input
    : usage.outputKnown ? Math.max(0, total - usage.output) : null;
  const cacheWriteUnknownTokens = !cacheWriteKnown || cacheWriteTokens === null
    ? knownOrInferredInput === null ? 0
      : Math.max(0, knownOrInferredInput - (usage.cachedKnown ? Math.min(usage.cached, knownOrInferredInput) : 0))
    : 0;
  const reasons = [];
  let inputUsd = 0;
  let cachedInputUsd = 0;
  let cacheWriteInputUsd = 0;
  let outputUsd = 0;
  let minimumEstimatedTokens = 0;
  let pricedTokens = 0;
  let unpricedTokens = 0;

  if (!rates) {
    return {
      model: model.name,
      priceVersion: version,
      serviceTier,
      contextLevel,
      inputUsd: 0,
      cachedInputUsd: 0,
      cacheWriteInputUsd: 0,
      outputUsd: 0,
      totalUsd: null,
      pricedTokens: 0,
      unpricedTokens: total,
      minimumEstimatedTokens: 0,
      minimumRateModels: [],
      unpricedModels: [model.name],
      unpricedReasons: ["no-pricing-catalog"],
      serviceTierUnknownTokens: 0,
      contextUnknownTokens: 0,
      cacheWriteUnknownTokens,
      pricingStatus: "unpriced",
    };
  }

  function addCost(tokens, category, minimum = false) {
    if (!(tokens > 0)) return;
    const amount = (tokens * rates[category] * multiplier) / USD_PER_MILLION_TOKENS;
    if (category === "cachedInput") cachedInputUsd += amount;
    else if (category === "cacheWrite") cacheWriteInputUsd += amount;
    else if (category === "output") outputUsd += amount;
    else inputUsd += amount;
    pricedTokens += tokens;
    if (minimum) minimumEstimatedTokens += tokens;
  }

  function addMinimum(tokens, categories) {
    addCost(tokens, minimumCategory(rates, categories), true);
  }

  const allCategories = ["input", "cachedInput", "cacheWrite", "output"];
  const countsInconsistent = usage.inconsistent ||
    (usage.inputKnown && usage.input > total) ||
    (usage.outputKnown && usage.output > total) ||
    (usage.inputKnown && usage.outputKnown && usage.input + usage.output !== total);
  if (countsInconsistent) {
    reasons.push("usage-detail-inconsistent-minimum-scenario");
    addMinimum(total, allCategories);
  } else {
    const inferredInput = knownOrInferredInput;
    if (inferredInput !== null) {
      const input = inferredInput;
      if (!usage.inputKnown) reasons.push("input-detail-inferred-from-total");
      const cachedValid = usage.cachedKnown && usage.cached <= input;
      const writeValid = cacheWriteKnown && cacheWriteTokens !== null && cacheWriteTokens <= input;
      if (cachedValid && writeValid && usage.cached + cacheWriteTokens <= input) {
        addCost(input - usage.cached - cacheWriteTokens, "input");
        addCost(usage.cached, "cachedInput");
        addCost(cacheWriteTokens, "cacheWrite");
      } else if (cachedValid && !writeValid && !cacheWriteKnown) {
        addCost(usage.cached, "cachedInput");
        addMinimum(input - usage.cached, ["input", "cacheWrite"]);
      } else if (writeValid && !cachedValid && !usage.cachedKnown) {
        addCost(cacheWriteTokens, "cacheWrite");
        addMinimum(input - cacheWriteTokens, ["input", "cachedInput"]);
      } else {
        reasons.push("input-detail-inconsistent-minimum-scenario");
        addMinimum(input, ["input", "cachedInput", "cacheWrite"]);
      }
      if (!usage.cachedKnown) reasons.push("cached-input-detail-missing");
      if (!cacheWriteKnown || cacheWriteTokens === null) reasons.push("cache-write-detail-missing");
    } else {
      reasons.push("input-detail-missing");
    }

    if (usage.outputKnown) addCost(usage.output, "output");
    else reasons.push("output-detail-missing");

    const remainder = Math.max(0, total - pricedTokens);
    if (usage.inputKnown && !usage.outputKnown) addCost(remainder, "output", true);
    else if (!usage.inputKnown && usage.outputKnown) addMinimum(remainder, ["input", "cachedInput", "cacheWrite"]);
    else addMinimum(remainder, allCategories);
  }

  if (minimumModelRate) {
    reasons.push("unknown-model-price-minimum-scenario");
    minimumEstimatedTokens = pricedTokens;
  }
  const serviceTierUnknownTokens = serviceTier === "unknown" ? pricedTokens : 0;
  const contextUnknownTokens = contextLevel === "unknown" ? pricedTokens : 0;
  if (serviceTier === "unknown") reasons.push("service-tier-unknown-standard-scenario");
  if (contextLevel === "unknown") reasons.push("request-context-unknown-minimum-scenario");
  const totalUsd = inputUsd + cachedInputUsd + cacheWriteInputUsd + outputUsd;
  return {
    model: model.name,
    priceVersion: version,
    serviceTier,
    contextLevel,
    inputUsd,
    cachedInputUsd,
    cacheWriteInputUsd,
    outputUsd,
    totalUsd: pricedTokens > 0 ? totalUsd : null,
    pricedTokens,
    unpricedTokens,
    minimumEstimatedTokens,
    minimumRateModels: minimumModelRate ? [model.name] : [],
    unpricedModels: [],
    unpricedReasons: [...new Set(reasons)],
    serviceTierUnknownTokens,
    contextUnknownTokens,
    cacheWriteUnknownTokens,
    pricingStatus: minimumEstimatedTokens > 0 ? "minimum-estimate" : "estimated",
  };
}

function createCostSummaryState(options = {}) {
  const totals = {
    inputUsd: 0,
    cachedInputUsd: 0,
    cacheWriteInputUsd: 0,
    outputUsd: 0,
    totalUsd: 0,
    cacheRateInput: 0,
    cacheRateCached: 0,
    pricedTokens: 0,
    unpricedTokens: 0,
    minimumEstimatedTokens: 0,
    pricedRecords: 0,
    minimumEstimatedRecords: 0,
    unpricedRecords: 0,
    serviceTierUnknownTokens: 0,
    serviceTierUnknownRecords: 0,
    contextUnknownTokens: 0,
    contextUnknownRecords: 0,
    cacheWriteUnknownTokens: 0,
    cacheWriteUnknownRecords: 0,
  };
  const models = new Set();
  const unpricedModels = new Set();
  const minimumRateModels = new Set();
  const unpricedReasons = new Set();
  const priceVersions = new Set();

  function add(item, estimate = estimateEventCost(item)) {
    for (const field of [
      "inputUsd", "cachedInputUsd", "cacheWriteInputUsd", "outputUsd", "cacheRateInput", "cacheRateCached",
      "pricedTokens", "unpricedTokens", "minimumEstimatedTokens", "serviceTierUnknownTokens", "contextUnknownTokens", "cacheWriteUnknownTokens",
    ]) {
      if (field in estimate) totals[field] += Number(estimate[field] || 0);
    }
    totals.totalUsd += Number(estimate.totalUsd || 0);
    if (estimate.pricedTokens > 0) totals.pricedRecords += 1;
    if (estimate.minimumEstimatedTokens > 0) totals.minimumEstimatedRecords += 1;
    if (estimate.unpricedTokens > 0) totals.unpricedRecords += 1;
    if (estimate.serviceTierUnknownTokens > 0) totals.serviceTierUnknownRecords += 1;
    if (estimate.contextUnknownTokens > 0) totals.contextUnknownRecords += 1;
    if (estimate.cacheWriteUnknownTokens > 0) totals.cacheWriteUnknownRecords += 1;
    if (modelNameIsKnown(estimate.model)) models.add(estimate.model);
    for (const name of estimate.unpricedModels) unpricedModels.add(name);
    for (const name of estimate.minimumRateModels || []) minimumRateModels.add(name);
    for (const reason of estimate.unpricedReasons) unpricedReasons.add(reason);
    priceVersions.add(estimate.priceVersion);
    const usage = usageFields(item);
    if (usage.inputKnown && usage.cachedKnown && usage.input > 0) {
      totals.cacheRateInput += usage.input;
      totals.cacheRateCached += usage.cached || 0;
    }
  }

  function result() {
    const hasPricedRecords = totals.pricedRecords > 0;
    return {
      totalUsd: hasPricedRecords ? totals.totalUsd : null,
      inputUsd: hasPricedRecords ? totals.inputUsd : null,
      cachedInputUsd: hasPricedRecords ? totals.cachedInputUsd : null,
      cacheWriteInputUsd: hasPricedRecords ? totals.cacheWriteInputUsd : null,
      outputUsd: hasPricedRecords ? totals.outputUsd : null,
      cacheHitRate: totals.cacheRateInput > 0 ? totals.cacheRateCached / totals.cacheRateInput : null,
      modelCount: models.size,
      pricedTokens: totals.pricedTokens,
      unpricedTokens: totals.unpricedTokens,
      minimumEstimatedTokens: totals.minimumEstimatedTokens,
      pricedRecords: totals.pricedRecords,
      unpricedRecords: totals.unpricedRecords,
      minimumEstimatedRecords: totals.minimumEstimatedRecords,
      unpricedModels: [...unpricedModels].sort((a, b) => a.localeCompare(b)),
      minimumRateModels: [...minimumRateModels].sort((a, b) => a.localeCompare(b)),
      unpricedReasons: [...unpricedReasons].sort(),
      serviceTierUnknownTokens: totals.serviceTierUnknownTokens,
      serviceTierUnknownRecords: totals.serviceTierUnknownRecords,
      contextUnknownTokens: totals.contextUnknownTokens,
      contextUnknownRecords: totals.contextUnknownRecords,
      cacheWriteUnknownTokens: totals.cacheWriteUnknownTokens,
      cacheWriteUnknownRecords: totals.cacheWriteUnknownRecords,
      priceVersions: [...priceVersions].sort(),
      priceCheckedAt: options.priceCheckedAt || activePricing.checkedAt,
      priceMode: API_PRICING_MODE,
      priceSource: API_PRICING_SOURCE,
    };
  }

  return { add, result };
}

export function createCostEstimateAccumulator(options = {}) {
  return createCostSummaryState(options);
}

function summarizeCostItems(items = [], options = {}) {
  const summary = createCostSummaryState(options);
  for (const item of items) summary.add(item);
  return summary.result();
}

function modelNameIsKnown(value) {
  return Boolean(value) && value.toLocaleLowerCase() !== "unknown model";
}

export function estimateCostForEvents(events = [], options = {}) {
  return summarizeCostItems(events, options);
}

export function estimateCostForGroups(groups = [], options = {}) {
  return summarizeCostItems(groups.map((group) => ({
    ...group,
    total: {
      total: group.total,
      input: group.input,
      cached: group.cached,
      output: group.output,
    },
  })), options);
}

export { estimateEventCost };
