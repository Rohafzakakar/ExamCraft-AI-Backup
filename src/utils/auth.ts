export interface TeacherUser {
  id: string;
  email: string;
  full_name: string;
  institution: string;
  role: string;
}

const TOKEN_KEY = 'examcraft_token';
const USER_KEY = 'examcraft_user';
const GUEST_ID_KEY = 'examcraft_guest_session_id';

// Generate or retrieve persistent guest session ID for this browser tab/device
export function getGuestSessionId(): string {
  let guestId = localStorage.getItem(GUEST_ID_KEY);
  if (!guestId || !guestId.startsWith('guest_')) {
    const randomHex = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    guestId = `guest_${randomHex}`;
    localStorage.setItem(GUEST_ID_KEY, guestId);
  }
  return guestId;
}

// Reset guest session to a fresh new isolated identity (e.g. on explicit logout)
export function resetGuestSessionId(): string {
  const randomHex = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  const guestId = `guest_${randomHex}`;
  localStorage.setItem(GUEST_ID_KEY, guestId);
  return guestId;
}

// Token operations
export function getAuthToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setAuthToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function removeAuthToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

// User operations
export function getSavedUser(): TeacherUser | null {
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function setSavedUser(user: TeacherUser): void {
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function removeSavedUser(): void {
  localStorage.removeItem(USER_KEY);
}

// Generate unified headers for all backend requests
export function getAuthHeaders(): Record<string, string> {
  const token = getAuthToken();
  const guestId = getGuestSessionId();

  const headers: Record<string, string> = {
    'X-Guest-Session-Id': guestId,
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  } else {
    headers['Authorization'] = `Bearer ${guestId}`;
  }

  return headers;
}

// Unified Authenticated Fetch Wrapper
export async function authFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const customHeaders = (options.headers as Record<string, string>) || {};
  const mergedHeaders = {
    ...getAuthHeaders(),
    ...customHeaders,
  };

  const response = await fetch(url, {
    ...options,
    headers: mergedHeaders,
  });

  // If unauthorized while holding a teacher token, clean up and reset
  if (response.status === 401 && getAuthToken()) {
    removeAuthToken();
    removeSavedUser();
    window.dispatchEvent(new CustomEvent('examcraft_auth_expired'));
  }

  return response;
}
