import {z} from "zod";
import SubstackApi from "../api/substack/SubstackApi.js";
import {fetchImageAsDataUri, defaultLookup, isPrivateAddress, MAX_IMAGE_BYTES} from "../api/substack/image.js";
import {logger} from "../logger.js";

// Re-exported, not redefined: `upload_image.spec.js` imports both from here, and the pipeline they
// belong to now lives in `src/api/substack/image.js` because `update_draft` needs it too.
export {isPrivateAddress, MAX_IMAGE_BYTES};

// strictObject: an unknown key is reported, never stripped — the only repair signal an LLM gets.
export const uploadImageSchema = z.strictObject({
  url: z
    .string()
    .url()
    .describe(
      "The http(s) URL of an image to upload. The server downloads it and re-hosts it on Substack. " +
        "Private, loopback and link-local hosts are refused. Max 10 MB. HEIC is not accepted."
    ),
  post_id: z
    .number()
    .optional()
    .describe("Optional id of the post the image belongs to. Its effect is unconfirmed."),
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
  const {url, post_id} = validatedArgs;

  logger.info('upload_image.fetching', {url, post_id: post_id ?? null});
  const {image, contentType, bytes} = await fetchImageAsDataUri(url, {lookup, fetchImpl});

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
