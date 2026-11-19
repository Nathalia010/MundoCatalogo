const $ = selector => document.querySelector(selector);
const catalogs = $('#catalogs');
const admin = $('#admin');
const adminList = $('#admin-list');
const adminStatus = $('#admin-status');
const sessionButton = $('#session-button');
const sessionLabel = $('#session-label');
const mobileReader = matchMedia('(max-width: 767.98px)');
const fullscreenReader = $('#fullscreen-reader');
const loginDialog = $('#login-dialog');
const loginForm = $('#login-form');
const uploadDialog = $('#upload-dialog');
const uploadForm = $('#upload-form');
const positionDialog = $('#position-dialog');
const positionSelect = $('#position-select');
const removeDialog = $('#remove-dialog');
const removeForm = $('#remove-form');
const readers = new Map();
let entries = [];
let signedIn = false;
let listLoaded = false;
let replacing = null;
let removing = null;
let pdfModule;
let thumbnailObserver;
let positioning;
let drag;
let suppressDragClick = false;

function getPdfModule() {
  pdfModule ??= import('/pdfjs/pdf.mjs').then(module => {
    module.GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.mjs';
    return module;
  });
  return pdfModule;
}

const pdfOptions = {
  cMapUrl: '/pdfjs/cmaps/',
  cMapPacked: true,
  iccUrl: '/pdfjs/iccs/',
  standardFontDataUrl: '/pdfjs/standard_fonts/',
  wasmUrl: '/pdfjs/wasm/',
  isEvalSupported: false,
};

async function request(path, { method = 'GET', headers, body } = {}) {
  const response = await fetch(path, { method, body, headers: {
    ...headers, ...(method === 'GET' ? {} : { 'X-Catalog-Action': '1' }),
  } });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || 'No pudimos completar la solicitud.');
    error.status = response.status;
    throw error;
  }
  return data;
}

function setStatus(element, message, error = false) {
  element.textContent = message;
  element.classList.toggle('error', error);
}

function openFullscreen(stage, resetZoom) {
  if (fullscreenReader.open) return;
  const anchor = document.createElement('div');
  anchor.style.height = `${stage.getBoundingClientRect().height}px`;
  stage.before(anchor);
  fullscreenReader.append(stage);
  let nativeFullscreen = false;
  const events = new AbortController();
  document.addEventListener('fullscreenchange', () => {
    if (document.fullscreenElement === stage) nativeFullscreen = true;
    else if (nativeFullscreen && fullscreenReader.open) fullscreenReader.close();
  }, { signal: events.signal });
  fullscreenReader.addEventListener('close', () => {
    events.abort();
    if (document.fullscreenElement === stage) document.exitFullscreen().catch(() => {});
    resetZoom();
    anchor.replaceWith(stage);
    stage.focus({ preventScroll: true });
  }, { once: true });
  fullscreenReader.showModal();
  stage.querySelector('.fullscreen-grip').focus({ preventScroll: true });
  if (document.fullscreenEnabled) stage.requestFullscreen?.().catch(() => {});
}

function installReaderZoom(stage, frame, book, cover, turn, redraw) {
  const grip = stage.querySelector('.fullscreen-grip');
  const pointers = new Map();
  const maxScale = 4;
  let scale = 1;
  let x = 0;
  let y = 0;
  let press;
  let lastTap;
  let detailTimer;
  let gripPress;

  const isOpen = () => fullscreenReader.open && fullscreenReader.contains(stage);
  const page = () => !book.hidden ? book : !cover.hidden ? cover : null;
  const clamp = (value, low, high) => Math.max(low, Math.min(value, high));

  function paint() {
    frame.style.setProperty('--zoom-scale', String(scale));
    frame.style.setProperty('--zoom-x', `${x}px`);
    frame.style.setProperty('--zoom-y', `${y}px`);
    frame.classList.toggle('is-zoomed', scale > 1);
  }

  function place(level, left, top) {
    const content = page();
    if (!content) return;
    if (level === 1) {
      scale = 1;
      x = y = 0;
      paint();
      return;
    }
    const viewport = frame.getBoundingClientRect();
    const rect = content.getBoundingClientRect();
    const limit = (offset, origin, size, start, end) => {
      const near = start - origin;
      const far = end - origin - size;
      return clamp(offset, Math.min(near, far), Math.max(near, far));
    };
    x = limit(left, rect.left - x, rect.width / scale * level, viewport.left, viewport.right);
    y = limit(top, rect.top - y, rect.height / scale * level, viewport.top, viewport.bottom);
    scale = level;
    paint();
  }

  function zoomAt(level, from, to = from) {
    const content = page();
    if (!content) return;
    const rect = content.getBoundingClientRect();
    const target = clamp(level, 1, maxScale);
    const factor = target / scale;
    place(target, x + (to.x - rect.left) - (from.x - rect.left) * factor,
      y + (to.y - rect.top) - (from.y - rect.top) * factor);
  }

  function scheduleDetail() {
    clearTimeout(detailTimer);
    detailTimer = setTimeout(() => {
      if (isOpen()) redraw(scale);
    }, 140);
  }

  function changeScale(level) {
    const viewport = frame.getBoundingClientRect();
    zoomAt(level, { x: (viewport.left + viewport.right) / 2, y: (viewport.top + viewport.bottom) / 2 });
    scheduleDetail();
  }

  function reset() {
    clearTimeout(detailTimer);
    pointers.clear();
    press = lastTap = null;
    scale = 1;
    x = y = 0;
    paint();
  }

  stage.addEventListener('keydown', event => {
    if (!isOpen() || event.ctrlKey || event.metaKey || event.altKey) return;
    if (!['+', '=', '-', '0'].includes(event.key)) return;
    event.preventDefault();
    changeScale(event.key === '0' ? 1 : event.key === '-' ? scale / 1.4 : scale * 1.4);
  });
  frame.addEventListener('wheel', event => {
    if (!isOpen() || !page() || !event.deltaY) return;
    event.preventDefault();
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? frame.clientHeight : 1);
    zoomAt(scale * Math.exp(-delta / 360), { x: event.clientX, y: event.clientY });
    scheduleDetail();
  }, { passive: false });

  const position = event => ({ x: event.clientX, y: event.clientY });
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const midpoint = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const swipedDown = (dx, dy) => dy >= 60 && dy > Math.abs(dx) * 1.3;

  grip.addEventListener('click', () => { if (isOpen()) fullscreenReader.close(); });
  grip.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !event.isPrimary) return;
    gripPress = { id: event.pointerId, ...position(event) };
    grip.setPointerCapture(event.pointerId);
  });
  grip.addEventListener('pointerup', event => {
    if (gripPress?.id !== event.pointerId) return;
    const down = swipedDown(event.clientX - gripPress.x, event.clientY - gripPress.y);
    gripPress = null;
    if (down && isOpen()) fullscreenReader.close();
  });
  grip.addEventListener('lostpointercapture', () => { gripPress = null; });

  frame.addEventListener('pointerdown', event => {
    if (!isOpen() || !page() || event.button !== 0 || pointers.size >= 2) return;
    const point = position(event);
    pointers.set(event.pointerId, point);
    frame.setPointerCapture(event.pointerId);
    if (pointers.size === 1) press = { point, canTurn: scale === 1, canTap: true };
    else press = lastTap = null;
  });

  frame.addEventListener('pointermove', event => {
    const previous = pointers.get(event.pointerId);
    if (!previous) return;
    const point = position(event);
    pointers.set(event.pointerId, point);
    if (pointers.size === 2) {
      const other = [...pointers.values()].find(value => value !== point);
      const before = Math.max(12, distance(previous, other));
      const after = Math.max(12, distance(point, other));
      zoomAt(scale * after / before, midpoint(previous, other), midpoint(point, other));
    } else if (scale > 1) place(scale, x + point.x - previous.x, y + point.y - previous.y);
  });

  function endPointer(event) {
    if (!pointers.delete(event.pointerId)) return;
    if (pointers.size) {
      press = { point: pointers.values().next().value, canTurn: false, canTap: false };
      return;
    }
    if (event.type === 'pointerup' && press) {
      const point = position(event);
      const dx = point.x - press.point.x;
      const dy = point.y - press.point.y;
      if (press.canTurn && scale === 1 && swipedDown(dx, dy)) {
        fullscreenReader.close();
      } else if (press.canTurn && scale === 1 && Math.abs(dx) >= 32 && Math.abs(dx) > Math.abs(dy) * 1.25) {
        turn(dx < 0 ? 1 : -1);
      } else if (press.canTap && distance(point, press.point) < 12) {
        const time = performance.now();
        if (lastTap && time - lastTap.time < 320 && distance(lastTap.point, point) < 34) {
          zoomAt(scale > 1 ? 1 : 2.5, point);
          lastTap = null;
        } else lastTap = { time, point };
      } else lastTap = null;
    }
    press = null;
    scheduleDetail();
  }

  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    frame.addEventListener(type, endPointer);
  }

  return { isOpen, reset, get scale() { return scale; }, fit() { if (scale > 1) place(scale, x, y); } };
}

function createReader(entry, first) {
  const element = $('#reader-template').content.firstElementChild.cloneNode(true);
  element.setAttribute('aria-label', entry.title);
  element.querySelector('h2').textContent = entry.title;
  const link = element.querySelector('.pdf-link');
  link.href = entry.url;
  link.setAttribute('aria-label', `Abrir PDF de ${entry.title} en otra pestaña`);
  const stage = element.querySelector('.reader-stage');
  const frame = element.querySelector('.page-frame');
  const previous = element.querySelector('.previous');
  const next = element.querySelector('.next');
  const book = element.querySelector('.book');
  const cover = element.querySelector('.reader-cover');
  const leaves = [...element.querySelectorAll('.book-page')];
  const sheet = element.querySelector('.book-turn');
  const front = element.querySelector('.book-front');
  const back = element.querySelector('.book-back');
  const status = element.querySelector('.page-status');
  const counter = element.querySelector('.page-number');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let loadingTask;
  let pdfReady;
  let pdfDocument;
  let thumbnailReady;
  let current = 1;
  let visiblePages = [null, null];
  let activeDraw;
  let animation;
  let gesture;
  let ignoreCoverClick = false;
  let disposed = false;
  let lastWidth;
  let leafRatio;
  let spread = false;
  let renderedScale = 1;
  const zoom = installReaderZoom(stage, frame, book, cover, turn, level => {
    if (level > renderedScale + 0.15 && !book.hidden && !activeDraw) drawPage();
  });

  function spreadStart(page, twoPages) {
    return twoPages && page > 1 ? page - page % 2 : page;
  }

  function pageSlots(page, twoPages) {
    if (!twoPages) return [page, null];
    if (page === 1) return [null, 1];
    return [page, page < pdfDocument.numPages ? page + 1 : null];
  }

  function updateControls() {
    const ready = !book.hidden;
    previous.disabled = !ready || current === 1;
    next.disabled = !ready || Math.max(...pageSlots(current, spread)) >= pdfDocument.numPages;
  }

  function putPage(slot, canvas) {
    if (canvas) slot.replaceChildren(canvas);
    else slot.replaceChildren();
  }

  function showLeaves(canvases) {
    leaves.forEach((leaf, index) => putPage(leaf, canvases[index]));
  }

  function clearSheet() {
    sheet.hidden = true;
    front.replaceChildren();
    back.replaceChildren();
  }

  function stopDraw() {
    activeDraw?.tasks.forEach(task => task.cancel());
    activeDraw = null;
    animation?.cancel();
    animation = null;
    clearSheet();
    showLeaves(visiblePages);
  }

  async function renderLeaf(number, width, job) {
    if (number === null) return null;
    const page = await pdfDocument.getPage(number);
    if (job !== activeDraw) return null;
    const original = page.getViewport({ scale: 1 });
    const scale = Math.min(width / original.width, width / leafRatio / original.height);
    const viewport = page.getViewport({ scale });
    const pixels = Math.min(Math.min(window.devicePixelRatio || 1, 2) * job.zoom, 4, 2400 / Math.max(viewport.width, viewport.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(viewport.width * pixels));
    canvas.height = Math.max(1, Math.round(viewport.height * pixels));
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', `Página ${number} de ${entry.title}`);
    const task = page.render({ canvas, viewport, transform: [pixels, 0, 0, pixels, 0, 0] });
    job.tasks.push(task);
    await task.promise;
    return canvas;
  }

  async function flip(incoming, direction, twoPages) {
    const turningIndex = twoPages && direction > 0 ? 1 : 0;
    const opposite = 1 - turningIndex;
    const underneath = [...visiblePages];
    underneath[turningIndex] = incoming[turningIndex];
    showLeaves(underneath);
    putPage(front, visiblePages[turningIndex]);
    putPage(back, twoPages ? incoming[opposite] : null);
    sheet.dataset.direction = direction > 0 ? 'next' : 'previous';
    sheet.hidden = false;
    const angle = direction > 0 ? -180 : 180;
    animation = sheet.animate([
      { transform: 'rotateY(0deg)', opacity: 1 },
      { transform: `rotateY(${angle / 2}deg)`, opacity: 1, offset: 0.5 },
      { transform: `rotateY(${angle}deg)`, opacity: twoPages ? 1 : 0 },
    ], { duration: 590, easing: 'cubic-bezier(.45,.08,.3,1)', fill: 'forwards' });
    await animation.finished.catch(() => {});
  }

  async function drawPage(page = current, direction = 0) {
    if (!pdfDocument || !leafRatio || disposed || frame.clientWidth === 0) return;
    stopDraw();
    lastWidth = frame.clientWidth;
    const twoPages = !mobileReader.matches && lastWidth >= 560 && leafRatio <= 1.15 && pdfDocument.numPages > 1;
    const start = spreadStart(page, twoPages);
    const numbers = pageSlots(start, twoPages);
    const columns = twoPages ? 2 : 1;
    const maxWidth = mobileReader.matches ? lastWidth : 720 * leafRatio * columns;
    const width = Math.min(lastWidth, maxWidth) / columns;
    const job = { tasks: [], zoom: zoom.scale };
    activeDraw = job;
    book.setAttribute('aria-busy', 'true');
    try {
      const incoming = await Promise.all(numbers.map(number => renderLeaf(number, width, job)));
      if (job !== activeDraw) return;
      if (direction && twoPages === spread && !book.hidden && !reducedMotion.matches) {
        await flip(incoming, direction, twoPages);
        if (job !== activeDraw) return;
      }
      current = start;
      spread = twoPages;
      renderedScale = job.zoom;
      animation?.cancel();
      animation = null;
      clearSheet();
      visiblePages = incoming;
      book.classList.toggle('is-spread', spread);
      book.style.setProperty('--book-max-width', `${maxWidth}px`);
      showLeaves(incoming);
      book.hidden = false;
      cover.hidden = true;
      status.hidden = true;
      zoom.fit();
      const end = Math.max(...numbers);
      counter.textContent = end > start ? `Páginas ${start}–${end} de ${pdfDocument.numPages}` : `Página ${start} de ${pdfDocument.numPages}`;
      const focused = document.activeElement;
      updateControls();
      if ((focused === previous && previous.disabled) || (focused === next && next.disabled)) stage.focus({ preventScroll: true });
    } catch (error) {
      if (job !== activeDraw || error.name === 'RenderingCancelledException') return;
      stopDraw();
      status.hidden = false;
      setStatus(status, 'No pudimos mostrar esta parte del PDF. Intenta de nuevo.', true);
    } finally {
      if (job === activeDraw || !activeDraw) {
        activeDraw = null;
        book.removeAttribute('aria-busy');
      }
    }
  }

  function turn(direction) {
    if (!pdfDocument || book.hidden || activeDraw) return;
    const step = spread && current >= (direction > 0 ? 2 : 4) ? 2 : 1;
    const destination = current + step * direction;
    if (destination < 1 || destination > pdfDocument.numPages) return;
    if (zoom.scale > 1) zoom.reset();
    drawPage(destination, direction);
  }

  previous.addEventListener('click', () => turn(-1));
  next.addEventListener('click', () => turn(1));
  frame.addEventListener('pointerdown', () => { ignoreCoverClick = zoom.isOpen(); });
  frame.addEventListener('click', () => {
    if (!ignoreCoverClick && (!cover.hidden || !book.hidden)) openFullscreen(stage, zoom.reset);
  });
  stage.addEventListener('keydown', event => {
    if (event.target === stage && !zoom.isOpen() && (event.key === 'Enter' || event.key === ' ')) {
      if (cover.hidden && book.hidden) return;
      event.preventDefault();
      openFullscreen(stage, zoom.reset);
      return;
    }
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    turn(event.key === 'ArrowLeft' ? -1 : 1);
  });
  book.addEventListener('pointerdown', event => {
    if (zoom.isOpen() || !event.isPrimary || event.button !== 0) return;
    gesture = { id: event.pointerId, x: event.clientX, y: event.clientY };
    book.setPointerCapture(event.pointerId);
  });
  book.addEventListener('pointerup', event => {
    if (gesture?.id !== event.pointerId) return;
    const dx = event.clientX - gesture.x;
    const dy = event.clientY - gesture.y;
    gesture = null;
    ignoreCoverClick = Math.hypot(dx, dy) > 10;
    if (Math.abs(dx) >= 32 && Math.abs(dx) > Math.abs(dy) * 1.25) turn(dx < 0 ? 1 : -1);
  });
  book.addEventListener('lostpointercapture', () => { gesture = null; });

  function openPdf() {
    pdfReady ??= getPdfModule().then(({ getDocument }) => {
      if (disposed) return null;
      loadingTask = getDocument({ ...pdfOptions, url: entry.url, disableStream: true, disableAutoFetch: true, rangeChunkSize: 256 * 1024 });
      return loadingTask.promise;
    });
    return pdfReady;
  }

  async function drawThumbnail() {
    const pdf = await openPdf();
    if (!pdf || disposed) return null;
    const page = await pdf.getPage(1);
    if (disposed) return null;
    const original = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(96 / original.width, 120 / original.height) });
    const preview = document.createElement('canvas');
    preview.width = Math.max(1, Math.round(viewport.width));
    preview.height = Math.max(1, Math.round(viewport.height));
    await page.render({ canvas: preview, viewport }).promise;
    return preview;
  }

  async function load() {
    try {
      pdfDocument = await openPdf();
      if (disposed) return;
      const cover = (await pdfDocument.getPage(1)).getViewport({ scale: 1 });
      if (disposed) return;
      leafRatio = cover.width / cover.height;
      book.style.setProperty('--leaf-ratio', String(leafRatio));
      drawPage();
      resizing.observe(frame);
    } catch (error) {
      if (disposed) return;
      status.hidden = false;
      setStatus(status, error.name === 'PasswordException' ? 'El PDF está protegido con contraseña.' : 'No pudimos abrir este PDF.', true);
    }
  }

  const resizing = new ResizeObserver(() => {
    if (frame.clientWidth && frame.clientWidth !== lastWidth) drawPage();
    else zoom.fit();
  });
  const visibility = new IntersectionObserver(visible => {
    if (!visible.some(item => item.isIntersecting)) return;
    visibility.disconnect();
    if (entry.cover && !cover.hasAttribute('src')) cover.src = entry.cover;
    load();
  }, { rootMargin: '75px' });
  visibility.observe(element);

  if (entry.cover) {
    cover.alt = `Portada de ${entry.title}`;
    cover.fetchPriority = first ? 'high' : 'low';
    cover.addEventListener('load', () => {
      if (disposed || !book.hidden) return;
      cover.hidden = false;
      status.hidden = true;
    }, { once: true });
    if (first) cover.src = entry.cover;
  }

  return { element, getThumbnail() {
    thumbnailReady ??= drawThumbnail().catch(() => null);
    return thumbnailReady;
  }, dispose() {
    disposed = true;
    zoom.reset();
    if (fullscreenReader.contains(stage)) fullscreenReader.close();
    visibility.disconnect();
    resizing.disconnect();
    stopDraw();
    loadingTask?.destroy().catch(() => {});
    element.remove();
  } };
}

function renderPublic() {
  if (!listLoaded) return;
  const active = new Set(entries.map(entry => entry.url));
  for (const [url, reader] of readers) {
    if (active.has(url)) continue;
    reader.dispose();
    readers.delete(url);
  }
  if (!entries.length) {
    catalogs.replaceChildren($('#empty-template').content.cloneNode(true));
    if (signedIn) $('#empty-message').textContent = 'Usa «Agregar PDF» para publicar el primer catálogo.';
    return;
  }
  catalogs.querySelector('.empty, .initial-status')?.remove();
  entries.forEach((entry, index) => {
    if (!readers.has(entry.url)) readers.set(entry.url, createReader(entry, index === 0));
    const { element } = readers.get(entry.url);
    const atPosition = catalogs.children[index];
    if (element !== atPosition) catalogs.insertBefore(element, atPosition || null);
  });
}

function rowButton(label, style, action) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `btn button button-${style}`;
  button.textContent = label;
  button.addEventListener('click', action);
  return button;
}

function renderAdmin() {
  finishDrag(false);
  admin.hidden = !signedIn;
  $('#logout').hidden = !signedIn;
  sessionButton.classList.toggle('is-guest', !signedIn);
  sessionLabel.classList.toggle('visually-hidden', !signedIn);
  sessionLabel.textContent = signedIn ? 'Tenshi' : 'Iniciar sesión';
  thumbnailObserver?.disconnect();
  adminList.replaceChildren();
  if (!signedIn) return;
  const canReorder = entries.length > 1;
  $('#reorder-hint').hidden = !canReorder;
  thumbnailObserver = new IntersectionObserver((items, observer) => {
    for (const { target, isIntersecting } of items) {
      if (!isIntersecting) continue;
      observer.unobserve(target);
      readers.get(target.dataset.url)?.getThumbnail().then(canvas => {
        if (canvas && target.isConnected) target.replaceChildren(canvas);
      });
    }
  }, { rootMargin: '160px' });
  entries.forEach((entry, index) => {
    const row = document.createElement('li');
    row.className = 'admin-row';
    row.dataset.id = entry.id;
    const label = document.createElement('div');
    label.className = 'admin-name d-flex align-items-center';
    const order = document.createElement('span');
    order.className = 'position';
    order.textContent = `${index + 1}.`;
    const name = document.createElement('span');
    name.textContent = entry.title;
    const thumbnail = document.createElement('span');
    thumbnail.className = 'catalog-thumb';
    thumbnail.dataset.url = entry.url;
    thumbnail.textContent = 'PDF';
    thumbnail.setAttribute('aria-hidden', 'true');
    label.append(order, name, thumbnail);
    const handle = rowButton('', 'text', event => {
      if (event.detail > 0 && suppressDragClick) return;
      showPosition(entry);
    });
    handle.className = 'drag-handle';
    handle.disabled = !canReorder;
    handle.title = 'Arrastra o elige una posición';
    handle.setAttribute('aria-label', `Mover ${entry.title}`);
    handle.setAttribute('aria-describedby', 'reorder-hint');
    const dots = document.createElement('span');
    dots.setAttribute('aria-hidden', 'true');
    handle.append(dots);
    const actions = document.createElement('div');
    actions.className = 'row-actions d-flex flex-wrap';
    const replace = rowButton('', 'outline', () => showUpload(entry));
    replace.classList.add('replace-pdf');
    const replaceIcon = document.createElement('span');
    replaceIcon.textContent = '🔄';
    replaceIcon.setAttribute('aria-hidden', 'true');
    replace.append(replaceIcon);
    replace.title = 'Reemplazar PDF';
    replace.setAttribute('aria-label', `Reemplazar PDF de ${entry.title}`);
    const view = document.createElement('a');
    view.className = 'btn button button-outline';
    view.href = entry.url;
    view.target = '_blank';
    view.rel = 'noopener';
    view.textContent = 'Ver PDF';
    view.setAttribute('aria-label', `Ver PDF de ${entry.title} en otra pestaña`);
    const remove = rowButton('×', 'outline', () => showRemove(entry));
    remove.classList.add('remove-pdf');
    remove.title = 'Quitar PDF';
    remove.setAttribute('aria-label', `Quitar PDF de ${entry.title}`);
    actions.append(replace, view, remove);
    row.append(handle, label, actions);
    adminList.append(row);
    thumbnailObserver.observe(thumbnail);
  });
}

function updateEntries(data) {
  entries = data;
  listLoaded = true;
  renderPublic();
  renderAdmin();
}

function updateSession(value) {
  signedIn = value;
  renderAdmin();
  renderPublic();
}

async function move(id, destination) {
  const order = entries.map(entry => entry.id);
  const index = order.indexOf(id);
  if (index === -1 || index === destination || destination < 0 || destination >= order.length) return;
  order.splice(index, 1);
  order.splice(destination, 0, id);
  admin.querySelectorAll('button').forEach(button => { button.disabled = true; });
  $('#logout').disabled = true;
  try {
    updateEntries(await request('/api/catalogos/orden', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(order),
    }));
    setStatus(adminStatus, 'Orden guardado.');
  } catch (error) {
    renderAdmin();
    setStatus(adminStatus, error.message, true);
    if (error.status === 401) sessionExpired();
  } finally {
    $('#add').disabled = false;
    $('#logout').disabled = false;
    adminList.querySelector(`[data-id="${id}"] .drag-handle`)?.focus();
  }
}

function showPosition(entry) {
  positioning = entry.id;
  $('#position-title').textContent = entry.title;
  positionSelect.replaceChildren(...entries.map((item, index) =>
    new Option(String(index + 1), String(index), false, item.id === entry.id)
  ));
  positionDialog.showModal();
}

$('#position-form').addEventListener('submit', event => {
  event.preventDefault();
  positionDialog.close();
  move(positioning, Number(positionSelect.value));
});

function markDropTarget() {
  const bounds = adminList.getBoundingClientRect();
  const { x, y, others } = drag;
  drag.marker?.element.classList.remove(drag.marker.style);
  drag.marker = null;
  drag.destination = null;
  if (x < bounds.left - 12 || x > bounds.right + 12 || y < bounds.top - 12 || y > bounds.bottom + 12) return;
  const before = others.findIndex(row => {
    const rect = row.getBoundingClientRect();
    return y < rect.top + rect.height / 2;
  });
  drag.destination = before === -1 ? others.length : before;
  if (drag.destination === drag.index) return;
  drag.marker = before === -1 ? { element: others.at(-1), style: 'drop-after' } : { element: others[before], style: 'drop-before' };
  drag.marker.element.classList.add(drag.marker.style);
}

function scrollWhileDragging() {
  const edge = 65;
  const bottom = window.innerHeight - edge;
  const speed = Math.max(-18, Math.min(18, (drag.y - Math.max(edge, Math.min(bottom, drag.y))) / 3));
  if (speed) {
    window.scrollBy(0, speed);
    markDropTarget();
  }
  drag.frame = requestAnimationFrame(scrollWhileDragging);
}

function finishDrag(commit) {
  if (!drag) return;
  const { row, marker, handle, pointer, frame, destination, active } = drag;
  drag = null;
  cancelAnimationFrame(frame);
  row.classList.remove('is-dragging');
  marker?.element.classList.remove(marker.style);
  if (handle.hasPointerCapture(pointer)) handle.releasePointerCapture(pointer);
  suppressDragClick = active;
  if (commit && active && destination !== null) move(row.dataset.id, destination);
}

adminList.addEventListener('pointerdown', event => {
  const handle = event.target.closest('.drag-handle');
  if (drag || !handle || handle.disabled || !event.isPrimary || event.button !== 0) return;
  suppressDragClick = false;
  const row = handle.closest('.admin-row');
  const rows = Array.from(adminList.children);
  const index = rows.indexOf(row);
  rows.splice(index, 1);
  drag = { handle, row, index, others: rows, pointer: event.pointerId, startX: event.clientX, startY: event.clientY, active: false };
  handle.setPointerCapture(event.pointerId);
});

adminList.addEventListener('pointermove', event => {
  if (drag?.pointer !== event.pointerId) return;
  drag.x = event.clientX;
  drag.y = event.clientY;
  if (!drag.active) {
    if (Math.hypot(drag.x - drag.startX, drag.y - drag.startY) < 6) return;
    drag.active = true;
    drag.row.classList.add('is-dragging');
    drag.frame = requestAnimationFrame(scrollWhileDragging);
  }
  markDropTarget();
});

for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  adminList.addEventListener(type, event => {
    if (drag?.pointer !== event.pointerId) return;
    if (type === 'pointerup' && drag.active) {
      drag.x = event.clientX;
      drag.y = event.clientY;
      markDropTarget();
    }
    finishDrag(type === 'pointerup');
  });
}
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') finishDrag(false);
});

function sessionExpired() {
  if (uploadDialog.open) uploadDialog.close();
  updateSession(false);
  showLogin('Tu sesión venció. Ingresa de nuevo.');
}

function showLogin(message = '') {
  loginForm.reset();
  setStatus(loginForm.querySelector('.form-status'), message, Boolean(message));
  loginDialog.showModal();
}

function showUpload(entry = null) {
  replacing = entry;
  uploadForm.reset();
  $('#title').value = entry?.title || '';
  $('#upload-heading').textContent = entry ? 'Reemplazar PDF' : 'Agregar PDF';
  setStatus(uploadForm.querySelector('.form-status'), '');
  uploadDialog.showModal();
}

function showRemove(entry) {
  removing = entry;
  $('#remove-description').textContent = `¿Quitar «${entry.title}» de Mundo Catálogo?`;
  setStatus(removeForm.querySelector('.form-status'), '');
  removeDialog.showModal();
}

$('#cancel-remove').addEventListener('click', () => removeDialog.close());
removeForm.addEventListener('submit', async event => {
  event.preventDefault();
  const entry = removing;
  const status = removeForm.querySelector('.form-status');
  showBusy(removeForm, true);
  setStatus(status, 'Quitando PDF…');
  try {
    const data = await request(`/api/catalogos/${entry.id}`, { method: 'DELETE', headers: { 'If-Match': `"${entry.url}"` } });
    removeDialog.close();
    updateEntries(data);
    setStatus(adminStatus, 'PDF quitado.');
    $('#add').focus({ preventScroll: true });
  } catch (error) {
    setStatus(status, error.message, true);
    if (error.status === 401) {
      removeDialog.close();
      sessionExpired();
    }
  } finally {
    showBusy(removeForm, false);
  }
});

function showBusy(form, busy) {
  form.querySelectorAll('button, input').forEach(input => { input.disabled = busy; });
  form.setAttribute('aria-busy', String(busy));
}

for (const dialog of [loginDialog, uploadDialog, positionDialog, removeDialog]) {
  dialog.querySelector('.close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('cancel', event => {
    if (dialog.querySelector('form').getAttribute('aria-busy') === 'true') event.preventDefault();
  });
}

sessionButton.addEventListener('click', () => {
  if (!signedIn) showLogin();
  else {
    admin.scrollIntoView({ block: 'start' });
    $('#add').focus({ preventScroll: true });
  }
});
$('#add').addEventListener('click', () => showUpload());

loginForm.addEventListener('submit', async event => {
  event.preventDefault();
  const status = loginForm.querySelector('.form-status');
  const credentials = { user: $('#user').value.trim(), password: $('#password').value };
  setStatus(status, 'Ingresando…');
  showBusy(loginForm, true);
  try {
    await request('/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials) });
    loginForm.reset();
    loginDialog.close();
    setStatus(adminStatus, '');
    updateSession(true);
    $('#add').focus({ preventScroll: true });
  } catch (error) {
    setStatus(status, error.message, true);
  } finally {
    showBusy(loginForm, false);
  }
});

$('#logout').addEventListener('click', async () => {
  try {
    await request('/api/session', { method: 'DELETE' });
    updateSession(false);
    sessionButton.focus();
  } catch (error) {
    setStatus(adminStatus, error.message, true);
  }
});

uploadForm.addEventListener('submit', async event => {
  event.preventDefault();
  const status = uploadForm.querySelector('.form-status');
  const file = $('#file').files[0];
  const name = $('#title').value.trim() || file.name.replace(/\.pdf$/i, '');
  const limitMb = Number($('#file').dataset.limitMb);
  if (file.size > limitMb * 1_000_000) return setStatus(status, `El PDF supera los ${limitMb} MB.`, true);
  showBusy(uploadForm, true);
  setStatus(status, 'Revisando PDF…');
  try {
    const { getDocument } = await getPdfModule();
    const check = getDocument({ ...pdfOptions, data: await file.arrayBuffer() });
    try {
      const pdf = await check.promise;
      await pdf.getPage(1);
    } catch (error) {
      throw new Error(error.name === 'PasswordException' ? 'Selecciona un PDF que se abra sin contraseña.' : 'No pudimos leer el archivo. Selecciona un PDF válido.');
    } finally {
      await check.destroy().catch(() => {});
    }
    setStatus(status, 'Guardando PDF…');
    const path = replacing ? `/api/catalogos/${replacing.id}` : '/api/catalogos';
    const data = await request(path, {
      method: replacing ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/pdf', 'X-Catalog-Title': encodeURIComponent(Array.from(name).slice(0, 120).join('')) },
      body: file,
    });
    uploadDialog.close();
    updateEntries(data);
    setStatus(adminStatus, replacing ? 'PDF reemplazado.' : 'PDF agregado al final de la lista.');
    $('#add').focus({ preventScroll: true });
  } catch (error) {
    setStatus(status, error.message, true);
    if (error.status === 401) sessionExpired();
  } finally {
    showBusy(uploadForm, false);
  }
});

request('/api/catalogos').then(data => {
  if (!listLoaded) updateEntries(data);
}).catch(() => {
  if (!listLoaded) setStatus(catalogs.querySelector('.initial-status'), 'No pudimos cargar los catálogos. Recarga la página para volver a intentarlo.', true);
});
request('/api/session').then(({ signedIn: active }) => updateSession(active)).catch(() => {});
