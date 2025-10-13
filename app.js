// Pro Kamera - HTML5 getUserMedia / MediaRecorder / ImageCapture
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
  };

  function log(...args) { console.log('[Camera]', ...args); }

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
    const l = label.toLowerCase();
    if (l.includes('ultra') || l.includes('0.5x') || l.includes('wide-angle') || l.includes('ultra wide')) return 'Ultra Geniş';
    if (l.includes('tele') || l.includes('zoom') || l.includes('3x') || l.includes('5x')) return 'Tele';
    if (l.includes('macro')) return 'Makro';
    if (l.includes('back') || l.includes('rear') || l.includes('wide')) return 'Geniş';
    if (l.includes('front') || l.includes('user')) return 'Ön';
    return `Lens ${index+1}`;
  }

  async function ensurePermission() {
    try {
      // İlk izin alma (label'ların dolması için)
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: state.facingMode }, audio: false });
      s.getTracks().forEach(t => t.stop());
    } catch (e) {
      log('Permission error', e);
    }
  }

  async function enumerateLenses() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    state.devices = devices;
    const videoInputs = devices.filter(d => d.kind === 'videoinput');

    // Öncelik: environment/back kameralar
    const envCams = videoInputs.filter(d => /back|rear|environment/i.test(d.label) || !/front|user/i.test(d.label));
    const userCams = videoInputs.filter(d => /front|user/i.test(d.label));

    const list = (state.facingMode === 'environment' ? envCams : userCams);
    // Belirsiz durumda tümünü kullan
    const candidates = list.length ? list : videoInputs;

    // Sırala: Ultra geniş -> Geniş -> Tele -> Makro -> Diğer
    const score = (label) => {
      const l = label.toLowerCase();
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
    state.lenses.forEach((lens, idx) => {
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
    buttons.forEach(b => {
      if (b.dataset.deviceId === state.currentLensId) b.classList.add('active');
      else b.classList.remove('active');
    });
  }

  function parseResolution(value) {
    const [w, h] = value.split('x').map(Number);
    return { width: w, height: h };
  }

  function computeVideoConstraints() {
    const base = {
      deviceId: state.currentLensId ? { exact: state.currentLensId } : undefined,
      facingMode: state.facingMode,
      width: { ideal: state.desiredWidth },
      height: { ideal: state.desiredHeight },
      frameRate: { ideal: state.desiredFps },
      // advanced: [{ aspectRatio: w/h }] // genellikle ihmal ediliyor
    };
    // Remove undefined to avoid errors
    Object.keys(base).forEach(k => base[k] === undefined && delete base[k]);
    return { video: base, audio: state.mode === 'video' ? true : false };
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
      if (settings.facingMode === 'user' || state.facingMode === 'user') {
        els.previewFrame.classList.remove('mirror-off');
      } else {
        els.previewFrame.classList.add('mirror-off');
      }

      // ImageCapture (foto kalitesi ve hızlı çekim için)
      try {
        state.imageCapture = ('ImageCapture' in window) ? new ImageCapture(videoTrack) : null;
      } catch (e) {
        state.imageCapture = null;
      }

      setupZoomTorch(videoTrack);
      highlightActiveLens();
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
    state.torchSupported = !!caps.torch;
    els.torchToggle.disabled = !state.torchSupported;
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
    try {
      await track.applyConstraints({ advanced: [{ torch: !!on }] });
    } catch (e) {
      log('Torch apply failed', e);
    }
  }

  async function switchLens(deviceId) {
    state.currentLensId = deviceId;
    await startStream();
  }

  async function switchFacing() {
    state.facingMode = state.facingMode === 'environment' ? 'user' : 'environment';
    // Facing değişince uygun lens listesini tekrar çıkar
    state.currentLensId = null;
    await enumerateLenses();
    await startStream();
  }

  async function takePhoto() {
    // Shutter animasyonu
    els.previewFrame.animate([{ filter: 'brightness(1)' }, { filter: 'brightness(1.8)' }, { filter: 'brightness(1)' }], { duration: 180 });

    const [aw, ah] = state.aspect.split(':').map(Number);
    let blob;
    if (state.imageCapture && state.imageCapture.takePhoto) {
      try {
        blob = await state.imageCapture.takePhoto();
      } catch (e) {
        log('ImageCapture.takePhoto failed, fallback to canvas', e);
      }
    }

    if (!blob) {
      // Canvas fallback: current video frame -> canvas, aspect crop
      const video = els.video;
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!vw || !vh) {
        showToast('Kare yakalanamadı.');
        return;
      }
      const targetRatio = aw/ah;
      const srcRatio = vw/vh;
      let sx=0, sy=0, sw=vw, sh=vh;
      if (srcRatio > targetRatio) {
        // fazla geniş, yatay kırp
        sw = Math.round(vh * targetRatio);
        sx = Math.round((vw - sw)/2);
      } else {
        // fazla yüksek, dikey kırp
        sh = Math.round(vw / targetRatio);
        sy = Math.round((vh - sh)/2);
      }
      const canvas = els.photoCanvas;
      canvas.width = sw;
      canvas.height = sh;
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

  function buildVideoFilename(mime = 'webm') {
    const ts = new Date().toISOString().replace(/[:.]/g,'-');
    const lensName = state.lenses.find(l => l.deviceId === state.currentLensId)?.display || (state.facingMode === 'user' ? 'On' : 'Arka');
    return `video_${ts}_${lensName}_${state.desiredWidth}x${state.desiredHeight}_${state.desiredFps}fps.${mime}`;
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      a.remove();
      URL.revokeObjectURL(url);
    }, 100);
  }

  function chooseBestMime() {
    const candidates = [
      'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
      'video/mp4;codecs="h264,aac"',
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm'
    ];
    for (const t of candidates) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) return t;
    }
    return '';
  }

  function startRecording() {
    if (!state.stream) return;
    const mimeType = chooseBestMime();
    try {
      state.chunks = [];
      state.mediaRecorder = new MediaRecorder(state.stream, mimeType ? { mimeType } : undefined);
    } catch (e) {
      showToast('Video kaydı desteklenmiyor');
      return;
    }
    state.mediaRecorder.ondataavailable = (ev) => { if (ev.data && ev.data.size) state.chunks.push(ev.data); };
    state.mediaRecorder.onstop = () => {
      const blob = new Blob(state.chunks, { type: state.mediaRecorder.mimeType || 'video/webm' });
      const ext = (state.mediaRecorder.mimeType || '').includes('mp4') ? 'mp4' : 'webm';
      downloadBlob(blob, buildVideoFilename(ext));
      showToast('Video kaydedildi');
    };
    state.mediaRecorder.start(); // no timeslice, max quality
    state.isRecording = true;
    updateRecordingUI(true);
    startTimer();
  }

  function stopRecording() {
    if (state.mediaRecorder && state.isRecording) {
      state.mediaRecorder.stop();
    }
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

  function stopTimer() {
    clearInterval(state.timerInterval);
  }

  async function applyVideoSettingsAndRestart() {
    const { width, height } = parseResolution(els.resolutionSelect.value);
    state.desiredWidth = width;
    state.desiredHeight = height;
    state.desiredFps = Number(els.fpsSelect.value);
    await startStream();
    showToast(`Uygulandı: ${width}x${height} @ ${state.desiredFps}fps`);
  }

  // Focus point visualization (touch to focus UI only; real focus via constraints not broadly supported)
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

  function bindUI() {
    els.aspectSelect.addEventListener('change', (e) => setAspect(e.target.value));

    els.settingsBtn.addEventListener('click', () => els.settingsPanel.classList.add('open'));
    els.closeSettings.addEventListener('click', () => els.settingsPanel.classList.remove('open'));

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
        if (state.isRecording) {
          stopRecording();
          return;
        }
        state.mode = 'photo';
      }
      els.modeSelect.value = state.mode;
      els.modeToggle.textContent = state.mode === 'video' ? 'Video' : 'Fotoğraf';
      await startStream();
    });

    els.shutterBtn.addEventListener('click', async () => {
      if (state.mode === 'photo') {
        await takePhoto();
      } else {
        if (!state.isRecording) startRecording();
        else stopRecording();
      }
    });

    els.switchFacing.addEventListener('click', switchFacing);

    els.resolutionSelect.addEventListener('change', applyVideoSettingsAndRestart);
    els.fpsSelect.addEventListener('change', applyVideoSettingsAndRestart);

    els.zoomSlider.addEventListener('input', (e) => applyZoom(e.target.value));
    els.torchToggle.addEventListener('change', (e) => applyTorch(e.target.checked));

    // Tap to show focus point (visual)
    els.previewFrame.addEventListener('click', (e) => {
      showFocusPoint(e.clientX, e.clientY);
    });

    // Prevent pinch zoom page
    document.addEventListener('gesturestart', (e) => e.preventDefault());

    // Keyboard (desktop)
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space') { e.preventDefault(); els.shutterBtn.click(); }
      if (e.key === 'f') switchFacing();
    });
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
    // Varsayılan olarak ilk lens
    state.currentLensId = state.lenses[0]?.deviceId || null;
    await startStream();

    // Cihaz listesi değişirse (tak-çıkar)
    navigator.mediaDevices.addEventListener?.('devicechange', async () => {
      await enumerateLenses();
      if (!state.lenses.find(l => l.deviceId === state.currentLensId)) {
        state.currentLensId = state.lenses[0]?.deviceId || null;
        await startStream();
      }
    });
  }

  // iOS/Safari autoplay policy için interaction beklemek gerekebilir
  document.addEventListener('DOMContentLoaded', init);
})();