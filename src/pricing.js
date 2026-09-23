import { createHash } from "node:crypto";

export const API_PRICING_CHECKED_AT = "2026-09-23";
export const API_PRICING_VERSION = "2026-09-23";
export const API_PRICING_MODE = "standard-scenario";
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

function estimateEventCost(event = {}) {
  const model = normalizeModel(event.model);
  const usage = usageFields(event);
  const total = usage.total || (usage.input || 0) + (usage.output || 0);
  const version = activePricing.version;
  const ratesByContext = activePricing.models[model.key];
  const reasons = [];
  let inputUsd = 0;
  let cachedInputUsd = 0;
  let cacheWriteInputUsd = 0;
  let outputUsd = 0;
  let pricedTokens = 0;
  let unpricedTokens = 0;
  const cacheWriteTokens = finiteNonNegative(event.cacheWriteTokens);
  const cacheWriteKnown = event.cacheWriteKnown === true || (Number.isInteger(event.detailMask) && Boolean(event.detailMask & 32));
  const contextLevel = event.contextLevel === "long" ? "long" : event.contextLevel === "short" ? "short" : "unknown";
  const serviceTier = normalizeServiceTier(event.serviceTier ?? event.service_tier);
  const ratesContext = contextLevel === "long" ? "long" : "short";
  const rates = ratesByContext?.[ratesContext];
  const multiplier = serviceTier === "fast" ? 2 : 1;

  if (!rates) {
    reasons.push("unknown-model-price");
    unpricedTokens = total;
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
      unpricedTokens,
      unpricedModels: [model.name],
      unpricedReasons: reasons,
      serviceTierUnknownTokens: 0,
      contextUnknownTokens: 0,
      cacheWriteUnknownTokens: usage.inputKnown ? usage.input || 0 : 0,
      pricingStatus: "unpriced",
    };
  }

  const inputDetailsValid = usage.inputKnown && usage.cachedKnown && cacheWriteKnown &&
    !usage.inconsistent && usage.cached <= usage.input &&
    cacheWriteTokens !== null && usage.cached + cacheWriteTokens <= usage.input;
  if (inputDetailsValid) {
    const ordinaryInputTokens = usage.input - usage.cached - cacheWriteTokens;
    inputUsd = (ordinaryInputTokens * rates.input * multiplier) / USD_PER_MILLION_TOKENS;
    cachedInputUsd = (usage.cached * rates.cachedInput * multiplier) / USD_PER_MILLION_TOKENS;
    cacheWriteInputUsd = (cacheWriteTokens * rates.cacheWrite * multiplier) / USD_PER_MILLION_TOKENS;
    pricedTokens += usage.input;
  } else {
    const unknownInput = usage.inputKnown ? usage.input : Math.max(0, total - (usage.outputKnown ? usage.output : 0));
    unpricedTokens += unknownInput;
    if (!usage.inputKnown) reasons.push("input-detail-missing");
    if (!usage.cachedKnown) reasons.push("cached-input-detail-missing");
    if (!cacheWriteKnown || cacheWriteTokens === null) reasons.push("cache-write-detail-missing");
    if (usage.inconsistent || (usage.inputKnown && usage.cachedKnown && usage.cached > usage.input) ||
        (usage.inputKnown && cacheWriteTokens !== null && usage.cached + cacheWriteTokens > usage.input)) {
      reasons.push("input-detail-inconsistent");
    }
  }

  const outputValid = usage.outputKnown && !usage.inconsistent && usage.output <= total;
  if (outputValid) {
    outputUsd = (usage.output * rates.output * multiplier) / USD_PER_MILLION_TOKENS;
    pricedTokens += usage.output;
  } else {
    const unknownOutput = usage.outputKnown ? usage.output : Math.max(0, total - (usage.inputKnown ? usage.input : 0));
    unpricedTokens += unknownOutput;
    if (!usage.outputKnown) reasons.push("output-detail-missing");
    if (usage.inconsistent || usage.output > total) reasons.push("output-detail-inconsistent");
  }

  const totalUsd = inputUsd + cachedInputUsd + cacheWriteInputUsd + outputUsd;
  const serviceTierUnknownTokens = serviceTier === "unknown" ? pricedTokens : 0;
  const contextUnknownTokens = contextLevel === "unknown" ? pricedTokens : 0;
  if (serviceTier === "unknown") reasons.push("service-tier-unknown-standard-scenario");
  if (contextLevel === "unknown") reasons.push("request-context-unknown-short-scenario");
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
    unpricedModels: [],
    unpricedReasons: [...new Set(reasons)],
    serviceTierUnknownTokens,
    contextUnknownTokens,
    cacheWriteUnknownTokens: cacheWriteKnown ? 0 : (usage.inputKnown ? usage.input || 0 : 0),
    pricingStatus: pricedTokens === 0 ? "unpriced" : unpricedTokens > 0 ? "partial" : "estimated",
  };
}

function summarizeCostItems(items = [], options = {}) {
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
    pricedRecords: 0,
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
  const unpricedReasons = new Set();
  const priceVersions = new Set();

  for (const item of items) {
    const estimate = estimateEventCost(item);
    for (const field of [
      "inputUsd", "cachedInputUsd", "cacheWriteInputUsd", "outputUsd", "cacheRateInput", "cacheRateCached",
      "pricedTokens", "unpricedTokens", "serviceTierUnknownTokens", "contextUnknownTokens", "cacheWriteUnknownTokens",
    ]) {
      if (field in estimate) totals[field] += Number(estimate[field] || 0);
    }
    totals.totalUsd += Number(estimate.totalUsd || 0);
    if (estimate.pricedTokens > 0) totals.pricedRecords += 1;
    if (estimate.unpricedTokens > 0) totals.unpricedRecords += 1;
    if (estimate.serviceTierUnknownTokens > 0) totals.serviceTierUnknownRecords += 1;
    if (estimate.contextUnknownTokens > 0) totals.contextUnknownRecords += 1;
    if (estimate.cacheWriteUnknownTokens > 0) totals.cacheWriteUnknownRecords += 1;
    if (modelNameIsKnown(estimate.model)) models.add(estimate.model);
    for (const name of estimate.unpricedModels) unpricedModels.add(name);
    for (const reason of estimate.unpricedReasons) unpricedReasons.add(reason);
    priceVersions.add(estimate.priceVersion);
    const usage = usageFields(item);
    if (usage.inputKnown && usage.cachedKnown && usage.input > 0) {
      totals.cacheRateInput += usage.input;
      totals.cacheRateCached += usage.cached || 0;
    }
  }

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
    pricedRecords: totals.pricedRecords,
    unpricedRecords: totals.unpricedRecords,
    unpricedModels: [...unpricedModels].sort((a, b) => a.localeCompare(b)),
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
