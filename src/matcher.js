import { normalizeText } from './text.js';
import { candidateStates } from './geo.js';

/**
 * Trigger config shape (all conditions optional, AND-ed together; at least one
 * required — enforced by validateTriggerConfig):
 * {
 *   keywords: string[],          // OR across entries; multi-word entry = all words present
 *   excludeKeywords: string[],   // any hit rejects the lot
 *   categories: string[],        // official lot categories, OR
 *   states: string[],            // UF codes, OR
 *   cities: string[],            // city / executing-unit names, OR
 *   minPrice: number,            // lower bound on minBid
 *   maxPrice: number,            // upper bound on minBid
 *   maxPctOfAppraisal: number,   // minBid/appraisalValue*100 <= X
 *   individualsOnly: boolean,    // only lots a natural person can bid on
 *   requireImages: boolean,
 *   featuredOnly: boolean,
 *   events: string[],            // new_lot | proposals_open | deadline_soon
 *   channels: string[],          // toast | ntfy
 * }
 */

export const EVENT_TYPES = ['new_lot', 'proposals_open', 'deadline_soon'];
export const CHANNEL_TYPES = ['toast', 'ntfy'];

const CONDITION_KEYS = [
  'keywords', 'categories', 'states', 'cities',
  'minPrice', 'maxPrice', 'maxPctOfAppraisal',
  'individualsOnly', 'requireImages', 'featuredOnly',
];

function isNonEmptyStringArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === 'string' && entry.trim());
}

/** Returns a list of human-readable problems; empty list means valid. */
export function validateTriggerConfig(config) {
  const problems = [];
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return ['config must be an object'];
  }
  for (const key of ['keywords', 'excludeKeywords', 'categories', 'states', 'cities']) {
    if (config[key] !== undefined && !isNonEmptyStringArray(config[key])) {
      problems.push(`${key} must be a non-empty array of strings`);
    }
  }
  for (const key of ['minPrice', 'maxPrice', 'maxPctOfAppraisal']) {
    if (config[key] !== undefined && (typeof config[key] !== 'number' || !Number.isFinite(config[key]) || config[key] < 0)) {
      problems.push(`${key} must be a non-negative number`);
    }
  }
  if (config.minPrice !== undefined && config.maxPrice !== undefined && config.minPrice > config.maxPrice) {
    problems.push('minPrice must not exceed maxPrice');
  }
  for (const key of ['individualsOnly', 'requireImages', 'featuredOnly']) {
    if (config[key] !== undefined && typeof config[key] !== 'boolean') {
      problems.push(`${key} must be a boolean`);
    }
  }
  if (config.events !== undefined) {
    if (!isNonEmptyStringArray(config.events) || !config.events.every((event) => EVENT_TYPES.includes(event))) {
      problems.push(`events must be a non-empty array of: ${EVENT_TYPES.join(', ')}`);
    }
  }
  if (config.channels !== undefined) {
    if (!Array.isArray(config.channels) || !config.channels.every((channel) => CHANNEL_TYPES.includes(channel))) {
      problems.push(`channels must be an array of: ${CHANNEL_TYPES.join(', ')}`);
    }
  }
  const hasCondition = CONDITION_KEYS.some((key) => {
    const value = config[key];
    if (value === undefined) return false;
    if (typeof value === 'boolean') return value === true;
    return true;
  });
  if (!hasCondition) problems.push('at least one filter condition is required');
  return problems;
}

/** A keyword matches when every one of its words appears in the haystack. */
function keywordMatches(keyword, haystack) {
  const words = normalizeText(keyword).split(' ').filter(Boolean);
  return words.length > 0 && words.every((word) => haystack.includes(word));
}

/**
 * Evaluate a trigger config against one lot row. The lot is the joined
 * lot+notice shape produced by lotRowsForMatching()/the /api/lots query:
 * { category, minBid, appraisalValue, allowsIndividuals, noticeAllowsIndividuals,
 *   hasImages, featured, searchText, city, unitName, state, unitCode }
 */
export function triggerMatchesLot(config, lot) {
  const haystack = normalizeText(`${lot.searchText ?? ''} ${lot.category ?? ''}`);

  if (config.excludeKeywords?.some((keyword) => keywordMatches(keyword, haystack))) return false;
  if (config.keywords && !config.keywords.some((keyword) => keywordMatches(keyword, haystack))) return false;

  if (config.categories) {
    const categories = config.categories.map(normalizeText);
    if (!categories.includes(normalizeText(lot.category))) return false;
  }

  if (config.states) {
    const lotStates = lot.state ? [lot.state] : candidateStates(lot.city, lot.unitCode);
    if (!lotStates.some((state) => config.states.includes(state))) return false;
  }

  if (config.cities) {
    const cities = config.cities.map(normalizeText);
    const lotCity = normalizeText(lot.city);
    const lotUnit = normalizeText(lot.unitName);
    if (!cities.includes(lotCity) && !cities.includes(lotUnit)) return false;
  }

  const hasPrice = typeof lot.minBid === 'number' && Number.isFinite(lot.minBid);
  if (config.minPrice !== undefined && !(hasPrice && lot.minBid >= config.minPrice)) return false;
  if (config.maxPrice !== undefined && !(hasPrice && lot.minBid <= config.maxPrice)) return false;

  if (config.maxPctOfAppraisal !== undefined) {
    if (!(lot.appraisalValue > 0) || lot.minBid == null) return false;
    if ((lot.minBid / lot.appraisalValue) * 100 > config.maxPctOfAppraisal) return false;
  }

  if (config.individualsOnly && !(lot.allowsIndividuals || lot.noticeAllowsIndividuals)) return false;
  if (config.requireImages && !lot.hasImages) return false;
  if (config.featuredOnly && !lot.featured) return false;

  return true;
}

/** SQL producing the joined lot+notice rows the matcher consumes. */
export const MATCHABLE_LOTS_SQL = `
  SELECT l.noticeId, l.lotNumber, l.category, l.minBid, l.appraisalValue,
         l.featured, l.allowsIndividuals, l.hasImages, l.thumbnailUrl,
         l.searchText, l.detailFetchedAt, l.firstSeenAt,
         n.shortId, n.unitCode, n.unitName, n.city, n.state, n.statusCode,
         n.allowsIndividuals AS noticeAllowsIndividuals,
         n.proposalsStartAt, n.proposalsEndAt, n.biddingStartsAt
  FROM lots l JOIN notices n ON n.noticeId = l.noticeId
`;

/** All lots in active notices whose details are known, ready for matching. */
export function lotRowsForMatching(db, activeStatusCodes) {
  const placeholders = activeStatusCodes.map(() => '?').join(',');
  return db.prepare(
    `${MATCHABLE_LOTS_SQL} WHERE n.statusCode IN (${placeholders}) AND l.detailFetchedAt IS NOT NULL`,
  ).all(...activeStatusCodes);
}

/** Map of triggerId → matching lot rows. */
export function evaluateTriggers(triggers, lots) {
  const matches = new Map();
  for (const trigger of triggers) {
    const matching = lots.filter((lot) => triggerMatchesLot(trigger.config, lot));
    if (matching.length > 0) matches.set(trigger.id, matching);
  }
  return matches;
}
