import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';

const assets = resolve('node_modules/pdfjs-dist');

async function renderCover(path) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({
    url: pathToFileURL(path),
    cMapUrl: `${resolve(assets, 'cmaps')}/`,
    standardFontDataUrl: `${resolve(assets, 'standard_fonts')}/`,
    iccUrl: `${resolve(assets, 'iccs')}/`,
    wasmUrl: `${resolve(assets, 'wasm')}/`,
    disableStream: true,
    disableAutoFetch: true,
    isEvalSupported: false,
  });
  try {
    const pdf = await task.promise;
    const page = await pdf.getPage(1);
    const original = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(816 / original.width, 1120 / original.height) });
    const { canvas } = pdf.canvasFactory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
    await page.render({ canvas, viewport }).promise;
    return await canvas.encode('webp', 80);
  } finally {
    await task.destroy();
  }
}

parentPort.postMessage(await renderCover(workerData));
