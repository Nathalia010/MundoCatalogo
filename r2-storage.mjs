import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

const indexObject = 'catalogos.json';

export function openR2Storage(env = process.env) {
  const names = ['R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];
  if (names.every(name => !env[name])) return null;
  const missing = names.filter(name => !env[name]);
  if (missing.length) throw new Error(`Completa estas variables de R2: ${missing.join(', ')}.`);

  const endpoint = new URL(env.R2_ENDPOINT);
  const local = endpoint.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(endpoint.hostname);
  if ((!local && endpoint.protocol !== 'https:') || endpoint.pathname !== '/' || endpoint.search || endpoint.hash || endpoint.username || endpoint.password) {
    throw new Error('R2_ENDPOINT debe ser la URL de la API S3, sin la ruta del bucket.');
  }

  const client = new S3Client({
    endpoint: endpoint.href,
    region: 'auto',
    forcePathStyle: true,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY },
  });
  const bucket = env.R2_BUCKET;
  const send = (Command, params) => client.send(new Command({ Bucket: bucket, ...params }), { abortSignal: AbortSignal.timeout(90_000) });

  return {
    async readIndex() {
      try {
        const result = await send(GetObjectCommand, { Key: indexObject });
        const entries = JSON.parse(await result.Body.transformToString());
        if (!Array.isArray(entries) || !result.ETag) throw new Error('El índice de R2 no es válido.');
        return { entries, etag: result.ETag };
      } catch (error) {
        if (error.name === 'NoSuchKey') return { entries: [], etag: null };
        throw error;
      }
    },
    async writeIndex(entries, etag) {
      const result = await send(PutObjectCommand, {
        Key: indexObject,
        Body: JSON.stringify(entries, null, 2),
        ContentType: 'application/json',
        ...(etag ? { IfMatch: etag } : { IfNoneMatch: '*' }),
      });
      return result.ETag;
    },
    async coverKeys() {
      const keys = [];
      let continuation;
      do {
        const result = await send(ListObjectsV2Command, { Prefix: 'pdf/', ContinuationToken: continuation });
        for (const object of result.Contents ?? []) {
          const key = /^pdf\/([a-f0-9-]{36})\.webp$/.exec(object.Key)?.[1];
          if (key) keys.push(key);
        }
        continuation = result.NextContinuationToken;
      } while (continuation);
      return keys;
    },
    async putFile(key, path, metadata) {
      const { size } = await stat(path);
      const file = createReadStream(path);
      try {
        await send(PutObjectCommand, { Key: key, Body: file, ContentLength: size, ContentType: 'application/pdf', Metadata: metadata, IfNoneMatch: '*' });
      } finally {
        file.destroy();
      }
    },
    putCover(key, bytes) {
      return send(PutObjectCommand, { Key: key, Body: bytes, ContentType: 'image/webp' });
    },
    head(key) {
      return send(HeadObjectCommand, { Key: key });
    },
    get(key, range) {
      return send(GetObjectCommand, { Key: key, Range: range });
    },
    remove(key) {
      return send(DeleteObjectCommand, { Key: key });
    },
  };
}
