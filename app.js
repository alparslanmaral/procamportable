// ProCam Portable - Geliştirilmiş sürüm
(() => {
  const els = {
    video: document.getElementById('video'),
    photoCanvas: document.getElementById('photoCanvas'),
    previewFrame: document.getElementById('previewFrame'),
    lensStrip: document.getElementById('lensStrip'),
    aspectSelect: document.getElementById('aspectSelect'),
    settingsBtn: document.getElementById('settingsBtn'),
    settingsPanel: document.getElementById('settingsPanel'),
    closeSettings: document.getElementById('closeSettings'),
    modeSelect: document.getElementById('modeSelect'),
    modeToggle: document.getElementById('modeToggle'),
    shutterBtn: document.getElementById('shutterBtn'),
    switchFacing: document.getElementById('switchFacing'),
    gridToggle: document.getElementById('gridToggle'),
    gridOverlay: document.getElementById('gridOverlay'),
    resolutionSelect: document.getElementById('resolutionSelect'),
    fpsSelect: document.getElementById('fpsSelect'),
    zoomSlider: document.getElementById('zoomSlider'),
    zoomValue: document.getElementById('zoomValue'),
    torchToggle: document.getElementById('torchToggle'),
    recordBadge: document.getElementById('recordBadge'),
    timer: document.getElementById('timer'),
    toast: document.getElementById('toast'),
    focusPoint: document.getElementById('focusPoint'),
    glassBackdrop: document.getElementById('glassBackdrop'),
    // Manuel kontroller
    expSlider: document.getElementById('expSlider'),
    expValue: document.getElementById('expValue'),
    focusSlider: document.getElementById('focusSlider'),
    focusValue: document.getElementById('focusValue'),
    wbModeSelect: document.getElementById('wbModeSelect'),
    wbTempWrap: document.getElementById('wbTempWrap'),
    wbTempSlider: document.getElementById('wbTempSlider'),
    wbTempValue: document.getElementById('wbTempValue'),
  };

  const state = {
    stream: null,
    mediaRecorder: null,
    chunks: [],
    timerInterval: null,
    timerStart: 0,
    devices: [],
    lenses: [],
    currentLensId: null,
    facingMode: 'environment',
    mode: 'photo',
    aspect: '4:3',
    desiredWidth: 1920,
    desiredHeight: 1080,
    desiredFps: 30,
    imageCapture: null,
    zoomSupported: false,
    zoomMin: 1,
    zoomMax: 1,
    torchSupported: false,
    isRecording: false,
    fsAsked: false,
    pinch: { active: false, startDist: 0, startZoom: 1 },
  };

  function log(...args) { console.log('[ProCam]', ...args); }

  function showToast(msg, ms = 2200) {
    els.toast.textContent = msg;
    els.toast.classList.remove('hidden');
    clearTimeout(els._toastTO);
    els._toastTO = setTimeout(() => els.toast.classList.add('hidden'), ms);
  }

  function setAspect(aspect) {
    state.aspect = aspect;
    const [w, h] = aspect.split(':').map(Number);
    els.previewFrame.style.aspectRatio = `${w} / ${h}`;
  }

  function mapLensName(label, index) {
    const l = (label || '').toLowerCase();
    if (l.includes('ultra') || l.includes('0.5x') || l.includes('wide-angle') || l.includes('ultra wide')) return 'Ultra Geniş';
    if (l.includes('tele') || l.includes('zoom') || l.includes('3x') || l.includes('5x')) return 'Tele';
    if (l.includes('macro')) return 'Makro';
    if (l.includes('back') || l.includes('rear') || l.includes('wide')) return 'Geniş';
    if (l.includes('front') || l.includes('user')) return 'Ön';
    return `Lens ${index+1}`;
  }

  async function ensurePermission() {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: state.facingMode }, audio: false });
      s.getTracks().forEach(t => t.stop());
    } catch (e) { log('Permission error', e); }
  }

  async function enumerateLenses() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    state.devices = devices;
    const videoInputs = devices.filter(d => d.kind === 'videoinput');

    const envCams = videoInputs.filter(d => /back|rear|environment/i.test(d.label) || !/front|user/i.test(d.label));
    const userCams = videoInputs.filter(d => /front|user/i.test(d.label));

    const list = state.facingMode === 'environment' ? envCams : userCams;
    const candidates = list.length ? list : videoInputs;

    const score = (label) => {
      const l = (label || '').toLowerCase();
      if (l.includes('ultra') || l.includes('0.5x') || l.includes('ultra wide') || l.includes('wide-angle')) return 1;
      if (l.includes('wide') || l.includes('back') || l.includes('rear')) return 2;
      if (l.includes('tele') || l.includes('zoom') || l.includes('3x') || l.includes('5x')) return 3;
      if (l.includes('macro')) return 4;
      return 9;
    };
    candidates.sort((a,b) => score(a.label) - score(b.label));

    state.lenses = candidates.map((d, i) => ({
      deviceId: d.deviceId,
      label: d.label || '',
      display: mapLensName(d.label || '', i),
    }));

    buildLensStrip();
  }

  function buildLensStrip() {
    els.lensStrip.innerHTML = '';
    state.lenses.forEach((lens) => {
      const btn = document.createElement('button');
      btn.className = 'lens-btn';
      btn.setAttribute('role', 'tab');
      btn.dataset.deviceId = lens.deviceId;
      btn.innerHTML = `<span class="dot"></span>${lens.display}`;
      btn.addEventListener('click', () => switchLens(lens.deviceId));
      els.lensStrip.appendChild(btn);
    });
    highlightActiveLens();
  }

  function highlightActiveLens() {
    const buttons = els.lensStrip.querySelectorAll('.lens-btn');
    buttons.forEach(b => b.classList.toggle('active', b.dataset.deviceId === state.currentLensId));
  }

  function parseResolution(value) {
    const [w, h] = value.split('x').map(Number);
    return { width: w, height: h };
  }

  function computeAudioConstraints() {
    // Maksimum ses kalitesi için ideal değerler
    return {
      channelCount: { ideal: 2 },
      sampleRate: { ideal: 48000 },
      sampleSize: { ideal: 16 },
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false
    };
  }

  function computeVideoConstraints() {
    const base = {
      deviceId: state.currentLensId ? { exact: state.currentLensId } : undefined,
      facingMode: state.facingMode,
      width: { ideal: state.desiredWidth },
      height: { ideal: state.desiredHeight },
      frameRate: { ideal: state.desiredFps },
    };
    Object.keys(base).forEach(k => base[k] === undefined && delete base[k]);
    return { video: base, audio: state.mode === 'video' ? computeAudioConstraints() : false };
  }

  function stopStream() {
    if (state.stream) {
      state.stream.getTracks().forEach(t => t.stop());
      state.stream = null;
      state.imageCapture = null;
      state.zoomSupported = false;
      state.torchSupported = false;
    }
  }

  async function startStream() {
    stopStream();
    const constraints = computeVideoConstraints();
    log('Starting stream with constraints', constraints);
    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      state.stream = stream;
      els.video.srcObject = stream;

      const videoTrack = stream.getVideoTracks()[0];
      const settings = videoTrack.getSettings ? videoTrack.getSettings() : {};
      log('Track settings', settings);

      // Mirror only for front camera
      if (settings.facingMode === 'user' || state.facingMode === 'user') els.previewFrame.classList.remove('mirror-off');
      else els.previewFrame.classList.add('mirror-off');

      // ImageCapture for full-res photos
      try { state.imageCapture = ('ImageCapture' in window) ? new ImageCapture(videoTrack) : null; }
      catch { state.imageCapture = null; }

      setupZoomTorch(videoTrack);
      setupManualControls(videoTrack);
      highlightActiveLens();

      // Photo modunda, önizleme 1080p olsa bile çekim sırasında maksimuma çıkacağız (takePhoto options ile)
    } catch (err) {
      log('getUserMedia failed', err);
      showToast('Kamera açılamadı. İzinleri ve https bağlantısını kontrol edin.');
    }
  }

  function setupZoomTorch(videoTrack) {
    const caps = videoTrack.getCapabilities ? videoTrack.getCapabilities() : {};
    // Zoom
    if (caps.zoom) {
      state.zoomSupported = true;
      state.zoomMin = caps.zoom.min ?? 1;
      state.zoomMax = caps.zoom.max ?? 1;
      els.zoomSlider.min = state.zoomMin;
      els.zoomSlider.max = state.zoomMax;
      els.zoomSlider.step = (state.zoomMax - state.zoomMin) / 100 || 0.01;
      const cur = videoTrack.getSettings().zoom ?? state.zoomMin;
      els.zoomSlider.value = cur;
      els.zoomValue.textContent = `${Number(cur).toFixed(1)}x`;
      els.zoomSlider.disabled = false;
    } else {
      state.zoomSupported = false;
      els.zoomSlider.disabled = true;
      els.zoomValue.textContent = `—`;
    }
    // Torch
    state.torchSupported = !!(caps.torch);
    els.torchToggle.disabled = !state.torchSupported;
  }

  function setupManualControls(videoTrack) {
    const caps = videoTrack.getCapabilities?.() || {};
    const sets = videoTrack.getSettings?.() || {};

    // Exposure Compensation
    if (caps.exposureCompensation) {
      const { min, max, step } = caps.exposureCompensation;
      els.expSlider.min = min; els.expSlider.max = max; els.expSlider.step = step || 0.1;
      const cur = sets.exposureCompensation ?? 0;
      els.expSlider.value = cur; els.expValue.textContent = String(cur);
      els.expSlider.disabled = false;
    } else {
      els.expSlider.disabled = true; els.expValue.textContent = '—';
    }

    // Focus Distance
    if (caps.focusDistance) {
      const { min, max, step } = caps.focusDistance;
      els.focusSlider.min = min; els.focusSlider.max = max; els.focusSlider.step = step || 0.01;
      const cur = sets.focusDistance ?? min;
      els.focusSlider.value = cur; els.focusValue.textContent = Number(cur).toFixed(2);
      els.focusSlider.disabled = false;
    } else {
      els.focusSlider.disabled = true; els.focusValue.textContent = '—';
    }

    // White Balance Mode + Temperature
    if (caps.whiteBalanceMode && Array.isArray(caps.whiteBalanceMode)) {
      els.wbModeSelect.innerHTML = '';
      caps.whiteBalanceMode.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m; opt.textContent = m;
        els.wbModeSelect.appendChild(opt);
      });
      els.wbModeSelect.value = sets.whiteBalanceMode || caps.whiteBalanceMode[0];
      els.wbModeSelect.disabled = false;

      if (caps.colorTemperature && els.wbModeSelect.value === 'manual') {
        const { min, max, step } = caps.colorTemperature;
        els.wbTempSlider.min = min; els.wbTempSlider.max = max; els.wbTempSlider.step = step || 1;
        const cur = sets.colorTemperature ?? min;
        els.wbTempSlider.value = cur; els.wbTempValue.textContent = `${cur}K`;
        els.wbTempSlider.disabled = false; els.wbTempWrap.style.display = '';
      } else {
        els.wbTempWrap.style.display = 'none';
      }
    } else {
      els.wbModeSelect.innerHTML = '';
      els.wbModeSelect.disabled = true;
      els.wbTempWrap.style.display = 'none';
    }
  }

  async function applyZoom(value) {
    const track = state.stream?.getVideoTracks?.()[0];
    if (!track) return;
    try {
      await track.applyConstraints({ advanced: [{ zoom: Number(value) }] });
      els.zoomValue.textContent = `${Number(value).toFixed(1)}x`;
    } catch (e1) {
      try {
        await track.applyConstraints({ zoom: Number(value) });
        els.zoomValue.textContent = `${Number(value).toFixed(1)}x`;
      } catch (e2) {
        log('Zoom not applied', e1, e2);
      }
    }
  }

  async function applyTorch(on) {
    const track = state.stream?.getVideoTracks?.()[0];
    if (!track) return;
    try { await track.applyConstraints({ advanced: [{ torch: !!on }] }); }
    catch (e) { log('Torch apply failed', e); }
  }

  async function applyExposure(value) {
    const track = state.stream?.getVideoTracks?.()[0];
    if (!track) return;
    try {
      await track.applyConstraints({ advanced: [{ exposureCompensation: Number(value) }] });
      els.expValue.textContent = String(value);
    } catch (e) { log('Exposure apply failed', e); }
  }

  async function applyFocusDistance(value) {
    const track = state.stream?.getVideoTracks?.()[0];
    if (!track) return;
    try {
      // bazı cihazlar focusMode: 'manual' ister
      try { await track.applyConstraints({ focusMode: 'manual' }); } catch {}
      await track.applyConstraints({ advanced: [{ focusDistance: Number(value) }] });
      els.focusValue.textContent = Number(value).toFixed(2);
    } catch (e) { log('Focus apply failed', e); }
  }

  async function setWhiteBalanceMode(mode) {
    const track = state.stream?.getVideoTracks?.()[0];
    if (!track) return;
    try {
      await track.applyConstraints({ whiteBalanceMode: mode });
      if (mode === 'manual') {
        const caps = track.getCapabilities?.() || {};
        if (caps.colorTemperature) {
          const { min, max, step } = caps.colorTemperature;
          els.wbTempSlider.min = min; els.wbTempSlider.max = max; els.wbTempSlider.step = step || 1;
          els.wbTempSlider.disabled = false; els.wbTempWrap.style.display = '';
        }
      } else {
        els.wbTempWrap.style.display = 'none';
      }
    } catch (e) { log('WB mode apply failed', e); }
  }

  async function applyColorTemperature(value) {
    const track = state.stream?.getVideoTracks?.()[0];
    if (!track) return;
    try {
      await track.applyConstraints({ advanced: [{ colorTemperature: Number(value) }] });
      els.wbTempValue.textContent = `${value}K`;
    } catch (e) { log('WB temp apply failed', e); }
  }

  async function switchLens(deviceId) {
    state.currentLensId = deviceId;
    await startStream();
  }

  async function switchFacing() {
    state.facingMode = state.facingMode === 'environment' ? 'user' : 'environment';
    state.currentLensId = null;
    await enumerateLenses();
    await startStream();
  }

  async function takePhoto() {
    // Shutter animasyonu
    els.previewFrame.animate([{ filter: 'brightness(1)' }, { filter: 'brightness(1.8)' }, { filter: 'brightness(1)' }], { duration: 180 });

    const [aw, ah] = state.aspect.split(':').map(Number);
    const targetRatio = aw / ah;

    let blob;

    if (state.imageCapture) {
      try {
        if (state.imageCapture.getPhotoCapabilities) {
          const pc = await state.imageCapture.getPhotoCapabilities();
          const w = pc.imageWidth?.max || undefined;
          const h = pc.imageHeight?.max || undefined;
          const opts = {};
          if (w) opts.imageWidth = w;
          if (h) opts.imageHeight = h;
          blob = await state.imageCapture.takePhoto(opts);
        } else {
          blob = await state.imageCapture.takePhoto();
        }
      } catch (e) {
        log('ImageCapture.takePhoto failed, fallback to canvas', e);
      }
    }

    if (blob) {
      // Max çözünürlükte çekildi; seçili format oranına göre merkezden kırp
      try {
        const bmp = await createImageBitmap(blob);
        const srcRatio = bmp.width / bmp.height;
        let sx=0, sy=0, sw=bmp.width, sh=bmp.height;
        if (srcRatio > targetRatio) {
          // yatay kırp
          sw = Math.round(bmp.height * targetRatio);
          sx = Math.round((bmp.width - sw) / 2);
        } else {
          // dikey kırp
          sh = Math.round(bmp.width / targetRatio);
          sy = Math.round((bmp.height - sh) / 2);
        }
        const canvas = els.photoCanvas;
        canvas.width = sw; canvas.height = sh;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, sw, sh);
        blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.98));
      } catch (e) {
        log('Crop after takePhoto failed, saving original', e);
      }
    }

    if (!blob) {
      // Canvas fallback: current video frame -> canvas, aspect crop
      const video = els.video;
      const vw = video.videoWidth, vh = video.videoHeight;
      if (!vw || !vh) { showToast('Kare yakalanamadı.'); return; }
      const srcRatio = vw/vh;
      let sx=0, sy=0, sw=vw, sh=vh;
      if (srcRatio > targetRatio) {
        sw = Math.round(vh * targetRatio); sx = Math.round((vw - sw)/2);
      } else {
        sh = Math.round(vw / targetRatio); sy = Math.round((vh - sh)/2);
      }
      const canvas = els.photoCanvas;
      canvas.width = sw; canvas.height = sh;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh);
      blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.95));
    }

    if (blob) {
      const fname = buildPhotoFilename();
      downloadBlob(blob, fname);
      showToast('Fotoğraf kaydedildi');
    }
  }

  function buildPhotoFilename() {
    const ts = new Date().toISOString().replace(/[:.]/g,'-');
    const lensName = state.lenses.find(l => l.deviceId === state.currentLensId)?.display || (state.facingMode === 'user' ? 'On' : 'Arka');
    return `photo_${ts}_${lensName}_${state.aspect}.jpg`;
  }

  function buildVideoFilename(ext = 'webm') {
    const ts = new Date().toISOString().replace(/[:.]/g,'-');
    const lensName = state.lenses.find(l => l.deviceId === state.currentLensId)?.display || (state.facingMode === 'user' ? 'On' : 'Arka');
    return `video_${ts}_${lensName}_${state.desiredWidth}x${state.desiredHeight}_${state.desiredFps}fps.${ext}`;
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; document.body.appendChild(a); a.click();
    setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 100);
  }

  function chooseBestMime() {
    const candidates = [
      'video/mp4;codecs=avc1.640028,mp4a.40.2',   // H.264 High@L4.0 + AAC LC
      'video/mp4;codecs="h264,aac"',
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm'
    ];
    for (const t of candidates) {
      if (window.MediaRecorder?.isTypeSupported?.(t)) return t;
    }
    return '';
  }

  function estimateVideoBitrate(width, height, fps) {
    // Heuristik: 0.08 bit/pixel @fps, 4K60 ~ 40-60 Mbps arası hedefle
    const bpp = 0.08;
    const v = Math.floor(width * height * fps * bpp);
    // sınırlar: 6 Mbps - 60 Mbps
    return Math.max(6_000_000, Math.min(v, 60_000_000));
  }

  function startRecording() {
    if (!state.stream) return;
    const mimeType = chooseBestMime();
    const vBps = estimateVideoBitrate(state.desiredWidth, state.desiredHeight, state.desiredFps);
    const aBps = 256_000; // 256 kbps stereo OPUS/AAC hedefi

    let options = {};
    if (mimeType) options.mimeType = mimeType;
    // bazı tarayıcılar bitsPerSecond'ı, bazıları ayrı alanları destekler
    options.videoBitsPerSecond = vBps;
    options.audioBitsPerSecond = aBps;
    try {
      state.chunks = [];
      state.mediaRecorder = new MediaRecorder(state.stream, options);
    } catch (e) {
      // fallback: options olmadan dene
      try { state.mediaRecorder = new MediaRecorder(state.stream); }
      catch (e2) { showToast('Video kaydı desteklenmiyor'); return; }
    }

    state.mediaRecorder.ondataavailable = (ev) => { if (ev.data && ev.data.size) state.chunks.push(ev.data); };
    state.mediaRecorder.onstop = () => {
      const mime = state.mediaRecorder.mimeType || mimeType || 'video/webm';
      const ext = mime.includes('mp4') ? 'mp4' : 'webm';
      const blob = new Blob(state.chunks, { type: mime });
      downloadBlob(blob, buildVideoFilename(ext));
      showToast('Video kaydedildi');
    };
    state.mediaRecorder.start(); // en yüksek kalite
    state.isRecording = true;
    updateRecordingUI(true);
    startTimer();
  }

  function stopRecording() {
    if (state.mediaRecorder && state.isRecording) state.mediaRecorder.stop();
    state.isRecording = false;
    updateRecordingUI(false);
    stopTimer();
  }

  function updateRecordingUI(on) {
    if (on) {
      els.recordBadge.classList.remove('hidden');
      els.modeToggle.classList.add('video');
      els.modeToggle.textContent = 'Kayıt…';
    } else {
      els.recordBadge.classList.add('hidden');
      els.modeToggle.classList.toggle('video', state.mode === 'video');
      els.modeToggle.textContent = state.mode === 'video' ? 'Video' : 'Fotoğraf';
    }
  }

  function startTimer() {
    state.timerStart = Date.now();
    els.timer.textContent = '00:00';
    clearInterval(state.timerInterval);
    state.timerInterval = setInterval(() => {
      const s = Math.floor((Date.now() - state.timerStart)/1000);
      const mm = String(Math.floor(s/60)).padStart(2,'0');
      const ss = String(s%60).padStart(2,'0');
      els.timer.textContent = `${mm}:${ss}`;
    }, 250);
  }

  function stopTimer() { clearInterval(state.timerInterval); }

  async function applyVideoSettingsAndRestart() {
    const { width, height } = parseResolution(els.resolutionSelect.value);
    state.desiredWidth = width;
    state.desiredHeight = height;
    state.desiredFps = Number(els.fpsSelect.value);
    await startStream();
    showToast(`Uygulandı: ${width}x${height} @ ${state.desiredFps}fps`);
  }

  // Focus point visualization
  function showFocusPoint(x, y) {
    const rect = els.previewFrame.getBoundingClientRect();
    const fx = x - rect.left;
    const fy = y - rect.top;
    els.focusPoint.style.left = `${fx}px`;
    els.focusPoint.style.top = `${fy}px`;
    els.focusPoint.classList.remove('hidden');
    els.focusPoint.animate(
      [{ transform: 'translate(-50%,-50%) scale(1.0)', opacity: 1 },
       { transform: 'translate(-50%,-50%) scale(0.9)', opacity: 0.9 }],
      { duration: 140, easing: 'ease-out' }
    );
    setTimeout(() => els.focusPoint.classList.add('hidden'), 800);
  }

  // Pinch-to-zoom
  function getTouchDist(e) {
    if (e.touches.length < 2) return 0;
    const [t1, t2] = [e.touches[0], e.touches[1]];
    const dx = t1.clientX - t2.clientX;
    const dy = t1.clientY - t2.clientY;
    return Math.hypot(dx, dy);
  }

  function bindUI() {
    els.aspectSelect.addEventListener('change', (e) => setAspect(e.target.value));

    const openSettings = () => {
      els.settingsPanel.classList.add('open');
      els.glassBackdrop.classList.add('open');
      tryFullscreen();
    };
    const closeSettings = () => {
      els.settingsPanel.classList.remove('open');
      els.glassBackdrop.classList.remove('open');
    };
    els.settingsBtn.addEventListener('click', openSettings);
    els.closeSettings.addEventListener('click', closeSettings);
    els.glassBackdrop.addEventListener('click', closeSettings);

    els.gridToggle.addEventListener('change', (e) => {
      els.gridOverlay.classList.toggle('hidden', !e.target.checked);
    });

    els.modeSelect.addEventListener('change', async (e) => {
      state.mode = e.target.value;
      els.modeToggle.textContent = state.mode === 'video' ? 'Video' : 'Fotoğraf';
      await startStream();
    });

    els.modeToggle.addEventListener('click', async () => {
      if (state.mode === 'photo') {
        state.mode = 'video';
      } else {
        if (state.isRecording) { stopRecording(); return; }
        state.mode = 'photo';
      }
      els.modeSelect.value = state.mode;
      els.modeToggle.textContent = state.mode === 'video' ? 'Video' : 'Fotoğraf';
      await startStream();
    });

    els.shutterBtn.addEventListener('click', async () => {
      tryFullscreen();
      if (state.mode === 'photo') await takePhoto();
      else { if (!state.isRecording) startRecording(); else stopRecording(); }
    });

    els.switchFacing.addEventListener('click', () => { tryFullscreen(); switchFacing(); });

    els.resolutionSelect.addEventListener('change', applyVideoSettingsAndRestart);
    els.fpsSelect.addEventListener('change', applyVideoSettingsAndRestart);

    els.zoomSlider.addEventListener('input', (e) => applyZoom(e.target.value));
    els.torchToggle.addEventListener('change', (e) => applyTorch(e.target.checked));

    // Manuel kontroller
    els.expSlider.addEventListener('input', (e) => applyExposure(e.target.value));
    els.focusSlider.addEventListener('input', (e) => applyFocusDistance(e.target.value));
    els.wbModeSelect.addEventListener('change', (e) => setWhiteBalanceMode(e.target.value));
    els.wbTempSlider.addEventListener('input', (e) => applyColorTemperature(e.target.value));

    // Tap focus UI
    els.previewFrame.addEventListener('click', (e) => { showFocusPoint(e.clientX, e.clientY); tryFullscreen(); });

    // Pinch
    els.previewFrame.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2 && state.zoomSupported) {
        state.pinch.active = true;
        state.pinch.startDist = getTouchDist(e);
        state.pinch.startZoom = Number(els.zoomSlider.value || 1);
      }
    }, { passive: false });

    els.previewFrame.addEventListener('touchmove', (e) => {
      if (state.pinch.active && e.touches.length === 2) {
        e.preventDefault();
        const dist = getTouchDist(e);
        const scale = dist / (state.pinch.startDist || dist);
        let newZoom = state.pinch.startZoom * scale;
        newZoom = Math.max(state.zoomMin, Math.min(newZoom, state.zoomMax));
        els.zoomSlider.value = newZoom;
        applyZoom(newZoom);
      }
    }, { passive: false });

    ['touchend','touchcancel'].forEach(type => {
      els.previewFrame.addEventListener(type, () => {
        state.pinch.active = false;
      });
    });

    // Desktop wheel zoom
    els.previewFrame.addEventListener('wheel', (e) => {
      if (!state.zoomSupported) return;
      e.preventDefault();
      const delta = Math.sign(e.deltaY) * -0.05; // yukarı çevirmede yakınlaştır
      let z = Number(els.zoomSlider.value || 1) + delta * (state.zoomMax - state.zoomMin);
      z = Math.max(state.zoomMin, Math.min(z, state.zoomMax));
      els.zoomSlider.value = z;
      applyZoom(z);
    }, { passive: false });

    // Disable default pinch-zoom of page
    document.addEventListener('gesturestart', (e) => e.preventDefault());

    // Keyboard (desktop)
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space') { e.preventDefault(); els.shutterBtn.click(); }
      if (e.key === 'f') switchFacing();
    });

    // Orientation / layout
    const updateOrientationClass = () => {
      const isLandscape = window.matchMedia('(orientation: landscape)').matches;
      document.body.classList.toggle('landscape', isLandscape);
      els.lensStrip.classList.toggle('vertical', isLandscape);
    };
    window.addEventListener('orientationchange', updateOrientationClass);
    window.addEventListener('resize', updateOrientationClass);
    updateOrientationClass();
  }

  function tryFullscreen() {
    if (state.fsAsked) return;
    state.fsAsked = true;
    const el = document.documentElement;
    const req = el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen;
    if (req) {
      req.call(el).catch(() => { /* iOS Safari desteklemeyebilir */ });
    }
    // Android Chrome'da adres çubuğu gizlenmesine yardımcı
    setTimeout(() => window.scrollTo(0, 1), 250);
  }

  async function init() {
    if (!navigator.mediaDevices?.getUserMedia) {
      showToast('Tarayıcınız kamera erişimini desteklemiyor.');
      return;
    }

    bindUI();
    setAspect(state.aspect);

    await ensurePermission();
    await enumerateLenses();
    state.currentLensId = state.lenses[0]?.deviceId || null;
    await startStream();

    navigator.mediaDevices.addEventListener?.('devicechange', async () => {
      await enumerateLenses();
      if (!state.lenses.find(l => l.deviceId === state.currentLensId)) {
        state.currentLensId = state.lenses[0]?.deviceId || null;
        await startStream();
      }
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();