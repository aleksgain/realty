'use strict';
// All settings come from environment variables (set in the unRAID template).
const env = process.env;
const list = (v, d) => (v ?? d).split(',').map((s) => s.trim()).filter(Boolean);
const nums = (v, d) => list(v, d).map(Number).filter((n) => !Number.isNaN(n));
const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v));
const pairs = (v, d) => Object.fromEntries(list(v, d).map((p) => { const i = p.lastIndexOf(':'); return [p.slice(0, i).trim(), Number(p.slice(i + 1))]; }));

const point = (v, d) => { const [lat, lon] = (v || d).split(',').map(Number); return { lat, lon }; };

const config = {
  port: num(env.PORT, 8080),
  dataDir: env.DATA_DIR || '/data',
  timeZone: env.TIMEZONE || 'Europe/Prague',
  cron: env.CRON || '0 7,19 * * *',
  runOnStart: bool(env.RUN_ON_START, true),
  minRunGapMinutes: num(env.MIN_RUN_GAP_MINUTES, 10),
  userHeader: (env.USER_HEADER || '').toLowerCase(),
  users: list(env.USERS, ''),

  moveInDeadline: env.MOVE_IN_DATE || '2027-07-01',
  latestCompletion: env.LATEST_COMPLETION || '2027-03-31',
  filters: {
    priceTo: num(env.PRICE_MAX, 15000000),
    areaFrom: num(env.AREA_MIN, 50),
    ownership: num(env.OWNERSHIP, 1),                 // 1 = osobní; 0 = any
    required: list(env.REQUIRED, 'parking,outdoor,cellar'),
    keepUnknownReadyDate: bool(env.KEEP_UNKNOWN_READY_DATE, true),
  },
  scoring: {
    district: pairs(env.SCORE_DISTRICTS, 'Praha 7:40,Praha 6:25,Praha 8:15'),
    ac: num(env.SCORE_AC, 25),
    acPrep: num(env.SCORE_AC_PREP, 12),
    ev: num(env.SCORE_EV, 10),
    newBuild: num(env.SCORE_NEW_BUILD, 5),
  },
  sreality: {
    regionIds: nums(env.SREALITY_REGIONS, '10'),
    newConditions: nums(env.SREALITY_NEW_CONDITIONS, '6,4'),
    secondaryConditions: nums(env.SREALITY_RESALE_CONDITIONS, '1,9'),
    maxPages: num(env.SREALITY_MAX_PAGES, 20),
    concurrency: num(env.SREALITY_CONCURRENCY, 4),
    reevaluateDays: num(env.REEVALUATE_DAYS, 14),
    reevaluatePerRun: num(env.REEVALUATE_PER_RUN, 150),
  },
  novostavby: {
    enabled: bool(env.NOVOSTAVBY_ENABLED, true),
    locationIds: nums(env.NOVOSTAVBY_LOCATIONS, '2530,1386,1519'),
    statusIds: nums(env.NOVOSTAVBY_STATUSES, '2719,2718'),
    typeIds: nums(env.NOVOSTAVBY_TYPES, '3109,1602'),
    years: pairs(env.NOVOSTAVBY_YEARS, 'ihned:365,2026:3378,2027:3410'),
  },
  // Houses: radius search around a centre point instead of districts.
  house: {
    enabled: bool(env.HOUSE_ENABLED, true),
    center: point(env.HOUSE_CENTER, '50.0884,14.4286'),
    centerLabel: env.HOUSE_CENTER_LABEL || 'Náměstí Republiky',
    radiusKm: num(env.HOUSE_RADIUS_KM, 20),
    priceTo: num(env.HOUSE_PRICE_MAX, num(env.PRICE_MAX, 15000000)),
    areaFrom: num(env.HOUSE_AREA_MIN, num(env.AREA_MIN, 50)),
    plotFrom: num(env.HOUSE_PLOT_MIN, 1),
    required: list(env.HOUSE_REQUIRED, 'garage'),
    regionIds: nums(env.HOUSE_SREALITY_REGIONS, '10,11'),
    types: nums(env.HOUSE_SREALITY_TYPES, '37,39,40,54'),
    newConditions: nums(env.HOUSE_SREALITY_NEW_CONDITIONS, env.SREALITY_NEW_CONDITIONS ?? '6,4'),
    secondaryConditions: nums(env.HOUSE_SREALITY_RESALE_CONDITIONS, env.SREALITY_RESALE_CONDITIONS ?? '1,9'),
    flatzoneAreas: list(env.HOUSE_FLATZONE_AREAS, 'city:Praha,region:Středočeský kraj'),
    scoreDistance: num(env.HOUSE_SCORE_DISTANCE, 40),
  },
  flatzone: {
    enabled: bool(env.FLATZONE_ENABLED, true),
    city: env.FLATZONE_CITY || 'Praha',
    projectRefreshDays: num(env.FLATZONE_PROJECT_REFRESH_DAYS, 7),
  },
  dedupe: {
    meters: num(env.DEDUPE_METERS, 150),
    areaTolerance: num(env.DEDUPE_AREA_TOLERANCE, 2),
  },
  userAgent: env.USER_AGENT || 'Mozilla/5.0 (reality; personal property watch)',
};
module.exports = config;
