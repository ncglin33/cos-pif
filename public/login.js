import { signInWithEmailAndPassword, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { auth } from "./firebase-config.js";

const $ = (sel) => document.querySelector(sel);

const form = $("#login-form");
const statusDiv = $("#status");
const submitBtn = $("#submit-btn");

function getRedirectParam() {
  const params = new URLSearchParams(window.location.search);
  return params.get("redirect") || "";
}

function resolveSafeRedirect(raw, claims = {}) {
  if (!raw) return "";
  try {
    // Allow same-origin absolute or relative URLs only
    const u = new URL(raw, window.location.origin);
    if (u.origin !== window.location.origin) return "";

    const path = (u.pathname || "").replace(/^\//, "");
    const lower = path.toLowerCase();

    // Block obvious admin-only pages for client role
    const isClient = !!claims.client;
    if (isClient) {
      if (lower.startsWith("admin") || lower.includes("topic-poll-admin") || lower.includes("bootstrap")) return "";
    }

    // Only allow html pages (and keep query/hash)
    if (!lower.endsWith(".html")) return "";
    return u.pathname + u.search + u.hash;
  } catch (e) {
    return "";
  }
}

async function routeAfterLogin(user) {
  const token = await user.getIdTokenResult(true);
  const claims = token?.claims || {};
  const redirectRaw = getRedirectParam();
  const safeRedirect = resolveSafeRedirect(redirectRaw, claims);

  // ✅ If redirect is provided (and safe), honor it FIRST
  if (safeRedirect) {
    window.location.href = safeRedirect;
    return;
  }

  // ✅ Default destinations by role:
  // - admin/systemAdmin -> admin.html
  // - client -> index-c-company.html
  // - others (including user / pending / no-claim) -> index.html
  if (claims.admin || claims.systemAdmin) {
    window.location.href = "admin.html";
    return;
  }
  if (claims.client) {
    window.location.href = "index-c-company.html";
    return;
  }
  window.location.href = "index.html";
}


// Redirect if already logged in
onAuthStateChanged(auth, async (user) => {
  if (user) {
    await routeAfterLogin(user);
  }
});

form?.addEventListener("submit", async (e) => {
  e.preventDefault();

  const email = $("#email")?.value || "";
  const password = $("#password")?.value || "";

  submitBtn.disabled = true;
  submitBtn.textContent = "登入中...";
  statusDiv.textContent = "";
  statusDiv.className = "form-message";

  try {
    const userCredential = await signInWithEmailAndPassword(auth, email, password);
    const user = userCredential.user;

    statusDiv.textContent = "登入成功！正在跳轉...";
    statusDiv.classList.add("success");

    await routeAfterLogin(user);
  } catch (error) {
    console.error(error);
    statusDiv.textContent = `登入失敗：${getFirebaseErrorMessage(error)}`;
    statusDiv.classList.add("error");
    submitBtn.disabled = false;
    submitBtn.textContent = "登入";
  }
});

function getFirebaseErrorMessage(error) {
  switch (error.code) {
    case "auth/user-not-found":
    case "auth/wrong-password":
    case "auth/invalid-credential":
      return "電子郵件或密碼不正確。";
    case "auth/invalid-email":
      return "電子郵件格式不正確。";
    case "auth/user-disabled":
      return "此帳號已被停用。";
    default:
      return "發生未知錯誤，請稍後再試。";
  }
}
