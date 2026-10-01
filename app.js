/* =========================================================================
   Imagem-para-Post — app.js
   Todo o processamento roda no navegador com a API Canvas 2D.
   Nenhuma imagem é enviada para servidor algum.
   ========================================================================= */
(() => {
  'use strict';

  /* ---------- Configuração ---------- */

  const PRESETS = {
    wordpress: { width: 1200, height: 628 },  // 1.91:1 (Open Graph)
    instagram: { width: 1080, height: 1080 }, // 1:1
  };

  // Safari e navegadores antigos não codificam WEBP no canvas: toDataURL()
  // devolve PNG sem avisar. Detectamos isso uma vez, logo no início.
  const WEBP_SUPPORTED = (() => {
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    return c.toDataURL('image/webp').startsWith('data:image/webp');
  })();

  const DEFAULTS = {
    preset: 'wordpress',
    width: 1200,
    height: 628,
    zoom: 100,   // % relativo ao "cover" (100% = preenche o quadro sem sobras)
    posX: 50,    // 0 = encostada à esquerda, 50 = centro, 100 = à direita
    posY: 50,    // 0 = topo, 50 = centro, 100 = base
    bg: '#ffffff',
    format: WEBP_SUPPORTED ? 'webp' : 'jpg',
    quality: 82,
  };

  const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
  const ACCEPTED_EXT = /\.(png|jpe?g|webp)$/i;
  const MIME = { webp: 'image/webp', jpg: 'image/jpeg' };

  const KB = 1024;
  const SIZE_OK = 200 * KB;    // abaixo disso: verde
  const SIZE_HEAVY = 300 * KB; // acima disso: vermelho (entre os dois: amarelo)
  const METER_MAX = 400 * KB;  // fim da escala visual do medidor

  const SIDE_MIN = 16;
  const SIDE_MAX = 4096;
  const ZOOM_MIN = 10;
  const ZOOM_MAX = 400;

  /* ---------- Estado ---------- */

  const state = {
    img: null,        // HTMLImageElement com a imagem original
    imgUrl: '',       // object URL da imagem atual (liberado ao trocar)
    sourceName: '',
    sourceSize: 0,
    ...DEFAULTS,
  };

  /* ---------- Elementos ---------- */

  const $ = (id) => document.getElementById(id);
  const els = {
    uploadView: $('uploadView'),
    editorView: $('editorView'),
    fileInput: $('fileInput'),
    uploadError: $('uploadError'),
    sourceInfo: $('sourceInfo'),
    sourceName: $('sourceName'),
    sourceMeta: $('sourceMeta'),
    replaceBtn: $('replaceBtn'),
    preset: $('preset'),
    customW: $('customW'),
    customH: $('customH'),
    ratioLabel: $('ratioLabel'),
    zoom: $('zoom'),
    zoomOut: $('zoomOut'),
    posX: $('posX'),
    posXOut: $('posXOut'),
    posXField: $('posXField'),
    posY: $('posY'),
    posYOut: $('posYOut'),
    posYField: $('posYField'),
    posHint: $('posHint'),
    fitCover: $('fitCover'),
    fitContain: $('fitContain'),
    centerBtn: $('centerBtn'),
    bgColor: $('bgColor'),
    bgHex: $('bgHex'),
    swatches: document.querySelectorAll('[data-swatch]'),
    edgeSwatch: $('edgeSwatch'),
    formatRadios: document.querySelectorAll('input[name="format"]'),
    webpNote: $('webpNote'),
    quality: $('quality'),
    qualityOut: $('qualityOut'),
    resetBtn: $('resetBtn'),
    stage: $('stage'),
    frame: $('frame'),
    canvas: $('previewCanvas'),
    measureW: $('measureW'),
    measureH: $('measureH'),
    sizeBox: $('sizeBox'),
    sizeValue: $('sizeValue'),
    meterFill: $('meterFill'),
    sizeNote: $('sizeNote'),
    sizeSaving: $('sizeSaving'),
    fileName: $('fileName'),
    fileExt: $('fileExt'),
    exportBtn: $('exportBtn'),
    toast: $('toast'),
  };

  // alpha:false = canvas opaco. Sempre pintamos o fundo antes da imagem,
  // então não precisamos de transparência (e o navegador desenha mais rápido).
  const ctx = els.canvas.getContext('2d', { alpha: false });

  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
  const nf1 = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });
  const nf2 = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 });

  /* =========================================================================
     Lógica do Canvas
     O canvas do preview tem exatamente as dimensões do arquivo final
     (ex.: 1200 × 628). O CSS apenas o reduz para caber na tela, então o que
     você vê é o mesmo bitmap que será exportado — recorte idêntico.
     ========================================================================= */

  // Calcula tamanho (dw, dh) e posição (dx, dy) da imagem no quadro W × H.
  function computeLayout() {
    const W = state.width;
    const H = state.height;
    const iw = state.img.naturalWidth;
    const ih = state.img.naturalHeight;

    // Escala "cover": a menor escala que faz a imagem cobrir o quadro todo.
    // Zoom 100% = cover. Abaixo disso sobra espaço, pintado com a cor de fundo.
    const cover = Math.max(W / iw, H / ih);
    const scale = cover * (state.zoom / 100);
    const dw = iw * scale;
    const dh = ih * scale;

    // Posição no estilo "object-position" do CSS. (W - dw) é a sobra:
    // fica negativa quando a imagem é maior que o quadro, e então o slider
    // percorre a imagem de ponta a ponta sem nunca revelar o fundo.
    const dx = (W - dw) * (state.posX / 100);
    const dy = (H - dh) * (state.posY / 100);

    return { W, H, iw, ih, cover, dw, dh, dx, dy };
  }

  function draw() {
    const { W, H, dw, dh, dx, dy } = computeLayout();

    // Mudar width/height apaga o canvas e o estado do contexto,
    // por isso só redimensionamos quando o tamanho de saída muda.
    if (els.canvas.width !== W || els.canvas.height !== H) {
      els.canvas.width = W;
      els.canvas.height = H;
    }

    // 1) Fundo sólido: cobre as sobras do zoom reduzido e as áreas
    //    transparentes de PNG/WEBP (JPG não suporta transparência).
    ctx.fillStyle = state.bg;
    ctx.fillRect(0, 0, W, H);

    // 2) Imagem por cima, com suavização de alta qualidade ao reduzir.
    //    O que passa das bordas do canvas é simplesmente cortado.
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(state.img, dx, dy, dw, dh);
  }

  // Ajusta o tamanho em tela do quadro para caber no palco mantendo a proporção.
  function fitFrame() {
    const cs = getComputedStyle(els.stage);
    const aw = els.stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const ah = els.stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    if (aw <= 0 || ah <= 0) return;
    const s = Math.min(aw / state.width, ah / state.height, 1);
    els.frame.style.width = `${Math.max(1, Math.floor(state.width * s))}px`;
    els.frame.style.height = `${Math.max(1, Math.floor(state.height * s))}px`;
  }

  /* ---------- Ciclo de renderização ---------- */

  let rafId = 0;
  let version = 0;                            // muda a cada ajuste
  let encoded = { version: -1, blob: null };  // último arquivo gerado
  let estimateTimer = 0;

  // Agrupa vários ajustes no mesmo frame (sliders disparam muitos eventos).
  function requestRender() {
    if (!state.img || rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      render();
    });
  }

  function render() {
    draw();
    version += 1;
    updateFramingHints();
    scheduleEstimate();
  }

  function flushRender() {
    if (!rafId) return;
    cancelAnimationFrame(rafId);
    rafId = 0;
    render();
  }

  /* =========================================================================
     Cálculo do tamanho final
     Não existe fórmula confiável: o peso de um WEBP/JPG depende do conteúdo.
     Então codificamos o canvas de verdade com toBlob(), no formato e na
     qualidade escolhidos. blob.size é exatamente o número de bytes do arquivo
     que será baixado. Um debounce evita recodificar a cada movimento de
     slider, e o blob fica guardado para o download sair instantâneo.
     ========================================================================= */

  function encodeCanvas() {
    return new Promise((resolve, reject) => {
      els.canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('encode-failed'))),
        MIME[state.format],
        state.quality / 100 // toBlob espera qualidade entre 0 e 1
      );
    });
  }

  function scheduleEstimate() {
    clearTimeout(estimateTimer);
    els.sizeBox.classList.add('is-stale');
    estimateTimer = setTimeout(runEstimate, 220);
  }

  async function runEstimate() {
    const v = version;
    try {
      const blob = await encodeCanvas();
      if (v !== version) return; // houve outro ajuste enquanto codificava
      encoded = { version: v, blob };
      showSize(blob.size);
    } catch {
      els.sizeValue.textContent = 'indisponível';
      els.sizeNote.textContent = 'Não foi possível calcular. Tente reduzir as dimensões.';
    }
  }

  function formatBytes(bytes) {
    if (bytes < KB) return `${bytes} B`;
    if (bytes < KB * KB) {
      const kb = bytes / KB;
      return `${kb < 10 ? nf1.format(kb) : Math.round(kb)} KB`;
    }
    return `${nf1.format(bytes / (KB * KB))} MB`;
  }

  function showSize(bytes) {
    const level = bytes < SIZE_OK ? 'ok' : bytes <= SIZE_HEAVY ? 'warn' : 'danger';
    els.sizeBox.dataset.level = level;
    els.sizeBox.classList.remove('is-stale');
    els.sizeValue.textContent = formatBytes(bytes);
    els.meterFill.style.width = `${Math.min(bytes / METER_MAX, 1) * 100}%`;
    els.sizeNote.textContent = sizeMessage(level);

    if (state.sourceSize) {
      const ratio = bytes / state.sourceSize;
      const pct = Math.round(Math.abs(1 - ratio) * 100);
      const original = formatBytes(state.sourceSize);
      els.sizeSaving.textContent = ratio <= 1
        ? `${pct}% menor que o original (${original})`
        : `${pct}% maior que o original (${original})`;
    }
  }

  function sizeMessage(level) {
    if (level === 'ok') {
      return 'Leve: carrega rápido no WordPress e na prévia do WhatsApp.';
    }
    if (level === 'warn') {
      return 'Aceitável, mas perto dos 300 KB. Acima disso o WhatsApp pode não mostrar a prévia.';
    }
    return state.format === 'jpg' && WEBP_SUPPORTED
      ? 'Pesada para o WhatsApp: a prévia do link pode não aparecer. Tente .WEBP ou reduza a qualidade.'
      : 'Pesada para o WhatsApp: a prévia do link pode não aparecer. Reduza a qualidade ou as dimensões.';
  }

  /* ---------- Exportação ---------- */

  async function exportImage() {
    if (!state.img) return;
    els.exportBtn.disabled = true;
    try {
      flushRender();
      clearTimeout(estimateTimer);

      // Reaproveita o arquivo da estimativa se nada mudou desde então.
      let blob = encoded.version === version ? encoded.blob : null;
      if (!blob) {
        const v = version;
        blob = await encodeCanvas();
        encoded = { version: v, blob };
        showSize(blob.size);
      }

      const name = currentFileName();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      toast(`Imagem exportada: ${name}`);
    } catch {
      toast('Não foi possível gerar o arquivo. Tente reduzir as dimensões.', 'error');
    } finally {
      els.exportBtn.disabled = false;
    }
  }

  /* ---------- Nome do arquivo amigável para SEO ---------- */

  // "Foto 123 (Promoção).JPG" -> "foto-123-promocao":
  // sem acentos, minúsculas, só letras, números e hífens.
  function slugify(text) {
    return String(text)
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60)
      .replace(/-+$/, '');
  }

  function defaultFileBase(originalName) {
    const slug = slugify(originalName.replace(/\.[^.]+$/, '')) || 'imagem';
    return slug.startsWith('featured-') ? slug : `featured-${slug}`;
  }

  function currentFileName() {
    const base = slugify(els.fileName.value) || defaultFileBase(state.sourceName);
    return `${base}.${state.format}`;
  }

  /* ---------- Carregamento da imagem ---------- */

  function loadFile(file, fallbackName = 'imagem') {
    if (!file) return;
    const typeOk = ACCEPTED_TYPES.includes(file.type) || (!file.type && ACCEPTED_EXT.test(file.name));
    if (!typeOk) {
      reportError('Formato não suportado. Envie uma imagem PNG, JPG ou WEBP.');
      return;
    }

    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      if (state.imgUrl) URL.revokeObjectURL(state.imgUrl);
      state.img = img;
      state.imgUrl = url;
      state.sourceName = file.name || fallbackName;
      state.sourceSize = file.size;

      // Configuração automática: 1200 × 628, zoom que preenche e imagem
      // centralizada. Cor, formato e qualidade escolhidos antes são mantidos.
      Object.assign(state, {
        preset: DEFAULTS.preset,
        width: DEFAULTS.width,
        height: DEFAULTS.height,
        zoom: DEFAULTS.zoom,
        posX: DEFAULTS.posX,
        posY: DEFAULTS.posY,
      });

      const edge = edgeColor(img);
      els.edgeSwatch.dataset.color = edge;
      els.edgeSwatch.style.setProperty('--sw', edge);

      els.sourceName.textContent = state.sourceName;
      els.sourceName.title = state.sourceName;
      els.sourceMeta.textContent = `${img.naturalWidth} × ${img.naturalHeight} px, ${formatBytes(file.size)}`;
      els.fileName.value = defaultFileBase(state.sourceName);
      hideUploadError();
      showEditor();
      syncControls();
      fitFrame();
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
      render();
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reportError('Não foi possível abrir essa imagem. O arquivo pode estar corrompido.');
    };
    img.src = url;
  }

  // Média das cores na borda da imagem: como fundo, "continua" a foto
  // sem emenda visível quando o zoom é reduzido.
  function edgeColor(img) {
    const n = 48;
    const c = document.createElement('canvas');
    c.width = c.height = n;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(img, 0, 0, n, n);
    const d = x.getImageData(0, 0, n, n).data;
    let r = 0, g = 0, b = 0, a = 0;
    for (let row = 0; row < n; row++) {
      for (let col = 0; col < n; col++) {
        if (row > 0 && row < n - 1 && col > 0 && col < n - 1) continue; // só a borda
        const k = (row * n + col) * 4;
        const alpha = d[k + 3] / 255;
        r += d[k] * alpha;
        g += d[k + 1] * alpha;
        b += d[k + 2] * alpha;
        a += alpha;
      }
    }
    if (a < 1) return '#ffffff'; // borda transparente: branco
    const hex = (v) => Math.round(v / a).toString(16).padStart(2, '0');
    return `#${hex(r)}${hex(g)}${hex(b)}`;
  }

  function showEditor() {
    els.uploadView.hidden = true;
    els.editorView.hidden = false;
    els.sourceInfo.hidden = false;
    els.replaceBtn.hidden = false;
    document.body.classList.add('has-image');
  }

  function reportError(message) {
    if (state.img) {
      toast(message, 'error');
    } else {
      els.uploadError.textContent = message;
      els.uploadError.hidden = false;
    }
  }

  function hideUploadError() {
    els.uploadError.hidden = true;
  }

  /* ---------- Sincronização estado → controles ---------- */

  function paintRange(input) {
    const min = Number(input.min);
    const max = Number(input.max);
    const pct = ((Number(input.value) - min) / (max - min)) * 100;
    input.style.setProperty('--pct', `${pct}%`);
  }

  function setRange(input, value) {
    input.value = value;
    paintRange(input);
  }

  function ratioText(w, h) {
    if (w === h) return '1:1';
    return w > h ? `${nf2.format(w / h)}:1` : `1:${nf2.format(h / w)}`;
  }

  function updateSizeLabels() {
    els.ratioLabel.textContent = `Proporção ${ratioText(state.width, state.height)}`;
    els.measureW.textContent = `${state.width} px`;
    els.measureH.textContent = `${state.height} px`;
  }

  function syncSizeFields() {
    const custom = state.preset === 'custom';
    els.customW.disabled = !custom;
    els.customH.disabled = !custom;
    els.customW.value = state.width;
    els.customH.value = state.height;
    els.customW.classList.remove('is-invalid');
    els.customH.classList.remove('is-invalid');
    updateSizeLabels();
  }

  function posText(v) {
    return Math.abs(v - 50) < 0.25 ? 'Centro' : `${Math.round(v)}%`;
  }

  function updateOutputs() {
    els.zoomOut.textContent = `${Math.round(state.zoom)}%`;
    els.posXOut.textContent = posText(state.posX);
    els.posYOut.textContent = posText(state.posY);
    els.qualityOut.textContent = `${state.quality}%`;
  }

  function updateSwatches() {
    els.swatches.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.color === state.bg)));
  }

  function syncBgControls() {
    els.bgColor.value = state.bg;
    els.bgHex.value = state.bg.toUpperCase();
    els.bgHex.classList.remove('is-invalid');
    updateSwatches();
  }

  function syncControls() {
    els.preset.value = state.preset;
    syncSizeFields();
    setRange(els.zoom, state.zoom);
    setRange(els.posX, state.posX);
    setRange(els.posY, state.posY);
    setRange(els.quality, state.quality);
    syncBgControls();
    els.formatRadios.forEach((r) => { r.checked = r.value === state.format; });
    els.fileExt.textContent = `.${state.format}`;
    updateOutputs();
  }

  // Quando a imagem cabe exatamente num eixo, não há sobra para mover nele:
  // o slider correspondente é desativado e explicamos o porquê.
  function updateFramingHints() {
    const { W, H, dw, dh } = computeLayout();
    const lockX = Math.abs(W - dw) < 0.5;
    const lockY = Math.abs(H - dh) < 0.5;
    els.posX.disabled = lockX;
    els.posY.disabled = lockY;
    els.posXField.classList.toggle('is-locked', lockX);
    els.posYField.classList.toggle('is-locked', lockY);

    let hint = 'Arraste a imagem no preview para reposicionar.';
    if (lockX && lockY) hint = 'A imagem ocupa o quadro exatamente. Aumente o zoom para reposicionar.';
    else if (lockX) hint = 'Na horizontal não sobra espaço para mover. Aumente o zoom para liberar.';
    else if (lockY) hint = 'Na vertical não sobra espaço para mover. Aumente o zoom para liberar.';
    els.posHint.textContent = hint;
  }

  function setFraming(patch) {
    Object.assign(state, patch);
    setRange(els.zoom, state.zoom);
    setRange(els.posX, state.posX);
    setRange(els.posY, state.posY);
    updateOutputs();
    requestRender();
  }

  function setBg(color) {
    state.bg = color;
    syncBgControls();
    requestRender();
  }

  function normalizeHex(value) {
    let s = String(value).trim().replace(/^#/, '');
    if (/^[0-9a-f]{3}$/i.test(s)) s = s.split('').map((c) => c + c).join('');
    return /^[0-9a-f]{6}$/i.test(s) ? `#${s.toLowerCase()}` : null;
  }

  /* ---------- Toast ---------- */

  let toastTimer = 0;
  function toast(message, kind = 'info') {
    els.toast.textContent = message;
    els.toast.dataset.kind = kind;
    els.toast.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('is-visible'), 3200);
  }

  /* =========================================================================
     Eventos
     ========================================================================= */

  // Upload por clique
  els.fileInput.addEventListener('change', () => {
    loadFile(els.fileInput.files[0]);
    els.fileInput.value = ''; // permite escolher o mesmo arquivo de novo
  });
  els.replaceBtn.addEventListener('click', () => els.fileInput.click());

  // Arrastar e soltar em qualquer lugar da janela
  let dragTimer = 0;
  const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');

  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    document.body.classList.add('is-dragging');
    // dragover dispara continuamente; se parar, o arquivo saiu da janela.
    clearTimeout(dragTimer);
    dragTimer = setTimeout(() => document.body.classList.remove('is-dragging'), 150);
  });

  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    document.body.classList.remove('is-dragging');
    loadFile(e.dataTransfer.files[0]);
  });

  // Colar imagem da área de transferência (Ctrl+V)
  window.addEventListener('paste', (e) => {
    const item = Array.from(e.clipboardData?.items || [])
      .find((i) => i.kind === 'file' && ACCEPTED_TYPES.includes(i.type));
    if (!item) return;
    e.preventDefault();
    const file = item.getAsFile();
    // Imagens coladas costumam se chamar "image.png"; damos um nome melhor.
    const named = new File([file], 'imagem-colada', { type: file.type });
    loadFile(named);
  });

  // Preset de tamanho
  els.preset.addEventListener('change', () => {
    state.preset = els.preset.value;
    const p = PRESETS[state.preset];
    if (p) {
      state.width = p.width;
      state.height = p.height;
    }
    syncSizeFields();
    fitFrame();
    requestRender();
    if (state.preset === 'custom') els.customW.focus();
  });

  // Largura/altura customizadas
  function readSide(input) {
    const v = Number(input.value);
    return Number.isInteger(v) && v >= SIDE_MIN && v <= SIDE_MAX ? v : null;
  }

  function applySide(input, v) {
    if (input === els.customW) state.width = v;
    else state.height = v;
    updateSizeLabels();
    fitFrame();
    requestRender();
  }

  [els.customW, els.customH].forEach((input) => {
    input.addEventListener('input', () => {
      if (state.preset !== 'custom') return;
      const v = readSide(input);
      input.classList.toggle('is-invalid', v === null);
      if (v !== null) applySide(input, v);
    });
    // Ao sair do campo, corrige valores fora do intervalo permitido.
    input.addEventListener('change', () => {
      if (state.preset !== 'custom') return;
      let v = Math.round(Number(input.value));
      if (!Number.isFinite(v) || v <= 0) v = input === els.customW ? state.width : state.height;
      v = clamp(v, SIDE_MIN, SIDE_MAX);
      input.value = v;
      input.classList.remove('is-invalid');
      applySide(input, v);
    });
  });

  // Sliders
  function bindRange(input, key) {
    input.addEventListener('input', () => {
      state[key] = Number(input.value);
      paintRange(input);
      updateOutputs();
      requestRender();
    });
  }
  bindRange(els.zoom, 'zoom');
  bindRange(els.posX, 'posX');
  bindRange(els.posY, 'posY');
  bindRange(els.quality, 'quality');

  // Atalhos de enquadramento
  els.fitCover.addEventListener('click', () => setFraming({ zoom: 100 }));
  els.fitContain.addEventListener('click', () => {
    if (!state.img) return;
    const { W, H, iw, ih, cover } = computeLayout();
    const contain = Math.min(W / iw, H / ih); // escala que mostra a imagem inteira
    setFraming({ zoom: clamp((contain / cover) * 100, ZOOM_MIN, ZOOM_MAX), posX: 50, posY: 50 });
  });
  els.centerBtn.addEventListener('click', () => setFraming({ posX: 50, posY: 50 }));

  // Cor de fundo
  els.bgColor.addEventListener('input', () => setBg(els.bgColor.value.toLowerCase()));
  els.bgHex.addEventListener('input', () => {
    const hex = normalizeHex(els.bgHex.value);
    els.bgHex.classList.toggle('is-invalid', !hex);
    if (!hex) return;
    state.bg = hex;
    els.bgColor.value = hex;
    updateSwatches();
    requestRender();
  });
  els.bgHex.addEventListener('change', syncBgControls);
  els.swatches.forEach((b) => b.addEventListener('click', () => setBg(b.dataset.color)));

  // Formato de saída
  els.formatRadios.forEach((r) => r.addEventListener('change', () => {
    if (!r.checked) return;
    state.format = r.value;
    els.fileExt.textContent = `.${state.format}`;
    requestRender();
  }));

  // Nome do arquivo: normaliza ao sair do campo
  els.fileName.addEventListener('change', () => {
    els.fileName.value = slugify(els.fileName.value) || defaultFileBase(state.sourceName);
  });
  els.fileName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') els.fileName.blur();
  });

  // Restaurar padrões
  els.resetBtn.addEventListener('click', () => {
    Object.assign(state, DEFAULTS);
    els.fileName.value = defaultFileBase(state.sourceName);
    syncControls();
    fitFrame();
    requestRender();
    toast('Ajustes restaurados.');
  });

  // Exportar
  els.exportBtn.addEventListener('click', exportImage);

  /* ---------- Interação direta com o preview ---------- */

  // Arrastar: converte o deslocamento em pixels de tela para pixels do
  // canvas e depois para a porcentagem de posição (dx = sobra × pos).
  let drag = null;

  els.frame.addEventListener('pointerdown', (e) => {
    if (!state.img || e.button !== 0) return;
    els.frame.setPointerCapture(e.pointerId);
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, posX: state.posX, posY: state.posY };
    els.frame.classList.add('is-grabbing');
  });

  els.frame.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const { W, H, dw, dh } = computeLayout();
    const kx = W / els.frame.clientWidth;
    const ky = H / els.frame.clientHeight;
    const slackX = W - dw;
    const slackY = H - dh;
    const patch = {};
    if (Math.abs(slackX) >= 0.5) {
      patch.posX = clamp(drag.posX + (((e.clientX - drag.x) * kx) / slackX) * 100, 0, 100);
    }
    if (Math.abs(slackY) >= 0.5) {
      patch.posY = clamp(drag.posY + (((e.clientY - drag.y) * ky) / slackY) * 100, 0, 100);
    }
    setFraming(patch);
  });

  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    els.frame.classList.remove('is-grabbing');
  };
  els.frame.addEventListener('pointerup', endDrag);
  els.frame.addEventListener('pointercancel', endDrag);

  // Roda do mouse = zoom
  els.frame.addEventListener('wheel', (e) => {
    if (!state.img) return;
    e.preventDefault();
    const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY; // linhas → pixels
    setFraming({ zoom: clamp(state.zoom * Math.exp(-dy * 0.0015), ZOOM_MIN, ZOOM_MAX) });
  }, { passive: false });

  // Teclado: setas movem, + e − dão zoom (Shift = passos maiores)
  els.frame.addEventListener('keydown', (e) => {
    if (!state.img) return;
    const step = e.shiftKey ? 10 : 2;
    const moves = {
      ArrowLeft: ['posX', -step], ArrowRight: ['posX', step],
      ArrowUp: ['posY', -step], ArrowDown: ['posY', step],
    };
    if (moves[e.key]) {
      e.preventDefault();
      const [key, delta] = moves[e.key];
      setFraming({ [key]: clamp(state[key] + delta, 0, 100) });
    } else if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      setFraming({ zoom: clamp(state.zoom * (e.shiftKey ? 1.25 : 1.05), ZOOM_MIN, ZOOM_MAX) });
    } else if (e.key === '-' || e.key === '_') {
      e.preventDefault();
      setFraming({ zoom: clamp(state.zoom / (e.shiftKey ? 1.25 : 1.05), ZOOM_MIN, ZOOM_MAX) });
    }
  });

  // Reencaixa o preview quando o palco muda de tamanho
  new ResizeObserver(fitFrame).observe(els.stage);

  /* ---------- Inicialização ---------- */

  if (!WEBP_SUPPORTED) {
    document.querySelector('input[name="format"][value="webp"]').disabled = true;
    els.webpNote.hidden = false;
  }
  syncControls();
})();
