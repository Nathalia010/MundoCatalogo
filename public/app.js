const $ = selector => document.querySelector(selector);
const catalogs = $('#catalogs');
const admin = $('#admin');
const adminList = $('#admin-list');
const adminStatus = $('#admin-status');
const sessionButton = $('#session-button');
const loginDialog = $('#login-dialog');
const loginForm = $('#login-form');
const uploadDialog = $('#upload-dialog');
const uploadForm = $('#upload-form');
const positionDialog = $('#position-dialog');
const positionSelect = $('#position-select');
const readers = new Map();
let entries = [];
let signedIn = false;
let listLoaded = false;
let replacing = null;
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

function createReader(entry) {
  const element = $('#reader-template').content.firstElementChild.cloneNode(true);
  element.querySelector('h2').textContent = entry.title;
  const link = element.querySelector('.pdf-link');
  link.href = entry.url;
  link.setAttribute('aria-label', `Abrir PDF de ${entry.title} en otra pestaña`);
  const stage = element.querySelector('.reader-stage');
  const frame = element.querySelector('.page-frame');
  const previous = element.querySelector('.previous');
  const next = element.querySelector('.next');
  const canvas = element.querySelector('canvas');
  const status = element.querySelector('.page-status');
  const counter = element.querySelector('.page-number');
  let loadingTask;
  let pdfReady;
  let pdfDocument;
  let thumbnailReady;
  let current = 1;
  let revision = 0;
  let renderTask;
  let disposed = false;
  let lastWidth;

  function updateControls() {
    previous.disabled = !pdfDocument || current === 1;
    next.disabled = !pdfDocument || current === pdfDocument.numPages;
  }

  async function drawPage() {
    if (!pdfDocument || disposed) return;
    lastWidth = frame.clientWidth;
    const draw = ++revision;
    const pageNumber = current;
    renderTask?.cancel();
    try {
      const page = await pdfDocument.getPage(pageNumber);
      if (draw !== revision || disposed) return;
      const original = page.getViewport({ scale: 1 });
      const scale = Math.min(Math.max(lastWidth, 1) / original.width, 850 / original.height, 1.7);
      const viewport = page.getViewport({ scale });
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      const surface = document.createElement('canvas');
      surface.width = Math.max(1, Math.round(viewport.width * pixelRatio));
      surface.height = Math.max(1, Math.round(viewport.height * pixelRatio));
      renderTask = page.render({ canvas: surface, viewport, transform: [pixelRatio, 0, 0, pixelRatio, 0, 0] });
      await renderTask.promise;
      if (draw !== revision || disposed) return;
      canvas.width = surface.width;
      canvas.height = surface.height;
      canvas.style.width = `${Math.round(viewport.width)}px`;
      canvas.getContext('2d').drawImage(surface, 0, 0);
      canvas.setAttribute('aria-label', `Página ${pageNumber} de ${entry.title}`);
      canvas.hidden = false;
      status.hidden = true;
      counter.textContent = `Página ${pageNumber} de ${pdfDocument.numPages}`;
    } catch (error) {
      if (draw !== revision || disposed || error.name === 'RenderingCancelledException') return;
      canvas.hidden = true;
      status.hidden = false;
      setStatus(status, 'No pudimos mostrar esta página del PDF.', true);
      counter.textContent = `Página ${pageNumber} de ${pdfDocument.numPages}`;
    }
  }

  function turn(direction) {
    if (!pdfDocument) return;
    const target = current + direction;
    if (target < 1 || target > pdfDocument.numPages) return;
    current = target;
    const focused = document.activeElement;
    updateControls();
    if (focused === previous && previous.disabled || focused === next && next.disabled) stage.focus({ preventScroll: true });
    drawPage();
  }

  previous.addEventListener('click', () => turn(-1));
  next.addEventListener('click', () => turn(1));
  stage.addEventListener('keydown', event => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    turn(event.key === 'ArrowLeft' ? -1 : 1);
  });

  function openPdf() {
    pdfReady ??= getPdfModule().then(({ getDocument }) => {
      if (disposed) return null;
      loadingTask = getDocument({ ...pdfOptions, url: entry.url, disableStream: true, disableAutoFetch: true });
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
      updateControls();
      drawPage();
      resizing.observe(frame);
    } catch (error) {
      if (disposed) return;
      setStatus(status, error.name === 'PasswordException' ? 'El PDF está protegido con contraseña.' : 'No pudimos abrir este PDF.', true);
    }
  }

  const resizing = new ResizeObserver(() => {
    if (frame.clientWidth && frame.clientWidth !== lastWidth) drawPage();
  });
  const visibility = new IntersectionObserver(visible => {
    if (!visible.some(item => item.isIntersecting)) return;
    visibility.disconnect();
    load();
  }, { rootMargin: '500px' });
  visibility.observe(element);

  return { element, getThumbnail() {
    thumbnailReady ??= drawThumbnail().catch(() => null);
    return thumbnailReady;
  }, dispose() {
    disposed = true;
    visibility.disconnect();
    resizing.disconnect();
    renderTask?.cancel();
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
    if (!readers.has(entry.url)) readers.set(entry.url, createReader(entry));
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
  sessionButton.textContent = signedIn ? 'Tenshi' : 'Iniciar sesión';
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
    actions.append(replace, view);
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

function showBusy(form, busy) {
  form.querySelectorAll('button, input').forEach(input => { input.disabled = busy; });
  form.setAttribute('aria-busy', String(busy));
}

for (const dialog of [loginDialog, uploadDialog, positionDialog]) {
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
