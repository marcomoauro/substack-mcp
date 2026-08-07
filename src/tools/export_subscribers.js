import {z} from "zod";
import SubstackApi from "../api/substack/SubstackApi.js";
import {logger} from "../logger.js";
import {parseCsv} from "../api/substack/csv.js";
import {
  buildSubscriberQuery,
  COLUMN_KEY_BY_LABEL,
  SUBSCRIBER_COLUMNS,
  SUBSCRIBER_COLUMN_NAMES,
} from "../api/substack/SubscriberQuery.js";

/**
 * The backoff Substack's own dashboard uses while waiting for an export: 1s, 5s, 10s, 30s, then a
 * minute at a time. The last entry repeats until the caller's wait budget runs out.
 */
export const EXPORT_POLL_BACKOFF_SECONDS = [1, 5, 10, 30, 60];

const DEFAULT_MAX_WAIT_SECONDS = 120;

const sleepSeconds = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));

const COLUMN_REFERENCE = Object.entries(SUBSCRIBER_COLUMNS)
  .map(([column, {label}]) => `${column} = ${label}`)
  .join('; ');

// strictObject, not object: an unknown key must be reported rather than stripped, since the
// validation message is the only feedback an LLM gets to repair the call.
export const exportSubscribersSchema = z.strictObject({
  filters: z
    .array(
      z.strictObject({
        column: z.enum(SUBSCRIBER_COLUMN_NAMES).describe("The column to filter on."),
        operator: z.string().describe("How to compare, exactly as in list_subscribers."),
        value: z
          .union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))])
          .describe("The value to compare against."),
      })
    )
    .optional()
    .describe(
      "Which subscribers to export, using the same conditions as list_subscribers, combined with AND. Omit to export everyone."
    ),
  search: z
    .string()
    .optional()
    .describe("Free-text search over subscriber name and email."),
  columns: z
    .array(z.enum(SUBSCRIBER_COLUMN_NAMES))
    .optional()
    .describe(
      `Which columns to include. Defaults to every column. Available: ${COLUMN_REFERENCE}`
    ),
  max_wait_seconds: z
    .number()
    .int()
    .min(1)
    .max(600)
    .optional()
    .describe(
      "How long to wait for Substack to generate the file, 1-600, defaulting to 120. A small export is ready in a few seconds."
    ),
});

/**
 * Reads a subscriber export back into records keyed by column name.
 *
 * The CSV header carries human labels rather than column keys, and in the server's own order rather
 * than the requested one, so everything keys off the header row — never off position.
 */
function recordsFromCsv(csv) {
  const {header, rows} = parseCsv(csv);

  const keys = header.map((label) => COLUMN_KEY_BY_LABEL[label] ?? label);
  const unmapped = header.filter((label) => !COLUMN_KEY_BY_LABEL[label]);

  const subscribers = rows.map((cells) =>
    Object.fromEntries(keys.map((key, index) => [key, cells[index] ?? null]))
  );

  return {columns: keys.filter((key) => !unmapped.includes(key)), unmapped, subscribers};
}

export const exportSubscribersHandler = async (args, {sleep = sleepSeconds} = {}) => {
  logger.debug('export_subscribers.start', {args});

  // McpServer already validated against this schema before dispatching, so over MCP this parse
  // never rejects. It is kept so the handler stays safe when called directly.
  let validatedArgs;

  try {
    validatedArgs = exportSubscribersSchema.parse(args);
  } catch (error) {
    // `issues`, not `errors`: zod 4 renamed it, and reading the old name yields undefined.
    logger.error('export_subscribers.args.invalid', {issues: error.issues ?? error.message});
    throw error;
  }

  const {
    filters = [],
    search = null,
    columns = SUBSCRIBER_COLUMN_NAMES,
    max_wait_seconds = DEFAULT_MAX_WAIT_SECONDS,
  } = validatedArgs;

  // Built before anything is created, so an illegal column/operator pair costs no server state.
  // limit and offset are dropped on purpose: an export covers the whole matching set, and paging it
  // would quietly return a slice of the audience.
  let query;

  try {
    ({filters: query} = buildSubscriberQuery({filters, search}));
  } catch (error) {
    logger.error('export_subscribers.query.invalid', {args: validatedArgs, error});
    throw error;
  }

  const substack_api = new SubstackApi({
    publication_url: process.env.SUBSTACK_PUBLICATION_URL,
    auth_token: process.env.SUBSTACK_SESSION_TOKEN,
  });

  const set = await substack_api.createSubscriberSet(query);
  logger.info('export_subscribers.set.created', {subscriber_set_id: set?.id ?? null});

  const requested = await substack_api.requestSubscriberSetExport({
    subscriber_set_id: set?.id,
    columns,
  });
  const export_id = requested?.export_id ?? null;
  logger.info('export_subscribers.export.requested', {export_id, columns: columns.length});

  // Polled immediately first — a small export is often already done, and the dashboard's own first
  // wait of a second is pure latency in that case.
  let waited = 0;
  let url = null;

  for (let attempt = 0; ; attempt++) {
    const status = await substack_api.getSubscriberSetExport(export_id);

    if (status?.url) {
      url = status.url;
      break;
    }

    const delay = EXPORT_POLL_BACKOFF_SECONDS[
      Math.min(attempt, EXPORT_POLL_BACKOFF_SECONDS.length - 1)
    ];

    // Refusing rather than overshooting the budget: a tool call that blocks far longer than the
    // caller allowed is worse than one that says where to pick the export up.
    if (waited + delay > max_wait_seconds) {
      logger.warn('export_subscribers.export.timeout', {export_id, waited_seconds: waited});
      throw new Error(
        `Export ${export_id} is not ready after ${waited}s. Retry with a larger max_wait_seconds.`
      );
    }

    logger.debug('export_subscribers.export.pending', {export_id, waited_seconds: waited, next_in: delay});
    await sleep(delay);
    waited += delay;
  }

  logger.info('export_subscribers.export.ready', {export_id, waited_seconds: waited});

  const csv = await substack_api.downloadExport(url);
  const {columns: returned, unmapped, subscribers} = recordsFromCsv(csv);

  // Unsupported columns are dropped by the API with no error at all — `group_membership` and
  // `tag_ids` never come back. Reporting the difference is the only way the caller learns it.
  const missing_columns = columns.filter((column) => !returned.includes(column));

  if (missing_columns.length > 0) {
    logger.warn('export_subscribers.columns.missing', {missing_columns});
  }

  logger.info('export_subscribers.done', {
    export_id,
    count: subscribers.length,
    columns: returned.length,
    missing: missing_columns.length,
    waited_seconds: waited,
  });

  return {
    count: subscribers.length,
    columns: returned,
    // Requested but absent from the file. Empty is the normal case.
    missing_columns,
    // Headers the export sent that are not known columns; kept in the records under their raw label.
    unmapped_columns: unmapped,
    export_id,
    subscribers,
  };
};
