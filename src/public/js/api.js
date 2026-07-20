const API_BASE = '';

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  if (response.status === 204) return null;
  return response.json();
}

export const api = {
  health() {
    return request('/api/health');
  },

  listVideos() {
    return request('/api/videos');
  },

  addVideo(url) {
    return request('/api/videos', {
      method: 'POST',
      body: JSON.stringify({ url }),
    });
  },

  getVideo(videoId) {
    return request(`/api/videos/${videoId}`);
  },

  deleteVideo(videoId) {
    return request(`/api/videos/${videoId}`, { method: 'DELETE' });
  },

  deleteAllVideos() {
    return request('/api/videos', { method: 'DELETE' });
  },

  getAudioUrl(videoId) {
    return `${API_BASE}/api/videos/${videoId}/audio`;
  },

  getVideoUrl(videoId) {
    return `${API_BASE}/api/videos/${videoId}/file`;
  },

  // NOT routed through request() above -- it hardcodes Content-Type:
  // application/json, which would break the multipart boundary the browser
  // needs to set itself for FormData.
  async uploadMedia(file) {
    const formData = new FormData();
    formData.append('file', file);
    const response = await fetch(`${API_BASE}/api/videos/upload`, {
      method: 'POST',
      body: formData,
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      const err = new Error(error.error || `HTTP ${response.status}`);
      err.status = response.status;
      throw err;
    }
    return response.json();
  },

  // Also bypasses request(): the body here is a raw opus byte buffer, not
  // JSON, so this sends application/octet-stream instead.
  async restoreLocalAudio(videoId, bytes, title) {
    const query = title ? `?title=${encodeURIComponent(title)}` : '';
    const response = await fetch(`${API_BASE}/api/videos/${videoId}/restore-audio${query}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: bytes,
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      const err = new Error(error.error || `HTTP ${response.status}`);
      err.status = response.status;
      throw err;
    }
    return response.json();
  },

  listSessions() {
    return request('/api/sessions');
  },

  loadSession(name) {
    return request(`/api/sessions/${encodeURIComponent(name)}`);
  },

  saveSession(session) {
    return request('/api/sessions', {
      method: 'POST',
      body: JSON.stringify(session),
    });
  },

  deleteSession(name) {
    return request(`/api/sessions/${encodeURIComponent(name)}`, { method: 'DELETE' });
  },

  exportSession(name) {
    return `${API_BASE}/api/sessions/${encodeURIComponent(name)}/export`;
  },

  getLogs() {
    return request('/api/logs');
  },
};
