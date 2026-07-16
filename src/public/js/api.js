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

  getAudioUrl(videoId) {
    return `${API_BASE}/api/videos/${videoId}/audio`;
  },

  getVideoUrl(videoId) {
    return `${API_BASE}/api/videos/${videoId}/file`;
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
};
