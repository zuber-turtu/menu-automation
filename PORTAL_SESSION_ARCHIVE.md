# Portal Session & Authentication Connector — Archive & Re-implementation Guide

This document preserves the complete implementation, architecture, and source code of the **Portal Session & Authentication Connector** that was removed from the active Menu Automation project. 

Whenever you want to restore or re-enable the Portal Session feature, follow the instructions in the [Restoration Guide](#restoration-guide) section below.

---

## 1. Feature Overview & Architecture

### Purpose
The Portal Session feature acts as an authenticated server-side reverse proxy. It allows the Menu Automation app to:
1. Authenticate directly against an external restaurant web portal API (using username/email + password).
2. Automatically capture and store session cookies (e.g. `sessionid`, `connect.sid`, CSRF tokens) and JWT/Bearer access tokens.
3. Overcome browser CORS (Cross-Origin Resource Sharing) restrictions by funneling API calls through the FastAPI backend (`/api/auth/proxy-request`).
4. Execute authenticated requests (e.g. upload menus, fetch portal categories, inspect user profiles) without manual token extraction.

### Core Components
* **Backend Session Manager (`app/services/session_manager.py`)**: Stateful session container keeping track of `base_url`, `access_token`, `cookies`, and HTTP request execution using `httpx.AsyncClient`.
* **API Router (`app/routers/auth_proxy.py`)**: Endpoints for `/api/auth/login`, `/api/auth/set-token`, `/api/auth/status`, `/api/auth/proxy-request`, and `/api/auth/logout`.
* **Frontend Portal Tab (`app/templates/index.html`)**: Interactive UI with login form, session status viewer, cookie monitor, and a test request runner.
* **Frontend Controller (`app/static/js/app.js`)**: JavaScript handlers for login submission, session polling, token preview, and proxy testing.

---

## 2. Complete Source Code

### A. Backend: `app/services/session_manager.py`
```python
import httpx
from typing import Optional, Dict, Any

class TargetSessionManager:
    """
    Manages authenticated sessions to target portals.
    Stores cookies, tokens, and active headers, and provides a proxy client
    to make authenticated requests without CORS or cookie-sharing restrictions.
    """
    def __init__(self):
        self.base_url: Optional[str] = None
        self.access_token: Optional[str] = None
        self.token_type: str = "Bearer"
        self.cookies: Dict[str, str] = {}
        self.custom_headers: Dict[str, str] = {}
        self.is_logged_in: bool = False
        self.user_identity: Optional[str] = None
        self.last_login_response: Optional[Dict[str, Any]] = None

    def reset(self):
        self.base_url = None
        self.access_token = None
        self.token_type = "Bearer"
        self.cookies = {}
        self.custom_headers = {}
        self.is_logged_in = False
        self.user_identity = None
        self.last_login_response = None

    async def authenticate(
        self,
        login_url: str,
        payload: Dict[str, Any],
        is_json: bool = True,
        custom_headers: Optional[Dict[str, str]] = None
    ) -> Dict[str, Any]:
        """
        Sends login credentials to target website and captures session cookies/tokens.
        """
        self.reset()
        headers = custom_headers or {}

        async with httpx.AsyncClient(follow_redirects=True, timeout=15.0) as client:
            try:
                if is_json:
                    response = await client.post(login_url, json=payload, headers=headers)
                else:
                    response = await client.post(login_url, data=payload, headers=headers)

                # Capture cookies
                captured_cookies = {k: v for k, v in response.cookies.items()}
                self.cookies = captured_cookies

                # Try parsing JSON response for tokens
                json_data = {}
                try:
                    json_data = response.json()
                except Exception:
                    json_data = {"raw_text": response.text[:500]}

                self.last_login_response = json_data

                # Look for common token patterns in response JSON
                token_candidates = ["access_token", "token", "authToken", "jwt", "id_token", "apiKey"]
                found_token = None
                if isinstance(json_data, dict):
                    for key in token_candidates:
                        if key in json_data and isinstance(json_data[key], str):
                            found_token = json_data[key]
                            break
                        # Check nested 'data' or 'user' objects
                        for subkey in ["data", "user", "auth", "result"]:
                            if subkey in json_data and isinstance(json_data[subkey], dict):
                                if key in json_data[subkey] and isinstance(json_data[subkey][key], str):
                                    found_token = json_data[subkey][key]
                                    break

                if found_token:
                    self.access_token = found_token

                # Check success status
                if response.status_code in (200, 201, 204):
                    self.is_logged_in = True
                    self.base_url = str(response.url).split("/api")[0] if "/api" in str(response.url) else str(response.url)
                    return {
                        "status": "success",
                        "status_code": response.status_code,
                        "authenticated": True,
                        "has_token": bool(self.access_token),
                        "token_preview": f"{self.access_token[:10]}...{self.access_token[-6:]}" if self.access_token else None,
                        "cookies_captured": list(self.cookies.keys()),
                        "message": "Successfully authenticated with target website."
                    }
                else:
                    self.is_logged_in = False
                    return {
                        "status": "error",
                        "status_code": response.status_code,
                        "authenticated": False,
                        "message": f"Login endpoint returned HTTP {response.status_code}",
                        "details": json_data
                    }

            except httpx.RequestError as exc:
                self.is_logged_in = False
                return {
                    "status": "error",
                    "authenticated": False,
                    "message": f"Connection error: {str(exc)}"
                }

    async def proxy_request(
        self,
        method: str,
        target_url: str,
        params: Optional[Dict[str, Any]] = None,
        json_data: Optional[Dict[str, Any]] = None,
        headers: Optional[Dict[str, str]] = None
    ) -> Dict[str, Any]:
        """
        Executes an authenticated request against the target portal using the stored session.
        """
        if not self.is_logged_in:
            return {"status": "error", "message": "No active authenticated session."}

        req_headers = headers or {}
        if self.access_token and "Authorization" not in req_headers:
            req_headers["Authorization"] = f"{self.token_type} {self.access_token}"

        async with httpx.AsyncClient(cookies=self.cookies, follow_redirects=True, timeout=20.0) as client:
            try:
                resp = await client.request(
                    method=method.upper(),
                    url=target_url,
                    params=params,
                    json=json_data,
                    headers=req_headers
                )
                try:
                    data = resp.json()
                except Exception:
                    data = {"text": resp.text[:1000]}

                return {
                    "status": "success",
                    "status_code": resp.status_code,
                    "data": data,
                    "url": str(resp.url)
                }
            except httpx.RequestError as exc:
                return {"status": "error", "message": str(exc)}

    def get_status(self) -> Dict[str, Any]:
        return {
            "is_logged_in": self.is_logged_in,
            "base_url": self.base_url,
            "has_token": bool(self.access_token),
            "cookies": list(self.cookies.keys()),
            "token_preview": f"{self.access_token[:10]}...{self.access_token[-6:]}" if self.access_token else None
        }

# Global instance for the FastAPI server
target_session = TargetSessionManager()
```

---

### B. Backend: `app/routers/auth_proxy.py`
```python
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from typing import Optional, Dict, Any
from app.services.session_manager import target_session

router = APIRouter(prefix="/api/auth", tags=["Target Website Authentication"])

class LoginRequest(BaseModel):
    login_url: str = Field(..., description="Target website login endpoint URL (e.g. https://api.mysite.com/v1/auth/login)")
    username_or_email: str = Field(..., description="Username or email for your account")
    password: str = Field(..., description="Password for your account")
    username_field_name: str = Field(default="email", description="Field name expected by the API (e.g. email, username, user)")
    password_field_name: str = Field(default="password", description="Password field name expected by the API")
    is_json: bool = Field(default=True, description="Send as application/json (True) or form-urlencoded (False)")
    extra_payload: Optional[Dict[str, Any]] = Field(default=None, description="Any extra fields needed by the login endpoint")
    custom_headers: Optional[Dict[str, str]] = Field(default=None, description="Optional custom headers")

class DirectTokenRequest(BaseModel):
    base_url: str = Field(..., description="Base URL of your website")
    access_token: str = Field(..., description="Direct access token / API key")
    token_type: str = Field(default="Bearer", description="Authorization header scheme")

class ProxyRequest(BaseModel):
    url: str = Field(..., description="Target endpoint URL to fetch/navigate to")
    method: str = Field(default="GET", description="HTTP Method")
    params: Optional[Dict[str, Any]] = None
    json_data: Optional[Dict[str, Any]] = None

@router.post("/login")
async def login_to_target(request: LoginRequest):
    """
    Submits credentials to your target portal and captures authentication cookies and JWT/tokens.
    """
    payload = {
        request.username_field_name: request.username_or_email,
        request.password_field_name: request.password
    }
    if request.extra_payload:
        payload.update(request.extra_payload)

    result = await target_session.authenticate(
        login_url=request.login_url,
        payload=payload,
        is_json=request.is_json,
        custom_headers=request.custom_headers
    )
    return result

@router.post("/set-token")
async def set_direct_token(request: DirectTokenRequest):
    """
    Manually provide an existing access token or API key for your website.
    """
    target_session.reset()
    target_session.base_url = request.base_url
    target_session.access_token = request.access_token
    target_session.token_type = request.token_type
    target_session.is_logged_in = True
    return {
        "status": "success",
        "authenticated": True,
        "message": "Token manually configured and active."
    }

@router.get("/status")
async def get_auth_status():
    """
    Check if the tool currently holds an authenticated session or token.
    """
    return target_session.get_status()

@router.post("/logout")
async def logout():
    """
    Clear stored session credentials and cookies.
    """
    target_session.reset()
    return {"status": "success", "message": "Session cleared."}

@router.post("/proxy-request")
async def execute_authenticated_proxy(request: ProxyRequest):
    """
    Make an authenticated request to any page or API on your target website.
    """
    if not target_session.is_logged_in:
        raise HTTPException(status_code=401, detail="Not authenticated. Please log in first.")
    
    result = await target_session.proxy_request(
        method=request.method,
        target_url=request.url,
        params=request.params,
        json_data=request.json_data
    )
    return result
```

---

### C. Frontend: Portal Tab Markup (`index.html`)

#### 1. Header Tab Button
```html
<button id="tabBtnAuth" class="tab-btn" onclick="switchTab('auth')">
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
  Portal Session
  <span id="sessionStatusDot" class="status-dot disconnected"></span>
</button>
```

#### 2. Section Panel
```html
<!-- TAB 2: PORTAL AUTHENTICATION & SESSION CONNECTOR -->
<section id="panelAuth" class="tab-panel">
  <div class="auth-grid">
    <!-- Login Form Card -->
    <div class="card glass">
      <div class="card-header">
        <div class="icon-wrap">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>
        </div>
        <div>
          <h3>Connect to Your Website Portal</h3>
          <p>Authenticates via server proxy to safely capture your active session & tokens.</p>
        </div>
      </div>

      <div class="card-body">
        <form id="portalLoginForm" onsubmit="handlePortalLogin(event)">
          <div class="form-group">
            <label for="loginUrl">Login Endpoint URL</label>
            <input type="url" id="loginUrl" class="form-control" placeholder="https://yourportal.com/api/v1/auth/login" required>
            <span class="field-hint">The API URL where your portal accepts credentials.</span>
          </div>

          <div class="form-row">
            <div class="form-group">
              <label for="usernameOrEmail">Username or Email</label>
              <input type="text" id="usernameOrEmail" class="form-control" placeholder="admin@example.com" required>
            </div>
            <div class="form-group">
              <label for="password">Password</label>
              <input type="password" id="password" class="form-control" placeholder="••••••••••••" required>
            </div>
          </div>

          <div class="form-group">
            <details class="advanced-settings">
              <summary>Custom Field Names (Optional)</summary>
              <div class="form-row mt-2">
                <div class="form-group">
                  <label>Username Field Name</label>
                  <input type="text" id="userFieldName" class="form-control" value="email">
                </div>
                <div class="form-group">
                  <label>Password Field Name</label>
                  <input type="text" id="passFieldName" class="form-control" value="password">
                </div>
              </div>
            </details>
          </div>

          <div class="form-actions">
            <button type="submit" id="loginBtn" class="btn btn-primary">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>
              Authenticate & Capture Session
            </button>
            <button type="button" class="btn btn-danger" onclick="clearSession()">
              Clear Session
            </button>
          </div>
        </form>
      </div>
    </div>

    <!-- Session State Details Card -->
    <div class="card glass">
      <div class="card-header">
        <div class="icon-wrap">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
        </div>
        <div>
          <h3>Active Session Status</h3>
          <p>Status of stored authentication tokens and session cookies.</p>
        </div>
      </div>

      <div class="card-body">
        <div class="session-card" id="sessionDisplay">
          <div class="session-status-badge disconnected" id="sessionBadge">Disconnected</div>
          
          <div class="session-metric">
            <label>Base URL:</label>
            <span id="sessionBaseUrl" class="text-mono">None</span>
          </div>
          <div class="session-metric">
            <label>Access Token:</label>
            <span id="sessionTokenPreview" class="text-mono">None</span>
          </div>
          <div class="session-metric">
            <label>Stored Cookies:</label>
            <span id="sessionCookiesList" class="text-mono">0 cookies</span>
          </div>
        </div>

        <!-- Test Navigation / Proxy Request Tool -->
        <div class="proxy-test-box">
          <h4>Test Authenticated Request</h4>
          <p>Verify you can navigate or query protected pages with the captured session.</p>
          <div class="input-group">
            <input type="text" id="testEndpointUrl" class="form-control" placeholder="https://yourportal.com/api/profile">
            <button class="btn btn-secondary" onclick="testProxyRequest()">Send Request</button>
          </div>
          <pre class="response-preview" id="proxyResponsePreview">// Response will appear here</pre>
        </div>
      </div>
    </div>
  </div>
</section>
```

---

### D. Frontend: JavaScript Logic (`app.js`)
```javascript
// Portal Session Authentication Functions

async function handlePortalLogin(e) {
  e.preventDefault();
  const btn = document.getElementById('loginBtn');
  btn.disabled = true;
  btn.innerHTML = `<div class="loading-spinner-sm"></div> Connecting...`;

  const payload = {
    login_url: document.getElementById('loginUrl').value,
    username_or_email: document.getElementById('usernameOrEmail').value,
    password: document.getElementById('password').value,
    username_field_name: document.getElementById('userFieldName').value || 'email',
    password_field_name: document.getElementById('passFieldName').value || 'password',
    is_json: true
  };

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const result = await res.json();

    if (result.authenticated) {
      alert("Session established! Access tokens and cookies captured.");
      await checkAuthStatus();
    } else {
      alert(`Authentication failed: ${result.message || 'Check credentials or URL'}`);
    }
  } catch (err) {
    alert(`Connection error: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg> Authenticate & Capture Session`;
  }
}

async function checkAuthStatus() {
  try {
    const res = await fetch('/api/auth/status');
    const data = await res.json();
    state.authStatus = data;

    const badge = document.getElementById('sessionBadge');
    const dot = document.getElementById('sessionStatusDot');
    const baseUrlSpan = document.getElementById('sessionBaseUrl');
    const tokenSpan = document.getElementById('sessionTokenPreview');
    const cookiesSpan = document.getElementById('sessionCookiesList');

    if (data.is_logged_in) {
      badge.className = 'session-status-badge connected';
      badge.innerText = 'Connected & Active';
      dot.className = 'status-dot connected';
      baseUrlSpan.innerText = data.base_url || 'Active';
      tokenSpan.innerText = data.token_preview || 'Cookie Session (Active)';
      cookiesSpan.innerText = `${data.cookies.length} cookies captured`;
    } else {
      badge.className = 'session-status-badge disconnected';
      badge.innerText = 'Disconnected';
      dot.className = 'status-dot disconnected';
      baseUrlSpan.innerText = 'None';
      tokenSpan.innerText = 'None';
      cookiesSpan.innerText = '0 cookies';
    }
  } catch (err) {
    console.warn("Could not check auth status", err);
  }
}

async function clearSession() {
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
    await checkAuthStatus();
    document.getElementById('proxyResponsePreview').innerText = '// Session cleared.';
  } catch (err) {
    alert("Error clearing session");
  }
}

async function testProxyRequest() {
  const url = document.getElementById('testEndpointUrl').value;
  if (!url) {
    alert("Please enter a target endpoint URL to test.");
    return;
  }

  const preview = document.getElementById('proxyResponsePreview');
  preview.innerText = 'Sending authenticated request...';

  try {
    const res = await fetch('/api/auth/proxy-request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: url, method: 'GET' })
    });
    const data = await res.json();
    preview.innerText = JSON.stringify(data, null, 2);
  } catch (err) {
    preview.innerText = `Error: ${err.message}`;
  }
}
```

---

## 3. Restoration Guide

If you ever wish to re-enable the Portal Session feature in the future:

1. **Re-create Backend Files**:
   * Create `app/services/session_manager.py` with the code from Section 2.A.
   * In `app/services/__init__.py`, add:
     ```python
     from .session_manager import target_session, TargetSessionManager
     __all__ = ["target_session", "TargetSessionManager"]
     ```
   * Create `app/routers/auth_proxy.py` with the code from Section 2.B.
   * In `app/routers/__init__.py`, export `auth_router`:
     ```python
     from .auth_proxy import router as auth_router
     from .menu_routes import router as menu_router
     __all__ = ["auth_router", "menu_router"]
     ```
   * In `app/main.py`, add `auth_router`:
     ```python
     from app.routers import auth_router, menu_router
     app.include_router(auth_router)
     ```

2. **Re-add Frontend Components**:
   * In `app/templates/index.html`, add the header button and panel markup from Section 2.C.
   * In `app/static/js/app.js`, add the functions from Section 2.D and re-add `checkAuthStatus()` inside `DOMContentLoaded`.
