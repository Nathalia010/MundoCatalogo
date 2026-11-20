import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { renderPdfCover } from '../cover.mjs';
import { openR2Storage } from '../r2-storage.mjs';

const storage = openR2Storage();
if (!storage) throw new Error('Completa .env.r2 con las cuatro variables de Cloudflare R2.');

const backup = resolve(process.argv[2] ?? 'data/r2-backup/index.json');
const records = JSON.parse((await readFile(backup, 'utf8')).replace(/^\uFEFF/, ''));
if (!Array.isArray(records) || !records.length) throw new Error('El respaldo debe incluir al menos un PDF.');
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const sources = records.map(record => {
  const key = record.key ?? /^\/catalogos\/([a-f0-9-]{36})\.pdf$/.exec(record.url)?.[1];
  if (!uuid.test(record.id) || !uuid.test(key) || typeof record.title !== 'string' || !record.title.trim()) {
    throw new Error('El respaldo contiene un catálogo inválido.');
  }
  const file = resolve(dirname(backup), record.file ?? join('pdf', `${key}.pdf`));
  return { entry: { id: record.id, key, title: record.title }, file, bytes: record.bytes };
});
const entries = sources.map(source => source.entry);
if (new Set(entries.map(entry => entry.key)).size !== entries.length || new Set(entries.map(entry => entry.id)).size !== entries.length) {
  throw new Error('El respaldo tiene catálogos duplicados.');
}

const remote = await storage.readIndex();
const order = items => JSON.stringify(items.map(({ id, key, title }) => [id, key, title]));
if (remote.etag && order(remote.entries) !== order(entries)) {
  throw new Error('R2 ya contiene un catálogo distinto. No se cambió el índice existente.');
}

async function sha256(stream) {
  const hash = createHash('sha256');
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

const covers = new Set(await storage.coverKeys());
for (const { entry, file, bytes } of sources) {
  const { size } = await stat(file);
  if (size < 8 || size > 100_000_000 || (bytes !== undefined && bytes !== size)) {
    throw new Error(`Tamaño de respaldo inesperado para ${entry.title}.`);
  }
  const localHash = await sha256(createReadStream(file));
  const key = `pdf/${entry.key}.pdf`;
  let stored;
  try {
    stored = await storage.head(key);
  } catch (error) {
    if (error.$metadata?.httpStatusCode !== 404) throw error;
    await storage.putFile(key, file, { sha256: localHash });
    stored = await storage.head(key);
  }
  if (stored.ContentLength !== size) {
    throw new Error(`El PDF en R2 no coincide con el respaldo de ${entry.title}.`);
  }
  const storedHash = stored.Metadata?.sha256 ?? await sha256((await storage.get(key)).Body);
  if (storedHash !== localHash) {
    throw new Error(`El PDF en R2 no coincide con el respaldo de ${entry.title}.`);
  }
  if (!covers.has(entry.key)) {
    try {
      await storage.putCover(`pdf/${entry.key}.webp`, await renderPdfCover(file));
    } catch (error) {
      console.warn(`Portada pendiente para ${entry.title}. Se generará al iniciar el sitio.`);
    }
  }
  console.log(`Verificado en R2: ${entry.title}`);
}

if (!remote.etag) await storage.writeIndex(entries, null);
const migrated = await storage.readIndex();
if (order(migrated.entries) !== order(entries)) throw new Error('No se pudo verificar el orden en R2.');
console.log(`${entries.length} PDF guardados en R2 en su orden original.`);
