import {z} from "zod";
import SubstackApi from "../api/substack/SubstackApi.js";
import {
  fetchImageAsDataUri,
  readImageFileAsDataUri,
  defaultLookup,
  isPrivateAddress,
  MAX_IMAGE_BYTES,
} from "../api/substack/image.js";
import {logger} from "../logger.js";

// Re-exported, not redefined: `upload_image.spec.js` imports both from here, and the pipeline they
// belong to now lives in `src/api/substack/image.js` because `update_draft` needs it too.
export {isPrivateAddress, MAX_IMAGE_BYTES};

// Two sources, exactly one per call. The `.superRefine` below is the runtime half of that rule; the
// other half is written into both descriptions, because a refinement does NOT survive into the
// published JSON Schema — a model reading tools/list would otherwise meet the rule only by breaking
// it. Same reasoning as the one-paywall rule in `document.js`.
//
// strictObject: an unknown key is reported, never stripped — the only repair signal an LLM gets.
export const uploadImageSchema = z
  .strictObject({
    url: z
      .string()
      .url()
      .optional()
      .describe(
        "The http(s) URL of an image to upload. The server downloads it and re-hosts it on Substack. " +
          "Private, loopback and link-local hosts are refused. Max 10 MB. HEIC is not accepted. " +
          "Provide exactly one of `url` or `path`."
      ),
    path: z
      .string()
      .optional()
      .describe(
        "Absolute path to an image file on the machine running this server, read directly from disk " +
          "with no download. Use this for a locally generated or edited image. The path must be " +
          "absolute — a relative one would resolve against the server's working directory, not the " +
          "caller's. The type is detected from the file's contents, not its extension: PNG, JPEG, " +
          "GIF and WebP are accepted, HEIC is not. Max 10 MB. " +
          "Provide exactly one of `url` or `path`."
      ),
    post_id: z
      .number()
      .optional()
      .describe("Optional id of the post the image belongs to. Its effect is unconfirmed."),
  })
  .superRefine((value, ctx) => {
    if ((value.url === undefined) === (value.path === undefined)) {
      ctx.addIssue({
        code: "custom",
        message: "Provide exactly one of `url` (to download an image) or `path` (to read a local file).",
      });
    }
  });

export const uploadImageHandler = async (args, {lookup = defaultLookup, fetchImpl = fetch} = {}) => {
  logger.debug('upload_image.start', {args});

  let validatedArgs;
  try {
    validatedArgs = uploadImageSchema.parse(args);
  } catch (error) {
    logger.error('upload_image.args.invalid', {issues: error.issues ?? error.message});
    throw error;
  }
  const {url, path: filePath, post_id} = validatedArgs;

  // The intent line goes out before either source is touched, so a read or download that throws
  // still leaves a record of what was attempted.
  let source;
  if (filePath !== undefined) {
    logger.info('upload_image.reading', {path: filePath, post_id: post_id ?? null});
    source = await readImageFileAsDataUri(filePath);
  } else {
    logger.info('upload_image.fetching', {url, post_id: post_id ?? null});
    source = await fetchImageAsDataUri(url, {lookup, fetchImpl});
  }
  const {image, contentType, bytes} = source;

  // The data URI is deliberately NOT logged: hundreds of KB of base64 would bury the session. This
  // is the one exception to "post content is not truncated".
  logger.info('upload_image.uploading', {content_type: contentType, bytes, post_id: post_id ?? null});

  const substack_api = new SubstackApi({
    publication_url: process.env.SUBSTACK_PUBLICATION_URL,
    auth_token: process.env.SUBSTACK_SESSION_TOKEN,
  });
  const uploaded = await substack_api.uploadImage({image, post_id: post_id ?? null});

  logger.info('upload_image.done', {url: uploaded.url, bytes: uploaded.bytes});

  return {
    id: uploaded.id,
    url: uploaded.url,
    content_type: uploaded.contentType,
    bytes: uploaded.bytes,
    width: uploaded.imageWidth,
    height: uploaded.imageHeight,
  };
};
