import {z} from "zod";
import SubstackApi from "../api/substack/SubstackApi.js";
import {logger} from "../logger.js";
import {
  buildSubscriberQuery,
  OPERATORS_BY_TYPE,
  SUBSCRIBER_COLUMNS,
  SUBSCRIBER_COLUMN_NAMES,
} from "../api/substack/SubscriberQuery.js";

// Every operator name across every type. The schema accepts the union so a typo is caught by the
// SDK before dispatch, while the column-specific restriction is enforced by buildSubscriberQuery,
// which can say which operators *that* column would have taken.
const OPERATOR_NAMES = [
  ...new Set(Object.values(OPERATORS_BY_TYPE).flatMap((operators) => Object.keys(operators))),
];

// A one-line map from column to label and type, inlined into the schema description. Without it
// the caller sees 48 opaque snake_case names and has to guess which accept which operator.
const COLUMN_REFERENCE = Object.entries(SUBSCRIBER_COLUMNS)
  .map(([column, {type, label}]) => `${column} (${type}) = ${label}`)
  .join('; ');

const OPERATOR_REFERENCE = Object.entries(OPERATORS_BY_TYPE)
  .map(([type, operators]) => `${type}: ${Object.keys(operators).join(', ')}`)
  .join('. ');

// strictObject, not object: an unknown key must be reported rather than stripped, because the
// validation message is the only feedback an LLM gets to repair the call. `relation` instead of
// `operator` would otherwise be dropped in silence and the filter would go out incomplete.
export const listSubscribersSchema = z.strictObject({
  filters: z
    .array(
      z.strictObject({
        column: z
          .enum(SUBSCRIBER_COLUMN_NAMES)
          .describe(`The column to filter on. ${COLUMN_REFERENCE}`),
        operator: z
          .enum(OPERATOR_NAMES)
          .describe(
            `How to compare. Which operators are valid depends on the column's type — ${OPERATOR_REFERENCE}`
          ),
        value: z
          .union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))])
          .describe(
            "The value to compare against. Must be an array for is_any_of, includes_any, includes_all and includes_none, and a single value for every other operator. Dates are ISO strings, e.g. 2026-01-01."
          ),
      })
    )
    .optional()
    .describe(
      "Conditions to apply, combined with AND. The API supports no OR and no nesting, so anything needing OR has to be issued as separate calls. Omit to match every subscriber."
    ),
  search: z
    .string()
    .optional()
    .describe("Free-text search over subscriber name and email."),
  sort_by: z
    .enum(SUBSCRIBER_COLUMN_NAMES)
    .optional()
    .describe("Column to sort by. Any filterable column works."),
  sort_direction: z
    .enum(['asc', 'desc'])
    .optional()
    .describe("Sort direction, defaulting to desc."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("How many subscribers to return, 1-100, defaulting to 25."),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("How many subscribers to skip, for paging through a large segment."),
});

export const listSubscribersHandler = async (args) => {
  logger.debug('list_subscribers.start', {args});

  // McpServer already validated against this schema before dispatching, so over MCP this parse
  // never rejects. It is kept so the handler stays safe when called directly, which is how its
  // own tests exercise it.
  let validatedArgs;

  try {
    validatedArgs = listSubscribersSchema.parse(args);
  } catch (error) {
    // `issues`, not `errors`: zod 4 renamed it, and reading the old name yields undefined
    // instead of failing.
    logger.error('list_subscribers.args.invalid', {issues: error.issues ?? error.message});
    throw error;
  }

  // Built before the request so an illegal column/operator pair costs nothing. The API would
  // answer 400 with a body that names neither the column nor the alternatives.
  let query;

  try {
    query = buildSubscriberQuery(validatedArgs);
  } catch (error) {
    logger.error('list_subscribers.query.invalid', {args: validatedArgs, error});
    throw error;
  }

  const substack_api = new SubstackApi({
    publication_url: process.env.SUBSTACK_PUBLICATION_URL,
    auth_token: process.env.SUBSTACK_SESSION_TOKEN,
  });

  const response = await substack_api.getSubscribers(query);

  const subscribers = response?.subscribers ?? [];

  logger.info('list_subscribers.done', {
    count: response?.count ?? null,
    returned: subscribers.length,
    limit: query.limit,
    offset: query.offset,
  });

  return {
    // The total matching the filters, independent of `limit` — so limit:1 is a cheap way to size
    // a segment without pulling it.
    count: response?.count ?? null,
    returned: subscribers.length,
    limit: query.limit,
    offset: query.offset,
    subscribers,
  };
};
