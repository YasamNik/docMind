import type { Readable } from "node:stream";
import {
  DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, HeadObjectCommand,
  PutObjectCommand, S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import * as v from "valibot";
import { createError } from "../../../../shared/errors/errors.js";
import { defineSetting } from "../../../settings/settings.registry.js";
import type { StorageDriver, StorageDriverDefinition } from "../../storage.types.js";

function isNotFound(error: unknown) {
  const status = (error as { $metadata?: { httpStatusCode?: number } } | undefined)?.$metadata?.httpStatusCode;
  return status === 404;
}

// Keeps a single, boring rule for turning a driver key into the object key stored in
// the bucket: strip a trailing slash off the prefix, strip a leading one off the key,
// join with exactly one. Used by every command and by describeLocation, so a key
// written by put is always the same key read by get.
function fullKey(prefix: string, key: string) {
  const cleanPrefix = prefix.replace(/\/+$/, "");
  const cleanKey = key.replace(/^\/+/, "");
  return cleanPrefix ? `${cleanPrefix}/${cleanKey}` : cleanKey;
}

export function createS3Driver({
  bucket,
  region,
  prefix,
  endpoint,
  client,
}: {
  bucket: string;
  region: string;
  prefix: string;
  // Present means an S3 clone rather than Amazon itself, which describeLocation uses to
  // decide whether a console link can be guessed.
  endpoint?: string;
  client: S3Client;
}): StorageDriver {
  return {
    id: "s3",
    async put({ key, body, mimeType }) {
      // lib-storage decides for itself whether a part-by-part multipart upload is
      // needed. A Node Readable has no known length up front, so it always takes that
      // path here, which is exactly what keeps a large file from being buffered.
      const upload = new Upload({
        client,
        params: { Bucket: bucket, Key: fullKey(prefix, key), Body: body, ContentType: mimeType },
      });
      await upload.done();
      return { key };
    },
    async get({ key }) {
      try {
        const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: fullKey(prefix, key) }));
        return response.Body as Readable;
      } catch (error) {
        if (isNotFound(error)) throw createError({ code: "storage.not_found", message: `No file at key "${key}"`, status: 404 });
        throw error;
      }
    },
    async delete({ key }) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: fullKey(prefix, key) }));
    },
    async exists({ key }) {
      try {
        await client.send(new HeadObjectCommand({ Bucket: bucket, Key: fullKey(prefix, key) }));
        return true;
      } catch (error) {
        if (isNotFound(error)) return false;
        throw error;
      }
    },
    async healthCheck() {
      try {
        await client.send(new HeadBucketCommand({ Bucket: bucket }));
        // HeadBucket only proves the bucket is reachable. A read-only credential would
        // pass that check and then fail on the first real upload, so a probe object is
        // written here to prove the credential can actually write.
        const probeKey = fullKey(prefix, ".docmind-health");
        await client.send(new PutObjectCommand({ Bucket: bucket, Key: probeKey, Body: Buffer.from("ok") }));
        // Cleanup is best effort. A credential that can write but not delete must not
        // turn a successful write check into a reported failure, and the probe object
        // must never survive a single Test click due to a swallowed delete error.
        try {
          await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: probeKey }));
        } catch {
          // Ignored: the write already succeeded, which is what this check reports on.
        }
        return { ok: true, message: `Reachable and writable: s3://${bucket}/${prefix}` };
      } catch (error) {
        return { ok: false, message: `Cannot reach bucket "${bucket}": ${(error as Error).message}` };
      }
    },
    describeLocation({ key }) {
      const objectKey = fullKey(prefix, key);
      // Only Amazon's own console has a URL shape worth guessing. A custom endpoint means
      // R2, B2, MinIO or something else entirely, and each puts its browser UI somewhere
      // different, so the label alone is the honest answer there.
      const url = endpoint ? undefined : `https://s3.console.aws.amazon.com/s3/object/${bucket}?region=${region}&prefix=${objectKey}`;
      return { label: `s3://${bucket}/${objectKey}`, url };
    },
  };
}

export const s3BucketSetting = defineSetting({
  key: "storage.s3.bucket",
  schema: v.pipe(v.string(), v.minLength(1)),
  env: "STORAGE_S3_BUCKET",
  doc: "Name of the bucket DocMind stores files in.",
});

export const s3RegionSetting = defineSetting({
  key: "storage.s3.region",
  schema: v.pipe(v.string(), v.minLength(1)),
  env: "STORAGE_S3_REGION",
  doc: "Bucket region, for example us-east-1. Most S3-compatible providers accept auto or a placeholder here; check the provider guide.",
});

export const s3EndpointSetting = defineSetting({
  key: "storage.s3.endpoint",
  schema: v.union([v.pipe(v.string(), v.url()), v.literal("")]),
  env: "STORAGE_S3_ENDPOINT",
  default: "",
  doc: "Custom S3 endpoint URL. Leave blank for Amazon S3 itself. Required for R2, Backblaze B2 and MinIO.",
});

export const s3AccessKeyIdSetting = defineSetting({
  key: "storage.s3.accessKeyId",
  schema: v.pipe(v.string(), v.minLength(1)),
  env: "STORAGE_S3_ACCESS_KEY_ID",
  secret: true,
  doc: "Access key id for the bucket credential.",
});

export const s3SecretAccessKeySetting = defineSetting({
  key: "storage.s3.secretAccessKey",
  schema: v.pipe(v.string(), v.minLength(1)),
  env: "STORAGE_S3_SECRET_ACCESS_KEY",
  secret: true,
  doc: "Secret access key for the bucket credential.",
});

export const s3PrefixSetting = defineSetting({
  key: "storage.s3.prefix",
  schema: v.string(),
  env: "STORAGE_S3_PREFIX",
  default: "docmind/",
  doc: "Key prefix under which DocMind writes objects, so the bucket can be shared with other applications.",
});

export const s3ForcePathStyleSetting = defineSetting({
  key: "storage.s3.forcePathStyle",
  schema: v.boolean(),
  env: "STORAGE_S3_FORCE_PATH_STYLE",
  default: false,
  doc: "Use path-style addressing (bucket in the URL path rather than the hostname). Required by MinIO and some other clones.",
});

export const s3DriverDefinition: StorageDriverDefinition = {
  id: "s3",
  label: "Amazon S3 (or compatible)",
  settings: [
    s3BucketSetting,
    s3RegionSetting,
    s3EndpointSetting,
    s3AccessKeyIdSetting,
    s3SecretAccessKeySetting,
    s3PrefixSetting,
    s3ForcePathStyleSetting,
  ],
  guide: {
    title: "Store files in an S3 bucket",
    intro: "Works with Amazon S3 itself and with S3-compatible object storage such as Cloudflare R2, Backblaze B2 and MinIO.",
    steps: [
      {
        text: "Create a bucket for DocMind's files, or pick an existing one, and note its name and region.",
      },
      {
        text: "Create an access key with only the permissions DocMind needs. Attach this policy to the key, scoped to your bucket:",
        copyValue: JSON.stringify(
          {
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"],
                Resource: ["arn:aws:s3:::YOUR-BUCKET", "arn:aws:s3:::YOUR-BUCKET/*"],
              },
            ],
          },
          null,
          2,
        ),
      },
      {
        text: "Enter the bucket, region, access key id and secret access key below. Leave the endpoint blank for Amazon S3.",
      },
      {
        text: "Using Cloudflare R2: region auto, endpoint https://<account id>.r2.cloudflarestorage.com, leave path style off.",
        link: "https://developers.cloudflare.com/r2/api/s3/api/",
      },
      {
        text: "Using Backblaze B2: region matches the bucket's region code, for example us-west-004, endpoint https://s3.<region>.backblazeb2.com, leave path style off.",
        link: "https://www.backblaze.com/docs/cloud-storage-s3-compatible-api",
      },
      {
        text: "Using MinIO: region can be any non-empty value such as us-east-1, endpoint is your MinIO server URL, turn path style on.",
        link: "https://min.io/docs/minio/linux/developers/javascript/API.html",
      },
      {
        text: "Click Test to confirm DocMind can reach and write to the bucket before switching to it.",
      },
    ],
    notes: [
      "DocMind never buffers a whole file in memory: uploads and downloads stream to and from the bucket.",
      "The prefix lets the bucket be shared with other applications without key collisions. Change it before the first upload, not after.",
    ],
  },
  async create({ settings, userId }) {
    const bucket = await settings.get<string>(userId, "storage.s3.bucket");
    const region = await settings.get<string>(userId, "storage.s3.region");
    const endpoint = await settings.get<string>(userId, "storage.s3.endpoint");
    const accessKeyId = await settings.get<string>(userId, "storage.s3.accessKeyId");
    const secretAccessKey = await settings.get<string>(userId, "storage.s3.secretAccessKey");
    const prefix = (await settings.get<string>(userId, "storage.s3.prefix")) ?? "docmind/";
    const forcePathStyle = (await settings.get<boolean>(userId, "storage.s3.forcePathStyle")) ?? false;

    if (!bucket || !region || !accessKeyId || !secretAccessKey) {
      throw createError({
        code: "storage.driver_not_configured",
        message: "The S3 driver needs a bucket, region, access key id and secret access key before it can be used.",
        status: 400,
      });
    }

    const client = new S3Client({
      region,
      endpoint: endpoint || undefined,
      forcePathStyle,
      credentials: { accessKeyId, secretAccessKey },
    });

    return createS3Driver({ bucket, region, prefix, endpoint: endpoint || undefined, client });
  },
};
