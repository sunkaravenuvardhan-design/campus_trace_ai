(() => {
  const $ = (s) => document.querySelector(s);
  const stage = $('#media-stage');
  const empty = $('#empty-state');
  const layer = $('#media-layer');
  const fileInput = $('#file-input');
  const progress = $('#progress-state');
  const scanLine = $('#scan-line');
  const videoControls = $('#video-controls');
  const modes = document.querySelectorAll('.mode-btn');
  let mode = 'photo';
  let currentUrl = null;
  let currentKind = null;
  let stream = null;
  let cameraFacing = 'user';
  let cameraSession = 0;
  let lastLiveFaces = null;
  let detectInterval = null;
  let detector = null;
  let detectorPromise = null;
  let lastCount = -1;
  let videoPlaying = false;
  let videoScanInterval = null;
  let videoScanBusy = false;
  let previousVideoBoxes = [];
  let historyMedia;
  let presentStudents = new Map();
  const matchStudents = $('#match-students');
  matchStudents.checked = false;
  const enrollmentPanel = document.querySelector('.student-enrollment');
  enrollmentPanel.hidden = true;
  let scanVersion = 0;
  matchStudents.addEventListener('change', () => {
    lastLiveFaces = null;
    scanVersion++;
    enrollmentPanel.hidden = !matchStudents.checked;
    $('#matching-status').hidden = !matchStudents.checked;
    clearBoxes();
    previousVideoBoxes = [];
    $('#matching-status').textContent = '';
    if (currentKind === 'photo' || currentKind === 'video') scanMedia();
  });

  let enrollmentModels;
  async function loadEnrollmentModels() {
    if (!window.faceapi) {
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/face-api.js@0.22.2/dist/face-api.min.js';
        script.onload = resolve;
        script.onerror = reject;
        document.head.append(script);
      });
    }
    const api = window.faceapi;
    const weights = 'https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@0.22.2/weights';
    await Promise.all([api.nets.tinyFaceDetector, api.nets.faceLandmark68TinyNet, api.nets.faceRecognitionNet]
      .map(net => net.loadFromUri(weights)));
    return api;
  }

  function getRecognitionModels() {
    enrollmentModels ??= loadEnrollmentModels().catch(error => {
      enrollmentModels = null;
      throw error;
    });
    return enrollmentModels;
  }

  async function describeFaces(api, image) {
    const scan = (inputSize, scoreThreshold) => api.detectAllFaces(image,
      new api.TinyFaceDetectorOptions({ inputSize, scoreThreshold }))
      .withFaceLandmarks(true).withFaceDescriptors();
    const faces = await scan(608, 0.5);
    if (faces.length || image.tagName !== 'IMG') return faces;
    return scan(416, 0.25);
  }

  async function decodeOriginalPhoto(url) {
    const photo = new Image();
    photo.src = url;
    await photo.decode();
    return photo;
  }

  function openStudents() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('framewise-students', 2);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('students')) db.createObjectStore('students', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('history')) db.createObjectStore('history', { autoIncrement: true });
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
  }

  const historyDate = new Intl.DateTimeFormat(undefined, {dateStyle: 'short', timeStyle: 'medium'});
  const historyToggle = $('#history-toggle');
  const historyResults = $('#history-results');
  const resetHistory = $('#reset-history');
  let historyVersion = 0;
  resetHistory.addEventListener('click', async () => {
    if (resetHistory.disabled || !window.confirm('Clear all saved match history on this browser? Enrolled students will be kept.')) return;
    resetHistory.disabled = true;
    historyVersion++;
    showHistory(true);
    enableHistoryResults();
    try {
      const db = await openStudents();
      try {
        await new Promise((resolve, reject) => {
          const tx = db.transaction('history', 'readwrite');
          tx.oncomplete = resolve;
          tx.onabort = () => reject(tx.error);
          tx.objectStore('history').clear();
        });
      } finally { db.close(); }
      $('#match-history').replaceChildren();
      $('#history-message').textContent = 'No matches recorded yet.';
      presentStudents = new Map();
    } catch {
      loadSidebar();
      $('#history-message').textContent = 'Could not reset match history.';
    } finally { resetHistory.disabled = false; }
  });
  function showHistory(visible) {
    historyResults.hidden = !visible;
    historyToggle.setAttribute('aria-expanded', String(visible));
    historyToggle.textContent = visible ? 'Hide results' : 'Show results';
  }
  historyToggle.addEventListener('click', () => showHistory(historyResults.hidden));

  function enableHistoryResults() {
    historyToggle.disabled = false;
  }
  function historyRow(entry) {
    const row = document.createElement('li');
    const heading = document.createElement('strong');
    heading.textContent = entry.description || 'ID ' + entry.id;
    const details = document.createElement('div');
    details.textContent = historyDate.format(entry.time) + ' · ' + entry.source;
    row.append(heading, details);
    return row;
  }

  async function loadSidebar() {
    const version = historyVersion;
    try {
      const db = await openStudents();
      const tx = db.transaction(['students', 'history']);
      const ids = tx.objectStore('students').getAllKeys();
      const history = tx.objectStore('history').getAll();
      tx.oncomplete = () => {
        db.close();
        $('#student-total').textContent = ids.result.length;
        const select = $('#remove-id');
        const selected = select.value;
        select.replaceChildren(new Option(ids.result.length ? 'Choose a student ID' : 'No saved IDs', ''),
          ...ids.result.map(id => new Option(id, id)));
        if (ids.result.includes(selected)) select.value = selected;
        $('#remove-student').disabled = !select.value;
        if (version !== historyVersion || resetHistory.disabled) return;
        if (history.result.length) enableHistoryResults();
        $('#match-history').replaceChildren(...history.result.reverse().map(historyRow));
        $('#history-message').textContent = history.result.length ? '' : 'No matches recorded yet.';
      };
      tx.onabort = () => { db.close(); $('#history-message').textContent = 'Could not read local records.'; };
    } catch {
      $('#history-message').textContent = 'Local records unavailable.';
    }
  }
  loadSidebar();

  $('#manage-students').addEventListener('click', () => {
    const panel = $('#student-manager');
    panel.hidden = !panel.hidden;
    $('#manage-students').setAttribute('aria-expanded', String(!panel.hidden));
    if (!panel.hidden) {
      loadSidebar();
      $('#remove-id').focus();
    }
  });
  $('#remove-id').addEventListener('change', () => {
    $('#remove-student').disabled = !$('#remove-id').value;
    $('#remove-status').textContent = '';
  });
  $('#remove-student').addEventListener('click', async () => {
    const select = $('#remove-id');
    const id = select.value;
    if (!id || select.disabled) return;
    select.disabled = true;
    $('#remove-student').disabled = true;
    try {
      const db = await openStudents();
      try {
        await new Promise((resolve, reject) => {
          const tx = db.transaction('students', 'readwrite');
          tx.oncomplete = resolve;
          tx.onabort = () => reject(tx.error);
          tx.objectStore('students').delete(id);
        });
      } finally { db.close(); }
      scanVersion++;
      lastLiveFaces = null;
      select.value = '';
      $('#remove-status').textContent = 'Removed ID ' + id + '.';
      loadSidebar();
      if (matchStudents.checked && currentKind) {
        clearBoxes();
        if (currentKind === 'photo' || currentKind === 'video') scanMedia();
      }
    } catch {
      $('#remove-status').textContent = 'Could not remove this ID. Try again.';
    } finally {
      select.disabled = false;
      $('#remove-student').disabled = !select.value;
    }
  });

  async function recordMatches(faces, media) {
    if (!matchStudents.checked || resetHistory.disabled) return;
    const version = historyVersion;
    if (media !== historyMedia) {
      historyMedia = media;
      presentStudents = new Map();
    }
    const presence = presentStudents;
    const now = Date.now();
    const sightings = new Map();
    faces.forEach((face, index) => {
      if (face.studentId) {
        sightings.set(JSON.stringify(['id', face.studentId]), { id: face.studentId });
      } else if (face.candidateIds) {
        const key = JSON.stringify(['possible', index, ...face.candidateIds.slice().sort()]);
        sightings.set(key, { description: 'Face ' + (index + 1) + ' — ' + face.label });
      }
    });
    const entries = [];
    for (const [id, missingSince] of presence) {
      if (!sightings.has(id) && missingSince === null) presence.set(id, now);
      else if (missingSince !== null && now - missingSince >= 5000) presence.delete(id);
    }
    for (const [id, sighting] of sightings) {
      if (!presence.has(id)) {
        const source = currentKind === 'camera' ? 'Live camera' : currentKind === 'video' ? 'Uploaded video' : 'Photo';
        entries.push({ key: id, ...sighting, time: now, source });
      }
      presence.set(id, null);
    }
    if (!entries.length) return;
    try {
      const db = await openStudents();
      try {
        if (version !== historyVersion) return;
        await new Promise((resolve, reject) => {
          const tx = db.transaction('history', 'readwrite');
          tx.oncomplete = resolve;
          tx.onabort = () => reject(tx.error);
          for (const entry of entries) tx.objectStore('history').add(entry);
        });
      } finally { db.close(); }
      if (version !== historyVersion) return;
      for (const entry of entries) $('#match-history').prepend(historyRow(entry));
      enableHistoryResults();
      showHistory(true);
      $('#history-message').textContent = '';
    } catch {
      for (const entry of entries) presence.delete(entry.key);
      $('#history-message').textContent = 'Match history could not be saved.';
    }
  }

  async function saveStudent(id, descriptor) {
    const db = await openStudents();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('students', 'readwrite');
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onabort = () => { db.close(); reject(tx.error); };
        tx.objectStore('students').add({ id, descriptor, model: 'face-api.js-0.22.2' });
    });
  }

  $('#student-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = form.querySelector('fieldset');
    if (fields.disabled) return;
    const status = $('#student-status');
    const id = form.elements.studentId.value.trim();
    const file = form.elements.portrait.files[0];
    if (!id || !file) {
      status.textContent = 'Enter a student ID and choose a photo.';
      return;
    }
    fields.disabled = true;
    const url = URL.createObjectURL(file);
    let failure = 'This image could not be opened. Try a JPG or PNG.';
    try {
      const photo = await decodeOriginalPhoto(url);
      status.textContent = 'Preparing face recognition…';
      failure = 'Could not load face recognition. Check your connection and try again.';
      const api = await getRecognitionModels();
      failure = 'Could not read the face. Try a clear, front-facing photo.';
      status.textContent = 'Checking the photo…';
      const faces = await describeFaces(api, photo);
      if (faces.length !== 1) {
        status.textContent = faces.length ? 'Several faces detected. Choose a photo of just this student.' : 'No face detected. Choose a clearer photo.';
        return;
      }
      const descriptor = faces[0].descriptor;
      if (descriptor.length !== 128 || !descriptor.every(Number.isFinite)) throw new Error('Invalid face descriptor');
      failure = 'Could not save this student. Check that browser storage is available.';
      await saveStudent(id, descriptor);
      loadSidebar();
      form.reset();
      status.textContent = 'Student ' + id + ' saved in this browser.';
      if (currentKind === 'photo') scanMedia();
    } catch (error) {
      status.textContent = error?.name === 'ConstraintError' ? 'This student ID is already enrolled.' : failure;
    } finally {
      URL.revokeObjectURL(url);
      fields.disabled = false;
    }
  });

  $('#year').textContent = new Date().getFullYear();
  $('#session-number').textContent = `FW${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

  function isLikelyFace({ boundingBox, score }) {
    const { width, height } = boundingBox || {};
    const ratio = width / height;
    // Favor clear, face-like detections; broad shapes are more likely to be hands or objects.
    return score >= 0.62 && width > 0 && height > 0 && ratio >= 0.68 && ratio <= 1.4;
  }

  async function getDetector() {
    if (detector) return detector;
    if (detectorPromise) return detectorPromise;

    detectorPromise = (async () => {
      // MediaPipe runs locally. Try both public CDNs because embedded previews
      // can block one host even when the other is reachable.
      const cdns = [
        'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14',
        'https://unpkg.com/@mediapipe/tasks-vision@0.10.14'
      ];
      for (const cdn of cdns) {
        try {
          const vision = await import(`${cdn}/vision_bundle.mjs`);
          const files = await vision.FilesetResolver.forVisionTasks(`${cdn}/wasm`);
                              const options = {
            baseOptions: {
              // Keep the short-range model: its 896 anchors match this detector graph.
              modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite',
              delegate: 'GPU'
            },
            runningMode: 'IMAGE',
                        // Favor confident face matches to reduce hand/object false positives.
              minDetectionConfidence: 0.62,
              minSuppressionThreshold: 0.58,
              maxResults: 100
          };
          let task;
          try {
            task = await vision.FaceDetector.createFromOptions(files, options);
          } catch (_) {
            options.baseOptions.delegate = 'CPU';
            task = await vision.FaceDetector.createFromOptions(files, options);
          }
          detector = {
            detect: async (media) => {
              const result = await task.detect(media);
              return (result?.detections || []).map((item) => {
                const box = item.boundingBox || {};
                const score = item.categories?.[0]?.score ?? item.score ?? 0;
                return {
                  boundingBox: {
                    x: box.originX ?? box.x ?? 0,
                    y: box.originY ?? box.y ?? 0,
                    width: box.width ?? 0,
                    height: box.height ?? 0
                  },
                  score
                };
              }).filter(isLikelyFace);
            }
          };
          return detector;
        } catch (error) {
          console.warn(`Face detector could not load from ${cdn}`, error);
        }
      }

      // Keep native detection as a final local fallback where the browser has it.
      if ('FaceDetector' in window) {
        try {
          const native = new FaceDetector({ fastMode: true, maxDetectedFaces: 30 });
          detector = {
            detect: async (media) => (await native.detect(media)).map((item) => ({
              boundingBox: item.boundingBox,
              score: item.confidence ?? 0.9
            })).filter(isLikelyFace)
          };
          return detector;
        } catch (error) {
          console.warn('Native face detector could not start', error);
        }
      }
      detectorPromise = null;
      return null;
    })();

    return detectorPromise;
  }

  function setStatus(label, style = 'idle') {
    const badge = $('#status-badge');
    badge.textContent = label;
    badge.className = 'rounded-full px-2.5 py-1 text-[9px] font-bold uppercase tracking-wider';
    if (style === 'live') badge.classList.add('bg-red-50', 'text-red-600');
    else if (style === 'done') badge.classList.add('bg-emerald-50', 'text-emerald-700');
    else if (style === 'working') badge.classList.add('bg-indigo-50', 'text-indigo-600');
    else badge.classList.add('bg-slate-100', 'text-slate-400');
  }

  function updateResults(count, source, confidence = null) {
    lastCount = count;
    $('#face-count').textContent = String(count);
    $('#face-count').className = `mt-1 font-display text-[42px] font-extrabold leading-none tracking-[-.06em] ${count ? 'text-slate-900' : 'text-slate-900'}`;
    $('#result-icon').className = `flex h-10 w-10 items-center justify-center rounded-xl ${count ? 'bg-emerald-100 text-emerald-600' : 'bg-slate-100 text-slate-400'}`;
    $('#confidence-bar').style.width = count ? `${Math.round((confidence || .91) * 100)}%` : '0%';
    $('#confidence-value').textContent = count ? `${Math.round((confidence || .91) * 100)}%` : '—';
    $('#result-message').innerHTML = count ?
      `<strong class="font-bold text-slate-700">${count} human face${count === 1 ? '' : 's'} detected.</strong> ${source === 'camera' || (source === 'video' && videoPlaying) ? 'Live markers update as the video plays.' : 'Green outlines mark the face regions.'}` :
      `<strong class="font-bold text-slate-700">No human faces found.</strong> Objects, animals, and non-face shapes are not counted.`;
    $('#detail-source').textContent = source === 'camera' ? 'Live camera' : source === 'video' ? 'Recorded video' : 'Photo';
    $('#detail-time').textContent = new Date().toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit'
    });
    setStatus(source === 'camera' || (source === 'video' && videoPlaying) ? 'Live' : 'Complete', source === 'camera' || (source === 'video' && videoPlaying) ? 'live' : 'done');
  }

  function showProgress(label = 'Finding human faces…') {
    $('#progress-label').textContent = label;
    progress.classList.remove('hidden');
    progress.classList.add('flex');
    scanLine.classList.remove('hidden');
  }

  function hideProgress() {
    progress.classList.add('hidden');
    progress.classList.remove('flex');
    scanLine.classList.add('hidden');
  }

  function clearBoxes() {
    layer.querySelectorAll('.face-box').forEach((box) => box.remove());
  }

  function drawBoxes(faces, sourceWidth, sourceHeight) {
    clearBoxes();
    const media = layer.querySelector('img, video');
    if (!media || !sourceWidth || !sourceHeight) return;
    recordMatches(faces, media);
    const rect = media.getBoundingClientRect();
    const layerRect = layer.getBoundingClientRect();
    const scale = Math.min(rect.width / sourceWidth, rect.height / sourceHeight);
    const renderedW = sourceWidth * scale;
    const renderedH = sourceHeight * scale;
    const offsetX = rect.left - layerRect.left + (rect.width - renderedW) / 2;
    const offsetY = rect.top - layerRect.top + (rect.height - renderedH) / 2;
    faces.forEach(({ boundingBox: box, label }) => {
      const el = document.createElement('div');
      el.className = 'face-box';
      if (label) {
        const tag = document.createElement('span');
        tag.className = 'face-tag';
        tag.textContent = label;
        el.appendChild(tag);
      }
      el.style.left = `${offsetX + box.x * scale}px`;
      el.style.top = `${offsetY + box.y * scale}px`;
      el.style.width = `${Math.max(16, box.width * scale)}px`;
      el.style.height = `${Math.max(16, box.height * scale)}px`;
      layer.appendChild(el);
    });
  }

  function detectorUnavailable() {
    clearBoxes();
    $('#result-message').innerHTML = '<strong class="font-bold text-slate-700">Face detector could not be loaded.</strong> Check your internet connection and try scanning again. The detection model runs in your browser; your media is not uploaded.';
    setStatus('Unavailable', 'idle');
  }

  function boxOverlap(a, b) {
    const left = Math.max(a.x, b.x);
    const top = Math.max(a.y, b.y);
    const right = Math.min(a.x + a.width, b.x + b.width);
    const bottom = Math.min(a.y + a.height, b.y + b.height);
    const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
    const smallerArea = Math.min(a.width * a.height, b.width * b.height);
    return smallerArea ? intersection / smallerArea : 0;
  }

  function removeDuplicateFaces(faces) {
    const ranked = [...faces].sort((a, b) => b.score - a.score);
    const unique = [];
    for (const candidate of ranked) {
      const duplicate = unique.some((kept) => boxOverlap(kept.boundingBox, candidate.boundingBox) > 0.7);
      if (!duplicate) unique.push(candidate);
    }
    return unique;
  }

  async function readStudents() {
    const db = await openStudents();
    try {
      return await new Promise((resolve, reject) => {
        const request = db.transaction('students').objectStore('students').getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally {
      db.close();
    }
  }

  function rankStudents(api, descriptor, students) {
    return students.map(student => ({
      id: student.id,
      distance: api.euclideanDistance(descriptor, student.descriptor)
    })).sort((a, b) => a.distance - b.distance);
  }

  function studentMatch(api, descriptor, students) {
    const ranked = rankStudents(api, descriptor, students);
    const [first, second] = ranked;
    if (!first || !Number.isFinite(first.distance)) return { label: 'Unknown' };
    // A similarity score for display, not a calibrated identity probability.
    const score = 100 / (1 + first.distance);
    if (score < 50) return { label: 'Unknown' };
    const suffix = ' · ' + Math.round(score) + '% match score';
    if (second && second.distance - first.distance < 0.05) {
      const secondScore = Math.round(100 / (1 + second.distance));
      return { candidateIds: [first.id, second.id], label: 'Possible IDs: ' + first.id + ' (' + Math.round(score) + '%) or ' +
        second.id + ' (' + secondScore + '%)' };
    }
    const prefix = first.distance <= 0.5 ? 'ID ' : 'Possible ID ';
    return { label: prefix + first.id + suffix, studentId: first.distance <= 0.5 ? first.id : null };
  }

  function recordedVideoMatches(api, results, students) {
    const matches = results.map(() => ({ label: 'Unknown' }));
    const claims = new Map();
    results.forEach((result, index) => {
      const [first, second] = rankStudents(api, result.descriptor, students);
      if (!first || !Number.isFinite(first.distance)) return;
      const group = claims.get(first.id) || [];
      group.push({ index, distance: first.distance, runnerUp: second?.distance ?? Infinity });
      claims.set(first.id, group);
    });
    for (const [id, group] of claims) {
      group.sort((a, b) => a.distance - b.distance);
      const [best, rival] = group;
      // Require separation both from other enrolled IDs and from faces claiming this ID.
      if (best.distance > 0.5 || best.runnerUp - best.distance < 0.05) continue;
      if (rival && rival.distance - best.distance < 0.05) continue;
      matches[best.index] = { studentId: id,
        label: 'ID ' + id + ' · ' + Math.round(100 / (1 + best.distance)) + '% match score' };
    }
    return matches;
  }

  async function identifyFaces(frame, detected, recordedVideo = false) {
    const status = $('#matching-status');
    try {
      const students = await readStudents();
      if (!students.length) {
        status.textContent = 'No saved students in this browser.';
        return detected.map(face => ({ ...face, label: 'Unknown' }));
      }
      const api = await getRecognitionModels();
      const results = await describeFaces(api, frame);
      const matches = recordedVideo ? recordedVideoMatches(api, results, students)
        : results.map(result => studentMatch(api, result.descriptor, students));
      const recognized = results.map((result, index) => {
        const { x, y, width, height } = result.detection.box;
        return { boundingBox: { x, y, width, height }, score: result.detection.score,
          ...matches[index] };
      });
      const additional = detected.filter(face => !recognized.some(
        result => boxOverlap(result.boundingBox, face.boundingBox) > 0.5
      ));
      status.textContent = 'Matching against ' + students.length + ' saved student' + (students.length === 1 ? '.' : 's.');
      const closeMatches = recognized.filter(face => face.label.startsWith('Possible IDs:'));
      if (closeMatches.length) status.textContent += ' ' + closeMatches.map(face => face.label).join('. ');
      if (frame.tagName === 'IMG' && detected.length && !results.length) {
        status.textContent += ' A face was detected, but the matcher could not read it.';
      } else if (frame.tagName === 'IMG' && recognized.some(face => face.label === 'Unknown')) {
        status.textContent += ' The face comparison did not identify a single confident ID.';
      }
      return [...recognized, ...additional.map(face => ({ ...face, label: 'Unknown' }))];
    } catch (error) {
      console.warn('Student matching failed:', error);
      status.textContent = 'Matching unavailable. Check browser storage and the connection for loading the face model.';
      return detected.map(face => ({ ...face, label: 'Match unavailable' }));
    }
  }

  function freezeFrame(video) {
    const frame = document.createElement('canvas');
    frame.width = video.videoWidth;
    frame.height = video.videoHeight;
    frame.getContext('2d').drawImage(video, 0, 0);
    return frame;
  }

  async function detectDenseFaces(faceDetector, media, reportProgress = false) {
    const width = media.naturalWidth || media.videoWidth;
    const height = media.naturalHeight || media.videoHeight;
    if (width < 2 || height < 2) return faceDetector.detect(media);

    // Freeze each video scan to one frame so crops cannot accidentally come from
    // different moments while the clip keeps playing.
    // Use the same original-size image as enrollment, independent of preview layout.
    const match = matchStudents.checked;
    let source = match && media.tagName === 'IMG' ? await decodeOriginalPhoto(media.currentSrc || media.src) : media;
    if (media.tagName === 'VIDEO') {
      const frame = document.createElement('canvas');
      frame.width = width;
      frame.height = height;
      const frameContext = frame.getContext('2d');
      if (frameContext) {
        frameContext.drawImage(media, 0, 0, width, height);
        source = frame;
      }
    }
    const fullFrame = await faceDetector.detect(source);
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { willReadFrequently: false });
    if (!context) return match ? identifyFaces(source, fullFrame, media.tagName === 'VIDEO') : fullFrame;

    // Run a detailed overlapping grid on photos and video frames so distant
    // people are enlarged for the detector instead of being lost in the full frame.
    const isVideo = media.tagName === 'VIDEO';
    const tileScale = isVideo ? 0.5 : 0.34;
    const tileWidth = Math.ceil(width * tileScale);
    const tileHeight = Math.ceil(height * tileScale);
    const upscale = isVideo ? 1.8 : 2.2;
    const outputScale = Math.min(upscale, 1600 / Math.max(tileWidth, tileHeight));
    canvas.width = Math.max(1, Math.ceil(tileWidth * outputScale));
    canvas.height = Math.max(1, Math.ceil(tileHeight * outputScale));
    const starts = (length, tile) => {
      const last = Math.max(0, length - tile);
      const count = Math.max(2, Math.ceil(last / (tile * 0.72)) + 1);
      return [...new Set(Array.from({ length: count }, (_, index) => Math.round(last * index / (count - 1))))];
    };
    const xStarts = starts(width, tileWidth);
    const yStarts = starts(height, tileHeight);
    const totalTiles = xStarts.length * yStarts.length;
    const combined = [...fullFrame];
    let tileIndex = 0;
    for (const y of yStarts) {
      for (const x of xStarts) {
        tileIndex += 1;
        if (reportProgress) $('#progress-label').textContent = `Checking photo region ${tileIndex} of ${totalTiles}…`;
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.drawImage(source, x, y, tileWidth, tileHeight, 0, 0, canvas.width, canvas.height);
        const detections = await faceDetector.detect(canvas);
        detections.forEach((face) => {
          const local = face.boundingBox;
          combined.push({
            ...face,
            boundingBox: {
              x: x + local.x * (tileWidth / canvas.width),
              y: y + local.y * (tileHeight / canvas.height),
              width: local.width * (tileWidth / canvas.width),
              height: local.height * (tileHeight / canvas.height)
            }
          });
        });
      }
    }
    const faces = removeDuplicateFaces(combined);
    return match ? identifyFaces(source, faces, isVideo) : faces;
  }

  function stabilizeVideoFaces(faces) {
    const usedPrevious = new Set();
    const stabilized = faces.map((face) => {
      let bestIndex = -1;
      let bestOverlap = 0.2;
      previousVideoBoxes.forEach((previous, index) => {
        if (usedPrevious.has(index)) return;
        const overlap = boxOverlap(previous.boundingBox, face.boundingBox);
        if (overlap > bestOverlap) {
          bestOverlap = overlap;
          bestIndex = index;
        }
      });
      if (bestIndex < 0) return face;
      usedPrevious.add(bestIndex);
      const old = previousVideoBoxes[bestIndex].boundingBox;
      const fresh = face.boundingBox;
      const blend = (key) => old[key] * 0.25 + fresh[key] * 0.75;
      return { ...face, boundingBox: { x: blend('x'), y: blend('y'), width: blend('width'), height: blend('height') } };
    });
    previousVideoBoxes = stabilized;
    return stabilized;
  }

  async function scanMedia() {
    const version = scanVersion;
    const media = layer.querySelector('img, video');
    if (!media) return;
    showProgress();
    setStatus('Scanning', 'working');
    await new Promise((resolve) => setTimeout(resolve, 180));
    const faceDetector = await getDetector();
    const isPhoto = media.tagName === 'IMG';
    if (!faceDetector && !(isPhoto && matchStudents.checked)) {
      hideProgress();
      detectorUnavailable();
      return;
    }
    try {
      const faces = faceDetector ? await detectDenseFaces(faceDetector, media, isPhoto)
        : await identifyFaces(await decodeOriginalPhoto(media.currentSrc || media.src), []);
      if (version !== scanVersion || layer.querySelector('img, video') !== media) return;
      drawBoxes(faces, media.videoWidth || media.naturalWidth, media.videoHeight || media.naturalHeight);
      if (isPhoto) enableHistoryResults();
      const confidence = faces.length ? faces.reduce((sum, face) => sum + face.score, 0) / faces.length : 0;
      updateResults(faces.length, currentKind || 'photo', confidence);
      if (isPhoto && !faces.length) {
        $('#result-message').innerHTML = '<strong class="font-bold text-slate-700">No clear human faces found.</strong> This photo was scanned in overlapping regions to catch smaller faces. Try a sharper original photo or a closer crop; image stamps and text are okay.';
      }
    } catch (error) {
      console.error('Face scan failed:', error);
      clearBoxes();
      $('#result-message').innerHTML = '<strong class="font-bold text-slate-700">This frame could not be scanned.</strong> Try another image or video frame. If the detector is still loading, check your connection and scan again.';
      setStatus('Try again', 'idle');
    }
    hideProgress();
  }

  async function scanVideoFrame(video) {
    const version = scanVersion;
    if (videoScanBusy || currentKind !== 'video' || !video.videoWidth || video.readyState < 2) return;
    videoScanBusy = true;
    try {
      const faceDetector = await getDetector();
      if (!faceDetector || currentKind !== 'video' || layer.querySelector('video') !== video) return;
      const faces = await detectDenseFaces(faceDetector, video);
      if (version !== scanVersion || currentKind !== 'video' || layer.querySelector('video') !== video) return;
      const stableFaces = stabilizeVideoFaces(faces);
      drawBoxes(stableFaces, video.videoWidth, video.videoHeight);
      const confidence = stableFaces.length ? stableFaces.reduce((sum, face) => sum + face.score, 0) / stableFaces.length : 0;
      updateResults(stableFaces.length, 'video', confidence);
      $('#detail-source').textContent = 'Recorded video';
      $('#result-message').innerHTML = faces.length
        ? `<strong class="font-bold text-slate-700">${faces.length} human face${faces.length === 1 ? '' : 's'} in this frame.</strong> Automatically checking the video as it plays.`
        : '<strong class="font-bold text-slate-700">No clear faces in this frame.</strong> Face detection updates automatically during playback.';
    } catch (error) {
      console.warn('Video face scan failed:', error);
    } finally {
      videoScanBusy = false;
    }
  }

  function startVideoAutoScan(video) {
    if (videoScanInterval) clearInterval(videoScanInterval);
    scanVideoFrame(video);
    videoScanInterval = setInterval(() => {
      if (!video.paused && !video.ended) scanVideoFrame(video);
    }, 1200);
  }

  function stopCamera() {
    cameraSession++;
    $('#stop-camera-btn').classList.add('hidden');
    if (videoScanInterval) clearInterval(videoScanInterval);
    videoScanInterval = null;
    if (detectInterval) clearInterval(detectInterval);
    detectInterval = null;
    if (stream) stream.getTracks().forEach((track) => track.stop());
    stream = null;
  }

  function resetResults() {
    clearBoxes();
    $('#face-count').textContent = '—';
    $('#face-count').className = 'mt-1 font-display text-[42px] font-extrabold leading-none tracking-[-.06em] text-slate-300';
    $('#confidence-bar').style.width = '0%';
    $('#confidence-value').textContent = '—';
    $('#result-message').textContent = 'Add a photo or video, or switch on your camera to see detected faces here.';
    $('#detail-source').textContent = 'None';
    $('#detail-time').textContent = '—';
    $('#result-icon').className = 'flex h-10 w-10 items-center justify-center rounded-xl bg-slate-100 text-slate-300';
    setStatus('Waiting');
  }

  function clearMedia() {
    stopCamera();
    if (currentUrl) URL.revokeObjectURL(currentUrl);
    currentUrl = null;
    currentKind = null;
    videoPlaying = false;
    previousVideoBoxes = [];
    $('#video-center-play').classList.add('hidden');
    $('#video-center-play').classList.remove('flex');
    layer.innerHTML = '';
    layer.classList.add('hidden');
    layer.classList.remove('flex');
    empty.classList.remove('hidden');
    videoControls.classList.add('hidden');
    videoControls.classList.remove('flex');
    $('#clear-btn').classList.add('hidden');
    $('#switch-camera-btn').classList.add('hidden');
    $('#switch-camera-btn').classList.remove('flex');
    $('#stage-hint').textContent = 'Your files stay on this device and are never uploaded.';
    resetResults();
  }

  function applyMode(nextMode) {
    mode = nextMode;
    $('#matching-status').hidden = !matchStudents.checked;
    modes.forEach((button) => {
      const active = button.dataset.mode === mode;
      button.setAttribute('aria-selected', active ? 'true' : 'false');
      button.className = `mode-btn flex shrink-0 items-center gap-2 rounded-xl px-4 py-2.5 text-[12px] font-bold transition ${active ? 'bg-slate-900 text-white' : 'text-slate-500 hover:bg-slate-100'}`;
    });
    stopCamera();
    if (mode !== 'camera') {
      if (currentKind === 'camera') clearMedia();
      if (mode === 'photo') {
        fileInput.accept = 'image/*,.heic,.heif,.avif,.jpg,.jpeg,.png,.webp,.gif,.bmp';
        $('#empty-title').textContent = 'Drop a photo to begin';
        $('#empty-copy').textContent = 'We’ll highlight human faces and ignore objects, animals, and look-alikes.';
        $('#upload-btn').textContent = 'Choose photo ↑';
        $('#stage-hint').textContent = 'Your files stay on this device and are never uploaded.';
        $('#sample-btn').classList.remove('hidden');
      } else {
        fileInput.accept = 'video/*,.mp4,.webm,.mov,.m4v';
        $('#empty-title').textContent = 'Choose a recorded video';
        $('#empty-copy').textContent = 'Play your clip and face detection will update automatically throughout the video.';
        $('#upload-btn').textContent = 'Choose video ↑';
        $('#stage-hint').textContent = 'Video is played and scanned locally in your browser.';
        $('#sample-btn').classList.add('hidden');
      }
      if (!currentKind) empty.classList.remove('hidden');
      if (currentKind && ((mode === 'photo' && currentKind === 'video') || (mode === 'video' && currentKind === 'photo'))) clearMedia();
    } else {
      $('#empty-title').textContent = 'Start your live camera';
      $('#empty-copy').textContent = 'Your camera feed stays on this device. Allow access when your browser asks.';
      $('#upload-btn').textContent = 'Enable camera';
      $('#sample-btn').classList.add('hidden');
      $('#stage-hint').textContent = 'Camera access starts only when you choose to enable it.';
      if (currentKind && currentKind !== 'camera') clearMedia();
      empty.classList.remove('hidden');
    }
  }

  const imageExtensions = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'avif', 'heic', 'heif', 'tif', 'tiff']);
  const videoExtensions = new Set(['mp4', 'webm', 'mov', 'm4v', 'ogv', 'avi', 'mpeg', 'mpg']);

  function extensionOf(file) {
    return file.name?.split('.').pop()?.toLowerCase() || '';
  }

  async function detectFileKind(file) {
    const ext = extensionOf(file);
    if (file.type.startsWith('video/') || videoExtensions.has(ext)) return 'video';
    if (file.type.startsWith('image/') || imageExtensions.has(ext)) return 'photo';
    // Some messaging apps and device pickers provide a blank or generic MIME type.
    const bytes = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    const starts = (...values) => values.every((value, index) => bytes[index] === value);
    const brand = String.fromCharCode(...bytes.slice(8, 12));
    if (starts(0xff, 0xd8, 0xff) || starts(0x89, 0x50, 0x4e, 0x47) || starts(0x47, 0x49, 0x46, 0x38) ||
        (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) ||
        ['avif', 'avis', 'heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand)) return 'photo';
    return null;
  }

  function convertHeic(file) {
    return new Promise((resolve, reject) => {
      const finish = () => {
        if (typeof window.heic2any !== 'function') {
          reject(new Error('HEIC converter unavailable'));
          return;
        }
        window.heic2any({ blob: file, toType: 'image/jpeg', quality: 0.92 })
          .then((result) => resolve(Array.isArray(result) ? result[0] : result))
          .catch(reject);
      };
      if (typeof window.heic2any === 'function') return finish();
      const existing = document.querySelector('script[data-heic-converter]');
      if (existing) {
        existing.addEventListener('load', finish, { once: true });
        existing.addEventListener('error', () => reject(new Error('HEIC converter failed to load')), { once: true });
        return;
      }
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js';
      script.dataset.heicConverter = 'true';
      script.onload = finish;
      script.onerror = () => reject(new Error('HEIC converter failed to load'));
      document.head.appendChild(script);
    });
  }

  function fileError(message) {
    clearMedia();
    $('#result-message').textContent = message;
    setStatus('Could not open', 'idle');
  }

  async function showFile(file) {
    if (!file) return;
    const kind = await detectFileKind(file);
    const isVideo = kind === 'video';
    if (!kind || (mode === 'photo' && isVideo) || (mode === 'video' && !isVideo)) {
      $('#result-message').textContent = mode === 'video' ? 'Choose a supported video file.' : 'Choose a photo file such as JPG, PNG, WEBP, or HEIC.';
      return;
    }
    if (file.size > 50 * 1024 * 1024) {
      $('#result-message').textContent = 'This file is over 50 MB. Please choose a smaller file.';
      return;
    }
    clearMedia();
    currentUrl = URL.createObjectURL(file);
    currentKind = kind;
    empty.classList.add('hidden');
    layer.classList.remove('hidden');
    layer.classList.add('flex');
    $('#clear-btn').classList.remove('hidden');
    $('#clear-btn').classList.add('flex');
    if (isVideo) {
      const video = document.createElement('video');
      video.src = currentUrl;
      video.playsInline = true;
      video.preload = 'metadata';
      video.controls = false;
      video.className = 'h-full w-full';
      layer.appendChild(video);
      videoControls.classList.remove('hidden');
      videoControls.classList.add('flex');
      $('#video-center-play').classList.remove('hidden');
      $('#video-center-play').classList.add('flex');
      video.addEventListener('loadedmetadata', () => updateVideoTime(video));
      video.addEventListener('error', () => fileError('This video format could not be opened in this browser. Try MP4 or WEBM.'));
      video.addEventListener('timeupdate', () => updateVideoTime(video));
              video.addEventListener('play', () => {
          videoPlaying = true;
          previousVideoBoxes = [];
        $('#play-icon').innerHTML = '<path d="M4 3h3v10H4zM9 3h3v10H9z"/>';
        $('#play-btn').setAttribute('aria-label', 'Pause video');
        $('#play-label').textContent = 'Pause';
        $('#video-center-play').classList.add('hidden');
        $('#video-center-play').classList.remove('flex');
        startVideoAutoScan(video);
      });
      video.addEventListener('pause', () => {
        if (layer.querySelector('video') === video) enableHistoryResults();
        videoPlaying = false;
        $('#play-icon').innerHTML = '<path d="M4 2.8a1 1 0 0 1 1.5-.86l7.2 4.2a1 1 0 0 1 0 1.72l-7.2 4.2A1 1 0 0 1 4 11.2V2.8Z"/>';
        $('#play-btn').setAttribute('aria-label', 'Play video');
        $('#play-label').textContent = 'Play';
        $('#video-center-play').classList.remove('hidden');
        $('#video-center-play').classList.add('flex');
        if (videoScanInterval) clearInterval(videoScanInterval);
        videoScanInterval = null;
        if (currentKind === 'video') scanVideoFrame(video);
      });
      video.addEventListener('seeked', () => {
        if (video.paused) scanVideoFrame(video);
      });
      video.addEventListener('ended', () => {
        if (layer.querySelector('video') === video) enableHistoryResults();
      });
      video.addEventListener('loadeddata', () => scanVideoFrame(video), { once: true });
      $('#detail-source').textContent = 'Recorded video';
      resetResults();
    } else {
      const image = new Image();
      const ext = extensionOf(file);
      const header = new Uint8Array(await file.slice(0, 16).arrayBuffer());
      const photoBrand = String.fromCharCode(...header.slice(8, 12));
      const isHeic = ['heic', 'heif'].includes(ext) || /image\/(heic|heif)/i.test(file.type) ||
        ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(photoBrand);
      let triedHeicConversion = false;
      image.alt = 'Selected photo';
      image.className = 'h-full w-full';
      image.onload = () => scanMedia();
      image.onerror = async () => {
        if (isHeic && !triedHeicConversion) {
          triedHeicConversion = true;
          showProgress('Preparing shared HEIC photo…');
          try {
            const converted = await convertHeic(file);
            if (currentUrl) URL.revokeObjectURL(currentUrl);
            currentUrl = URL.createObjectURL(converted);
            image.src = currentUrl;
          } catch (error) {
            console.warn('HEIC photo conversion failed:', error);
            hideProgress();
            fileError('This HEIC photo could not be opened. Try saving or sharing it as JPG, or check your internet connection for the one-time converter download.');
          }
          return;
        }
        fileError('This image could not be opened. Try a JPG or PNG copy of the photo; some phone formats need conversion before scanning.');
      };
      image.src = currentUrl;
      layer.appendChild(image);
      $('#detail-source').textContent = 'Photo';
    }
  }

  function updateVideoTime(video) {
    const fmt = (time) => {
      if (!Number.isFinite(time)) return '0:00';
      const m = Math.floor(time / 60);
      return `${m}:${String(Math.floor(time % 60)).padStart(2, '0')}`;
    };
    $('#video-time').textContent = `${fmt(video.currentTime)} / ${fmt(video.duration)}`;
    $('#video-seek').value = video.duration ? (video.currentTime / video.duration) * 100 : 0;
  }

  async function startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
      $('#result-message').textContent = 'Camera access is not available here. Open this page in a secure browser context and try again.';
      return;
    }
    stopCamera();
    const session = cameraSession;
    lastLiveFaces = null;
    try {
      const acquired = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { exact: cameraFacing }
        },
        audio: false
      });
      if (session !== cameraSession) {
        acquired.getTracks().forEach(track => track.stop());
        return;
      }
      stream = acquired;
      $('#matching-status').hidden = !matchStudents.checked;
      $('#stop-camera-btn').classList.remove('hidden');
      currentKind = 'camera';
      empty.classList.add('hidden');
      layer.innerHTML = '';
      layer.classList.remove('hidden');
      layer.classList.add('flex');
      $('#clear-btn').classList.remove('hidden');
      $('#clear-btn').classList.add('flex');
      $('#switch-camera-btn').classList.remove('hidden');
      $('#switch-camera-btn').classList.add('flex');
      $('#switch-camera-label').textContent = cameraFacing === 'user' ? 'Use rear camera' : 'Use front camera';
      $('#switch-camera-btn').setAttribute('aria-label', cameraFacing === 'user' ? 'Switch to rear camera' : 'Switch to front camera');
      $('#stage-hint').textContent = `Live ${cameraFacing === 'user' ? 'front' : 'rear'} camera is active. Select the camera button to switch.`;
      const video = document.createElement('video');
      video.autoplay = true;
      video.muted = true;
      video.playsInline = true;
      video.className = 'h-full w-full';
      video.srcObject = stream;
      layer.appendChild(video);
      video.addEventListener('loadedmetadata', async () => {
        try { await video.play(); } catch (error) {
          if (session === cameraSession) $('#result-message').textContent = 'Camera preview could not start. Stop the camera and try again.';
          return;
        }
        if (session !== cameraSession) return;
        setStatus('Live', 'live');
        const faceDetector = await getDetector();
        if (session !== cameraSession) return;
        if (!faceDetector) {
          detectorUnavailable();
          return;
        }
        let scanningFrame = false;
        detectInterval = setInterval(async () => {
          if (scanningFrame || video.readyState < 2 || video.paused || !video.videoWidth) return;
          scanningFrame = true;
          try {
            const version = scanVersion;
            const match = matchStudents.checked;
            const frame = match ? freezeFrame(video) : video;
            const detected = await faceDetector.detect(frame);
            const faces = match ? await identifyFaces(frame, detected) : detected;
            if (session !== cameraSession || version !== scanVersion || currentKind !== 'camera' || layer.querySelector('video') !== video) return;
            lastLiveFaces = faces;
            drawBoxes(faces, video.videoWidth, video.videoHeight);
            const confidence = faces.length ? faces.reduce((sum, face) => sum + face.score, 0) / faces.length : 0;
            updateResults(faces.length, 'camera', confidence);
            if (match && faces.length) showLiveMatches(faces);
          } catch (error) {
            if (session !== cameraSession) return;
            console.warn('Live face scan failed:', error);
            clearBoxes();
            $('#result-message').textContent = 'The camera is on, but this frame could not be scanned. Keep the camera steady and try better lighting.';
            setStatus('Retrying', 'working');
          } finally {
            scanningFrame = false;
          }
        }, 350);
      }, {
        once: true
      });
      resetResults();
      $('#detail-source').textContent = 'Live camera';
    } catch (error) {
      if (session !== cameraSession) return;
      let message = error.name === 'NotAllowedError' ? 'Camera permission was declined. Allow camera access in your browser settings, then try again.' : error.name === 'NotFoundError' ? 'No camera was found on this device.' : 'Could not start the camera. Check permissions and try again.';
      $('#result-message').textContent = error.name === 'OverconstrainedError' && cameraFacing === 'environment' ? 'A rear camera is not available on this device. Switch back to the front camera.' : message;
      if (error.name === 'OverconstrainedError') cameraFacing = cameraFacing === 'environment' ? 'user' : 'environment';
      setStatus('Camera off');
    }
  }

  function showLiveMatches(faces) {
    const list = document.createElement('ol');
    faces.forEach((face, i) => {
      const item = document.createElement('li');
      item.textContent = 'Face ' + (i + 1) + ' — ' + (face.label || 'Detected');
      list.append(item);
    });
    $('#result-message').replaceChildren(list);
  }

  $('#stop-camera-btn').addEventListener('click', () => {
    if (currentKind !== 'camera') return;
    enableHistoryResults();
    stopCamera();
    currentKind = null;
    layer.replaceChildren();
    layer.classList.add('hidden');
    layer.classList.remove('flex');
    empty.classList.remove('hidden');
    $('#switch-camera-btn').classList.add('hidden');
    $('#switch-camera-btn').classList.remove('flex');
    $('#clear-btn').classList.add('hidden');
    $('#matching-status').hidden = true;
    $('#empty-title').textContent = 'Camera stopped';
    $('#empty-copy').textContent = 'Your last scan is shown in Detection results.';
    $('#upload-btn').textContent = 'Start camera again';
    $('#stage-hint').textContent = 'Camera off';
    setStatus('Stopped', 'idle');
    if (lastLiveFaces?.length) showLiveMatches(lastLiveFaces);
    else $('#result-message').textContent = lastLiveFaces ? 'No faces in the last scan.' : 'Camera stopped before a scan completed.';
  });

  $('#switch-camera-btn').addEventListener('click', async () => {
    if (currentKind !== 'camera') return;
    const nextFacing = cameraFacing === 'user' ? 'environment' : 'user';
    cameraFacing = nextFacing;
    await startCamera();
  });

  $('#upload-btn').addEventListener('click', () => mode === 'camera' ? startCamera() : fileInput.click());
  fileInput.addEventListener('change', (event) => {
    showFile(event.target.files[0]);
    event.target.value = '';
  });
  $('#clear-btn').addEventListener('click', clearMedia);
  modes.forEach((button) => button.addEventListener('click', () => applyMode(button.dataset.mode)));
  const toggleVideoPlayback = () => {
    const video = layer.querySelector('video');
    if (!video || currentKind !== 'video') return;
    if (videoPlaying) video.pause();
    else video.play().catch((error) => {
      console.warn('Video playback could not start:', error);
      $('#result-message').textContent = 'This video could not be played in your browser. Try an MP4 or WEBM file.';
    });
  };
  $('#play-btn').addEventListener('click', toggleVideoPlayback);
  $('#video-center-play').addEventListener('click', toggleVideoPlayback);
  $('#video-seek').addEventListener('input', (event) => {
    const video = layer.querySelector('video');
    if (video?.duration) video.currentTime = video.duration * Number(event.target.value) / 100;
  });
  stage.addEventListener('dragover', (event) => {
    event.preventDefault();
    stage.classList.add('drop-active');
  });
  stage.addEventListener('dragleave', (event) => {
    if (!stage.contains(event.relatedTarget)) stage.classList.remove('drop-active');
  });
  stage.addEventListener('drop', (event) => {
    event.preventDefault();
    stage.classList.remove('drop-active');
    const file = event.dataTransfer.files[0];
    if (file) showFile(file);
  });

  $('#sample-btn').addEventListener('click', () => {
    // Public sample portrait photo; it is only a convenience preview and remains loaded in this browser.
    const sampleUrl = 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=1100&q=85';
    clearMedia();
    currentKind = 'photo';
    currentUrl = sampleUrl;
    empty.classList.add('hidden');
    layer.classList.remove('hidden');
    layer.classList.add('flex');
    $('#clear-btn').classList.remove('hidden');
    $('#clear-btn').classList.add('flex');
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.alt = 'Sample portrait photo';
    image.className = 'h-full w-full';
    image.onload = () => scanMedia();
    image.onerror = () => {
      $('#result-message').textContent = 'The sample image could not be loaded. Choose a photo from your device instead.';
      clearMedia();
    };
    image.src = sampleUrl;
    layer.appendChild(image);
  });

  document.addEventListener('paste', (event) => {
    if (mode === 'camera') return;
    const item = [...(event.clipboardData?.items || [])].find((candidate) => candidate.type.startsWith('image/'));
    if (item) showFile(item.getAsFile());
  });
})();
