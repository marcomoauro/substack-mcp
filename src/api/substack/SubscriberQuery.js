import {logger} from "../../logger.js";

/**
 * Translates a structured filter list into the payload `POST /api/v1/subscriber-stats` expects.
 *
 * Substack encodes a filter as a single flat key inside `filters`: the column name with an
 * operator suffix glued onto it (`num_comments_gt`, `user_email_address_similar_to`). Multiple
 * keys are ANDed; there is no OR and no nesting. Sorting and free-text search are two more keys
 * in the same object rather than separate parameters.
 *
 * That encoding is hostile to a caller that has to construct it blind, because the suffix
 * depends on the column's type and the API answers every mistake with a bare 400: "is not" is
 * `_distinct_from`, `_not` or `_string_not` depending on the column, and `_lte` works on an Int
 * while the DateTime equivalent is `_is_on_or_before`. So the operators exposed here are named
 * by intent (`is_not`, `is_before`) and the suffix is derived from the column's type, which
 * makes an illegal combination impossible to express rather than a round-trip away.
 *
 * The column table and the operator matrix were both read out of the publisher bundle and then
 * confirmed empirically: all 48 columns were probed against the live API with the discriminating
 * suffixes, and the resulting classification is what the tables below encode.
 */

// type -> {operator name: suffix appended to the column}. The empty string is a real suffix:
// on an Int or enum column "is" sends the column name alone.
export const OPERATORS_BY_TYPE = {
  Int: {
    is: '',
    is_not: '_distinct_from',
    gt: '_gt',
    gte: '_gte',
    lt: '_lt',
    lte: '_lte',
  },
  String: {
    is: '_string_is',
    is_not: '_string_not',
    is_any_of: '_in',
    contains: '_similar_to',
    starts_with: '_starts_with',
    ends_with: '_ends_with',
    includes_none: '_includes_none',
  },
  DateTime: {
    is_on: '_is_on',
    is_after: '_gt',
    is_on_or_after: '_gte',
    is_before: '_lt',
    is_on_or_before: '_is_on_or_before',
  },
  Array: {
    includes_any: '_includes_any',
    includes_all: '_includes_all',
    includes_none: '_includes_none',
  },
  subscription_type: {
    is: '',
    is_not: '_not',
    is_any_of: '_in',
  },
  group_membership: {
    is: '',
    is_not: '_distinct_from',
    is_any_of: '_in',
  },
};

// The operators whose value is a list. Passing a scalar to one of these, or a list to any other,
// is a 400 from the API and a refusal here.
const LIST_OPERATORS = new Set(['is_any_of', 'includes_any', 'includes_all', 'includes_none']);

const SUBSCRIPTION_TYPES = ['paid', 'free', 'founding', 'comp', 'gift', 'free_trial', 'iap'];
const GROUP_MEMBERSHIPS = ['none', 'member', 'admin'];

/**
 * The 48 filterable columns, keyed by the name the API expects. `label` is the wording the
 * Substack UI shows for the same column, which is how a caller working from the dashboard will
 * refer to it. `values` restricts an enum column.
 */
export const SUBSCRIBER_COLUMNS = {
  // Subscriber identity
  user_name: {type: 'String', label: 'Name'},
  user_email_address: {type: 'String', label: 'Email'},
  country: {type: 'String', label: 'Country'},
  state: {type: 'String', label: 'State/Province'},
  group_membership: {type: 'group_membership', label: 'Group membership', values: GROUP_MEMBERSHIPS},

  // Subscription
  subscription_type: {type: 'subscription_type', label: 'Type', values: SUBSCRIPTION_TYPES},
  subscription_created_at: {type: 'DateTime', label: 'Start date'},
  subscription_expires_at: {type: 'DateTime', label: 'Expiration date'},
  first_payment_at: {type: 'DateTime', label: 'First paid date'},
  last_subscribed_at: {type: 'DateTime', label: 'Paid upgrade date'},
  unsubscribed_at: {type: 'DateTime', label: 'Cancel date'},
  subscription_interval: {type: 'String', label: 'Subscription interval'},
  stripe_plan_name: {type: 'String', label: 'Stripe plan'},
  free_attribution: {type: 'String', label: 'Subscription source (free)'},
  paid_attribution: {type: 'String', label: 'Subscription source (paid)'},
  is_subscribed: {type: 'Int', label: 'Can see paid content'},
  bestseller_tier: {type: 'Int', label: 'Bestseller'},
  total_revenue_generated: {type: 'Int', label: 'Revenue'},
  num_subs_gifted: {type: 'Int', label: 'Subscriptions gifted'},
  bundle_id: {type: 'Int', label: 'Bundle'},
  is_bundle_parent: {type: 'Int', label: 'Bundle origin'},

  // Email engagement
  num_emails_received: {type: 'Int', label: 'Emails received (6mo)'},
  num_emails_dropped: {type: 'Int', label: 'Emails dropped (6mo)'},
  num_email_opens: {type: 'Int', label: 'Emails opened (6mo)'},
  num_email_opens_last_7d: {type: 'Int', label: 'Emails opened (7d)'},
  num_email_opens_last_30d: {type: 'Int', label: 'Emails opened (30d)'},
  num_unique_email_posts_seen: {type: 'Int', label: 'Unique emails seen (6mo)'},
  num_unique_email_posts_seen_last_7d: {type: 'Int', label: 'Unique emails seen (7d)'},
  num_unique_email_posts_seen_last_30d: {type: 'Int', label: 'Unique emails seen (30d)'},
  last_opened_at: {type: 'DateTime', label: 'Last email open'},
  links_clicked: {type: 'Int', label: 'Links clicked'},
  last_clicked_at: {type: 'DateTime', label: 'Last clicked at'},
  emails_enabled: {type: 'Array', label: 'Sections'},

  // Site engagement
  num_web_post_views: {type: 'Int', label: 'Post views'},
  num_web_post_views_last_7d: {type: 'Int', label: 'Post views (7d)'},
  num_web_post_views_last_30d: {type: 'Int', label: 'Post views (30d)'},
  num_unique_web_posts_seen: {type: 'Int', label: 'Unique posts seen'},
  num_unique_web_posts_seen_last_7d: {type: 'Int', label: 'Unique posts seen (7d)'},
  num_unique_web_posts_seen_last_30d: {type: 'Int', label: 'Unique posts seen (30d)'},
  num_comments: {type: 'Int', label: 'Comments'},
  num_comments_last_7d: {type: 'Int', label: 'Comments (7d)'},
  num_comments_last_30d: {type: 'Int', label: 'Comments (30d)'},
  num_shares: {type: 'Int', label: 'Shares'},
  num_shares_last_7d: {type: 'Int', label: 'Shares (7d)'},
  num_shares_last_30d: {type: 'Int', label: 'Shares (30d)'},
  days_active_last_30d: {type: 'Int', label: 'Days active (30d)'},
  activity_rating: {type: 'Int', label: 'Activity'},

  // Tags
  tag_ids: {type: 'Array', label: 'Tags'},
};

export const SUBSCRIBER_COLUMN_NAMES = Object.keys(SUBSCRIBER_COLUMNS);

function describeColumn(column) {
  const {type, label} = SUBSCRIBER_COLUMNS[column];
  return `${column} (${label}, ${type})`;
}

function resolveSuffix(column, operator) {
  const definition = SUBSCRIBER_COLUMNS[column];

  if (!definition) {
    throw new Error(
      `Unknown column "${column}". Valid columns: ${SUBSCRIBER_COLUMN_NAMES.join(', ')}`
    );
  }

  const operators = OPERATORS_BY_TYPE[definition.type];
  const suffix = operators[operator];

  // A missing key and a key holding the empty string are both falsy, so the presence check has
  // to be explicit: "is" legitimately maps to ''.
  if (suffix === undefined) {
    throw new Error(
      `Operator "${operator}" does not apply to ${describeColumn(column)}. ` +
      `Valid operators for it: ${Object.keys(operators).join(', ')}`
    );
  }

  return suffix;
}

function validateValue(column, operator, value) {
  const {values} = SUBSCRIBER_COLUMNS[column];
  const expectsList = LIST_OPERATORS.has(operator);

  if (expectsList && !Array.isArray(value)) {
    throw new Error(`Operator "${operator}" on ${describeColumn(column)} needs an array of values.`);
  }

  if (!expectsList && Array.isArray(value)) {
    throw new Error(
      `Operator "${operator}" on ${describeColumn(column)} takes a single value, not an array.`
    );
  }

  if (!values) return;

  // Enum values are validated by the API too, and rejecting one costs a round trip that tells
  // the caller only "400". Listing the alternatives here is the difference between a repairable
  // call and a guess.
  for (const candidate of Array.isArray(value) ? value : [value]) {
    if (!values.includes(candidate)) {
      throw new Error(
        `"${candidate}" is not a valid value for ${describeColumn(column)}. ` +
        `Valid values: ${values.join(', ')}`
      );
    }
  }
}

/**
 * Builds the request body for the subscribers endpoint.
 *
 * `filters` is a list of {column, operator, value}. `search` is free text matched against name
 * and email. `sort_by` names any column, `sort_direction` is 'asc' or 'desc' (default 'desc').
 */
export function buildSubscriberQuery({
  filters = [],
  search = null,
  sort_by = null,
  sort_direction = 'desc',
  limit = 25,
  offset = 0,
} = {}) {
  const built = {};

  for (const {column, operator, value} of filters) {
    const suffix = resolveSuffix(column, operator);
    validateValue(column, operator, value);

    const key = `${column}${suffix}`;

    // Two filters that reduce to the same key would silently collapse into one, dropping a
    // condition the caller asked for. Refusing is the only way that stays visible.
    if (Object.prototype.hasOwnProperty.call(built, key)) {
      throw new Error(
        `Duplicate filter: ${describeColumn(column)} already has an "${operator}" condition. ` +
        `Use a single condition per column and operator.`
      );
    }

    built[key] = value;
    logger.debug('subscriber_query.filter', {column, operator, key, value});
  }

  // Verified against the live API: a top-level `search` is ignored and the response comes back
  // unfiltered. It only takes effect inside `filters`.
  if (search !== null && search !== '') {
    built.search = search;
  }

  if (sort_by !== null) {
    if (!SUBSCRIBER_COLUMNS[sort_by]) {
      throw new Error(
        `Unknown column "${sort_by}" for sort_by. Valid columns: ${SUBSCRIBER_COLUMN_NAMES.join(', ')}`
      );
    }

    const key = sort_direction === 'asc' ? 'order_by' : 'order_by_desc_nulls_last';
    built[key] = sort_by;
  }

  const query = {filters: built, limit, offset};
  logger.debug('subscriber_query.built', {query});

  return query;
}
