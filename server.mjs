import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { randomBytes, randomUUID, scrypt as deriveKey, timingSafeEqual } from 'node:crypto';
import { resolve, join } from 'node:path';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream/promises';
import { Worker } from 'node:worker_threads';

const scrypt = promisify(deriveKey);
const storage = resolve(process.env.DATA_DIR || 'data');
const files = join(storage, 'pdf');
const indexFile = join(storage, 'catalogos.json');
const maxPdfSize = 100_000_000;
const sessionDuration = 8 * 60 * 60 * 1000;
const attemptWindow = 15 * 60 * 1000;
const secureCookie = process.env.SECURE_COOKIE === '1' ? '; Secure' : '';
const admin = process.env.ADMIN_USER || 'AdminTenshi';
const [salt, hash] = (process.env.ADMIN_PASSWORD_HASH || '').split(':');
const expectedHash = /^[a-f0-9]{128}$/.test(hash || '') && /^[a-f0-9]{32}$/.test(salt || '')
  ? Buffer.from(hash, 'hex') : null;
if (!expectedHash) throw new Error('Configura ADMIN_PASSWORD_HASH en .env. Consulta el README.');

await mkdir(files, { recursive: true });
let catalogs;
try {
  catalogs = JSON.parse(await readFile(indexFile, 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  catalogs = [];
}

const availableCovers = new Set((await readdir(files)).filter(name => name.endsWith('.webp')).map(name => name.slice(0, -5)));
let pendingCover = Promise.resolve();

function renderCover(path) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./cover.mjs', import.meta.url), { workerData: path });
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', code => reject(new Error(`La portada no está disponible (código ${code}).`)));
  });
}

function queueCover(key) {
  pendingCover = pendingCover.then(async () => {
    if (availableCovers.has(key) || !catalogs.some(entry => entry.key === key)) return;
    const temp = join(files, `${key}.cover`);
    try {
      const data = await renderCover(join(files, `${key}.pdf`));
      if (!catalogs.some(entry => entry.key === key)) return;
      await writeFile(temp, data);
      await rename(temp, join(files, `${key}.webp`));
      if (catalogs.some(entry => entry.key === key)) availableCovers.add(key);
      else await unlink(join(files, `${key}.webp`)).catch(() => {});
    } catch (error) {
      console.warn(`No se pudo generar una portada: ${error.message}`);
      await unlink(temp).catch(() => {});
    }
  });
}

const sessions = new Map();
const attempts = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [token, expires] of sessions) if (expires <= now) sessions.delete(token);
  for (const [address, attempt] of attempts) if (attempt.expires <= now) attempts.delete(address);
}, 60_000).unref();

let pendingUpdate = Promise.resolve();
function updateCatalogs(change) {
  const next = pendingUpdate.then(async () => {
    const { entries, added, replaced } = change(catalogs);
    const temp = join(storage, `${randomUUID()}.tmp`);
    try {
      if (added) await rename(added.stagedPath, join(files, `${added.key}.pdf`));
      await writeFile(temp, JSON.stringify(entries, null, 2), { flag: 'wx' });
      await rename(temp, indexFile);
    } catch (error) {
      await unlink(temp).catch(() => {});
      if (added) await unlink(join(files, `${added.key}.pdf`)).catch(() => {});
      throw error;
    }
    catalogs = entries;
    if (replaced) {
      availableCovers.delete(replaced.key);
      await Promise.all(['pdf', 'webp'].map(extension => unlink(join(files, `${replaced.key}.${extension}`)).catch(() => {})));
    }
    if (added) queueCover(added.key);
    return entries;
  });
  pendingUpdate = next.catch(() => {});
  return next;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function readBody(req, limit) {
  if (Number(req.headers['content-length']) > limit) throw new HttpError(413, 'El archivo supera el tamaño permitido.');
  let size = 0;
  const chunks = [];
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'El archivo supera el tamaño permitido.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const body = await readBody(req, 64 * 1024);
  try {
    return JSON.parse(body);
  } catch {
    throw new HttpError(400, 'No se pudieron leer los datos enviados.');
  }
}

async function stagePdf(req, path) {
  const tooLarge = () => new HttpError(413, `El PDF supera los ${maxPdfSize / 1_000_000} MB.`);
  if (Number(req.headers['content-length']) > maxPdfSize) throw tooLarge();
  const file = await open(path, 'wx');
  const signature = Buffer.alloc(8);
  let size = 0;
  try {
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      const previousSize = size;
      size += chunk.length;
      if (size > maxPdfSize) throw tooLarge();
      if (previousSize < signature.length) {
        chunk.copy(signature, previousSize, 0, signature.length - previousSize);
        if (size >= signature.length && !/^%PDF-\d\.\d$/.test(signature.toString('ascii'))) {
          throw new HttpError(400, 'El archivo no parece ser un PDF válido.');
        }
      }
      await file.writeFile(chunk);
    }
    if (size < signature.length) throw new HttpError(400, 'El archivo no parece ser un PDF válido.');
  } finally {
    await file.close();
  }
}

const assets = new Map([
  ['/', ['public/index.html', 'text/html; charset=utf-8']],
  ['/bootstrap.min.css', ['node_modules/bootstrap/dist/css/bootstrap.min.css', 'text/css; charset=utf-8']],
  ['/styles.css', ['public/styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['public/app.js', 'text/javascript; charset=utf-8']],
  ['/pdfjs/pdf.mjs', ['node_modules/pdfjs-dist/build/pdf.mjs', 'text/javascript; charset=utf-8']],
  ['/pdfjs/pdf.worker.mjs', ['node_modules/pdfjs-dist/build/pdf.worker.mjs', 'text/javascript; charset=utf-8']],
]);

async function streamFile(req, res, path, type, pdf = false, cacheControl = 'no-cache') {
  const { size } = await stat(path);
  let start = 0;
  let end = size - 1;
  const headers = { 'Content-Type': type, 'Cache-Control': cacheControl };
  const range = pdf && req.headers.range;
  if (pdf) headers['Accept-Ranges'] = 'bytes';
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (match?.[1]) {
      start = Number(match[1]);
      if (match[2]) end = Math.min(Number(match[2]), end);
    } else if (match?.[2]) {
      start = Math.max(0, size - Number(match[2]));
    } else {
      start = size;
    }
    if (start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      res.end();
      return;
    }
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  headers['Content-Length'] = end - start + 1;
  res.writeHead(range ? 206 : 200, headers);
  if (req.method === 'HEAD' || size === 0) res.end();
  else await pipeline(createReadStream(path, { start, end }), res);
}

function publicEntries(entries) {
  return entries.map(({ id, title, key }) => ({
    id, title, url: `/catalogos/${key}.pdf`,
    cover: availableCovers.has(key) ? `/catalogos/${key}.webp` : null,
  }));
}

async function handle(req, res) {
  const { pathname } = new URL(req.url, 'http://localhost');
  const method = req.method;
  const token = /(?:^|;\s*)catalog_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
  const signedIn = (sessions.get(token) || 0) > Date.now();
  const isRead = method === 'GET' || method === 'HEAD';

  if (isRead && assets.has(pathname)) return streamFile(req, res, ...assets.get(pathname));
  const pdfAsset = /^\/pdfjs\/(cmaps|standard_fonts|wasm|iccs)\/[\w.-]+\.(?:bcmap|pfb|ttf|wasm|js|icc)$/.test(pathname);
  if (isRead && pdfAsset) {
    const type = pathname.endsWith('.wasm') ? 'application/wasm' : pathname.endsWith('.js') ? 'text/javascript' : 'application/octet-stream';
    return streamFile(req, res, `node_modules/pdfjs-dist/${pathname.slice('/pdfjs/'.length)}`, type);
  }
  const pdf = /^\/catalogos\/([a-f0-9-]{36})\.pdf$/.exec(pathname);
  if (isRead && pdf && catalogs.some(entry => entry.key === pdf[1])) {
    return streamFile(req, res, join(files, `${pdf[1]}.pdf`), 'application/pdf', true);
  }
  const cover = /^\/catalogos\/([a-f0-9-]{36})\.webp$/.exec(pathname);
  if (isRead && cover && availableCovers.has(cover[1]) && catalogs.some(entry => entry.key === cover[1])) {
    return streamFile(req, res, join(files, `${cover[1]}.webp`), 'image/webp', false, 'public, max-age=86400');
  }
  if (method === 'GET' && pathname === '/api/session') return sendJson(res, 200, { signedIn });
  if (method === 'GET' && pathname === '/api/catalogos') return sendJson(res, 200, publicEntries(catalogs));
  if (isRead || !pathname.startsWith('/api/')) throw new HttpError(404, 'No encontramos esta página.');
  if (req.headers['x-catalog-action'] !== '1') throw new HttpError(403, 'Solicitud no permitida.');

  if (method === 'POST' && pathname === '/api/session') {
    const input = await readJson(req);
    if (typeof input?.password !== 'string' || input.password.length > 256) {
      throw new HttpError(400, 'Ingresa una contraseña válida.');
    }
    const address = req.socket.remoteAddress;
    const previous = attempts.get(address);
    const now = Date.now();
    const attempt = previous?.expires > now ? previous : { count: 0, expires: now + attemptWindow };
    if (attempt.count >= 8) throw new HttpError(429, 'Demasiados intentos. Vuelve a intentarlo en unos minutos.');
    attempt.count += 1;
    attempts.set(address, attempt);
    const actualHash = await scrypt(input.password, salt, expectedHash.length);
    if (!timingSafeEqual(actualHash, expectedHash) || input.user !== admin) {
      throw new HttpError(401, 'Usuario o contraseña incorrectos.');
    }
    attempts.delete(address);
    sessions.delete(token);
    const newToken = randomBytes(32).toString('hex');
    sessions.set(newToken, now + sessionDuration);
    res.setHeader('Set-Cookie', `catalog_session=${newToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionDuration / 1000}${secureCookie}`);
    return sendJson(res, 200, { signedIn: true });
  }
  if (method === 'DELETE' && pathname === '/api/session') {
    sessions.delete(token);
    res.setHeader('Set-Cookie', `catalog_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureCookie}`);
    return sendJson(res, 200, { signedIn: false });
  }
  if (!signedIn) throw new HttpError(401, 'Inicia sesión para administrar los catálogos.');

  if (method === 'PUT' && pathname === '/api/catalogos/orden') {
    const order = await readJson(req);
    const entries = await updateCatalogs(current => {
      const byId = new Map(current.map(entry => [entry.id, entry]));
      if (!Array.isArray(order) || order.length !== current.length || new Set(order).size !== order.length || !order.every(id => byId.has(id))) {
        throw new HttpError(409, 'La lista cambió. Actualiza la página y vuelve a intentarlo.');
      }
      return { entries: order.map(id => byId.get(id)) };
    });
    return sendJson(res, 200, publicEntries(entries));
  }

  const replacement = /^\/api\/catalogos\/([a-f0-9-]{36})$/.exec(pathname);
  if ((method === 'POST' && pathname === '/api/catalogos') || (method === 'PUT' && replacement)) {
    if (req.headers['content-type'] !== 'application/pdf') throw new HttpError(415, 'Selecciona un archivo PDF.');
    let title;
    try {
      title = Array.from(decodeURIComponent(req.headers['x-catalog-title'] || '').trim()).slice(0, 120).join('');
    } catch {
      throw new HttpError(400, 'El nombre del catálogo no es válido.');
    }
    const key = randomUUID();
    const stagedPath = join(files, `${key}.upload`);
    try {
      await stagePdf(req, stagedPath);
      const entries = await updateCatalogs(current => {
        const existing = replacement && current.find(entry => entry.id === replacement[1]);
        if (replacement && !existing) throw new HttpError(404, 'Este catálogo ya no está disponible.');
        const entry = { id: existing?.id || randomUUID(), key, title: title || existing?.title || 'Catálogo' };
        return {
          entries: existing ? current.map(item => item.id === entry.id ? entry : item) : [...current, entry],
          added: { key, stagedPath },
          replaced: existing,
        };
      });
      return sendJson(res, replacement ? 200 : 201, publicEntries(entries));
    } finally {
      await unlink(stagedPath).catch(() => {});
    }
  }
  throw new HttpError(404, 'No encontramos esta página.');
}

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3000);
createServer((req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data: blob:; font-src 'self' blob: data:; object-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'self'");
  handle(req, res).catch(error => {
    if (res.headersSent || res.destroyed) return res.destroy();
    req.resume();
    const status = error.status || (error.code === 'ENOENT' ? 404 : 500);
    if (status === 500) console.error(error);
    sendJson(res, status, { error: error.status ? error.message : status === 404 ? 'Archivo no disponible.' : 'Ocurrió un error. Vuelve a intentarlo.' });
  });
}).listen(port, host, () => {
  console.log(`Mundo Catálogo · http://${host}:${port}`);
  catalogs.forEach(({ key }) => queueCover(key));
});
