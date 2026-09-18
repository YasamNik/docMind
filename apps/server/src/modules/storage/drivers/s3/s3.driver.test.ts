import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  CompleteMultipartUploadCommand, CreateMultipartUploadCommand, DeleteObjectCommand,
  GetObjectCommand, HeadBucketCommand, HeadObjectCommand, PutObjectCommand, UploadPartCommand,
} from "@aws-sdk/client-s3";
import { runDriverContractTests } from "../driver-contract.test-utils.js";
import { createS3Driver } from "./s3.driver.js";

// An in-memory S3 that speaks the subset lib-storage actually uses. Keyed by the full
// object key, so the driver's prefix handling is exercised rather than mocked away.
function createFakeS3() {
  const objects = new Map<string, Buffer>();
  const uploads = new Map<string, Buffer[]>();
  let nextUploadId = 1;

  const send = async (command: unknown) => {
    if (command instanceof CreateMultipartUploadCommand) {
      const uploadId = `upload-${nextUploadId++}`;
      uploads.set(uploadId, []);
      return { UploadId: uploadId };
    }
    if (command instanceof UploadPartCommand) {
      const { UploadId, PartNumber, Body } = command.input;
      const parts = uploads.get(UploadId!)!;
      parts[PartNumber! - 1] = Buffer.from(Body as Uint8Array);
      return { ETag: `"etag-${PartNumber}"` };
    }
    if (command instanceof CompleteMultipartUploadCommand) {
      const { UploadId, Key } = command.input;
      objects.set(Key!, Buffer.concat(uploads.get(UploadId!)!));
      uploads.delete(UploadId!);
      return {};
    }
    if (command instanceof PutObjectCommand) {
      const { Key, Body } = command.input;
      objects.set(Key!, Buffer.from(Body as Uint8Array));
      return {};
    }
    if (command instanceof GetObjectCommand) {
      const body = objects.get(command.input.Key!);
      if (!body) throw Object.assign(new Error("NoSuchKey"), { $metadata: { httpStatusCode: 404 } });
      return { Body: Readable.from([body]) };
    }
    if (command instanceof HeadObjectCommand) {
      if (!objects.has(command.input.Key!)) throw Object.assign(new Error("NotFound"), { $metadata: { httpStatusCode: 404 } });
      return { ContentLength: objects.get(command.input.Key!)!.length };
    }
    if (command instanceof DeleteObjectCommand) {
      objects.delete(command.input.Key!);
      return {};
    }
    if (command instanceof HeadBucketCommand) return {};
    throw new Error(`Fake S3 received an unhandled command: ${(command as object).constructor.name}`);
  };

  // The installed @aws-sdk/lib-storage sends a body that fits in one part through a
  // plain PutObject rather than always through multipart, and to do that it reads two
  // more properties off client.config that a bare { send, config: { region } } does not
  // provide: an endpoint function, used to build the Location it returns, and
  // requestChecksumCalculation, used to decide whether to add a checksum on the create
  // call. Both are read straight off config rather than sent as commands, so the fake
  // needs them regardless of which upload path a given body takes.
  return {
    objects,
    client: {
      send,
      config: {
        region: async () => "auto",
        endpoint: async () => ({ protocol: "https:", hostname: "fake-s3.test" }),
        requestChecksumCalculation: async () => "WHEN_REQUIRED",
      },
    } as never,
  };
}

const { client } = createFakeS3();
runDriverContractTests("s3", async () => createS3Driver({ bucket: "docs", region: "auto", prefix: "docmind/", client }));

describe("s3 driver extras", () => {
  it("describes a key as an s3 url including the prefix", () => {
    const driver = createS3Driver({ bucket: "docs", region: "auto", prefix: "docmind/", client });
    expect(driver.describeLocation({ key: "user_1/a.pdf" }).label).toBe("s3://docs/docmind/user_1/a.pdf");
  });

  it("round trips a body larger than one multipart chunk", async () => {
    const driver = createS3Driver({ bucket: "docs", region: "auto", prefix: "docmind/", client });
    const big = Buffer.alloc(6 * 1024 * 1024, "x");
    await driver.put({ key: "big.bin", body: Readable.from([big]) });
    const chunks: Buffer[] = [];
    for await (const c of await driver.get({ key: "big.bin" })) chunks.push(Buffer.from(c));
    expect(Buffer.concat(chunks).length).toBe(big.length);
  });
});
