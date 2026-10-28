const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbwbk0kwfjRtpOfGuR9OMT17ERC-WephCY9NAldCqgespckfK9zomL4sSUJ-7JNlodDE5g/exec";
const STORAGE_KEY = "kcpc_ticket_v2";
const MAX_ATTEMPTS = 4;
const REQUEST_TIMEOUT_MS = 20000;
const MAX_GUESTS = 20;

const form = document.getElementById("checkin-form");
const formContainer = document.getElementById("form-container");
const resultContainer = document.getElementById("result-container");
const resultName = document.getElementById("result-name");
const resultNumber = document.getElementById("result-number");
const resultGuests = document.getElementById("result-guests");
const submitBtn = document.getElementById("submit-btn");
const cancelEditBtn = document.getElementById("cancel-edit-btn");
const loadingText = document.getElementById("loading-text");
const errorText = document.getElementById("error-text");
const editBtn = document.getElementById("edit-btn");

const nameInput = document.getElementById("name");
const guestsInput = document.getElementById("guests");
const phoneInput = document.getElementById("phoneNumber");
const nameError = document.getElementById("name-error");
const churchError = document.getElementById("church-error");
const guestsError = document.getElementById("guests-error");
const phoneError = document.getElementById("phone-error");

// One ID per household registration. Retries reuse it (no duplicates), and it
// doubles as the private key that lets this device edit its own record later.
let submissionId = newSubmissionId();
let isSubmitting = false;
let isEditing = false;
let currentTicket = null;

function newSubmissionId() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return "id-" + Date.now() + "-" + Math.random().toString(36).slice(2, 12);
}

// ---------- Safe localStorage helpers (may be unavailable) ----------
function saveTicket(ticket) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(ticket)); } catch (e) {}
}
function loadTicket() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}
function clearTicket() {
  try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
}

// ---------- UI helpers ----------
function setSubmitting(on) {
  isSubmitting = on;
  submitBtn.disabled = on;
  cancelEditBtn.disabled = on;
  if (on) {
    submitBtn.textContent = isEditing ? "Saving..." : "Submitting...";
    loadingText.textContent = isEditing
      ? "Please wait, saving your changes..."
      : "Please wait, submitting your response...";
  } else {
    submitBtn.textContent = isEditing ? "Save" : "Submit";
  }
  loadingText.classList.toggle("hidden", !on);
}
function showError(msg) {
  errorText.textContent = msg;
  errorText.classList.remove("hidden");
}
function clearError() {
  errorText.textContent = "";
  errorText.classList.add("hidden");
}
function clearFieldErrors() {
  [nameError, churchError, guestsError, phoneError].forEach(el => el.classList.add("hidden"));
  [nameInput, guestsInput, phoneInput].forEach(el => el.classList.remove("border-red-500"));
}
function flag(errorEl, inputEl) {
  errorEl.classList.remove("hidden");
  if (inputEl) inputEl.classList.add("border-red-500");
}

// Auto-format phone number as user types
phoneInput.addEventListener("input", (e) => {
  let cleaned = e.target.value.replace(/\D/g, "").substring(0, 10);
  let formatted = "";

  if (cleaned.length > 6) {
    formatted = `(${cleaned.substring(0, 3)}) ${cleaned.substring(3, 6)}-${cleaned.substring(6)}`;
  } else if (cleaned.length > 3) {
    formatted = `(${cleaned.substring(0, 3)}) ${cleaned.substring(3)}`;
  } else if (cleaned.length > 0) {
    formatted = `(${cleaned}`;
  }

  e.target.value = formatted;
  phoneError.classList.add("hidden");
  phoneInput.classList.remove("border-red-500");
});

// Clear individual errors as the user fixes them
nameInput.addEventListener("input", () => {
  nameError.classList.add("hidden");
  nameInput.classList.remove("border-red-500");
});
guestsInput.addEventListener("input", () => {
  guestsError.classList.add("hidden");
  guestsInput.classList.remove("border-red-500");
});
document.querySelectorAll('input[name="church"]').forEach(r =>
  r.addEventListener("change", () => churchError.classList.add("hidden"))
);

// ---------- Network: timeout + retry with backoff ----------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function submitWithRetry(payload) {
  let lastError;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(SCRIPT_URL, {
        method: "POST",
        mode: "cors",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(payload),
        signal: ctrl.signal
      });
      const data = await res.json();

      if (data.status === "success") return data;
      if (data.status === "error") {
        // Validation/server error: retrying won't help
        const err = new Error(data.message || "Submission failed");
        err.fatal = true;
        throw err;
      }
      // status === "busy": fall through and retry
      lastError = new Error("Server busy");
    } catch (err) {
      if (err.fatal) throw err;
      lastError = err;
    } finally {
      clearTimeout(timer);
    }

    if (attempt < MAX_ATTEMPTS - 1) {
      // Exponential backoff + jitter so 1000 phones don't retry in lockstep
      await sleep(1000 * Math.pow(2, attempt) + Math.random() * 1000);
    }
  }
  throw lastError || new Error("Submission failed");
}

// ---------- Edit mode ----------
function startEdit() {
  if (!currentTicket) return;
  isEditing = true;

  // Prefill the form with what was previously submitted
  nameInput.value = currentTicket.name || "";
  guestsInput.value = currentTicket.guests || "";
  phoneInput.value = currentTicket.phone || "";
  document.querySelectorAll('input[name="church"]').forEach(r => {
    r.checked = (r.value === currentTicket.church);
  });

  clearFieldErrors();
  clearError();
  cancelEditBtn.classList.remove("hidden");
  setSubmitting(false); // refreshes the button label to "Save Changes"

  resultContainer.classList.add("hidden");
  formContainer.classList.remove("hidden");
  nameInput.focus();
}

function cancelEdit() {
  if (isSubmitting) return;
  isEditing = false;
  cancelEditBtn.classList.add("hidden");
  clearFieldErrors();
  clearError();
  setSubmitting(false); // refreshes the button label to "Submit"
  displayResult(currentTicket); // back to the result screen; edits are discarded
}

editBtn.addEventListener("click", startEdit);
cancelEditBtn.addEventListener("click", cancelEdit);

// ---------- Form Submission ----------
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (isSubmitting) return; // guard against double taps
  clearError();
  clearFieldErrors();

  const name = nameInput.value.trim();
  const selectedChurch = document.querySelector('input[name="church"]:checked');
  const guestsRaw = guestsInput.value.trim();
  const guests = Number(guestsRaw);
  const rawPhone = phoneInput.value.replace(/\D/g, "");

  // Validate everything, focusing the first invalid field
  let firstInvalid = null;
  if (!name) { flag(nameError, nameInput); firstInvalid = firstInvalid || nameInput; }
  if (!selectedChurch) { flag(churchError, null); firstInvalid = firstInvalid || document.querySelector('input[name="church"]'); }
  if (!guestsRaw || !Number.isInteger(guests) || guests < 1 || guests > MAX_GUESTS) {
    flag(guestsError, guestsInput); firstInvalid = firstInvalid || guestsInput;
  }
  if (rawPhone.length !== 10) { flag(phoneError, phoneInput); firstInvalid = firstInvalid || phoneInput; }
  if (firstInvalid) { firstInvalid.focus(); return; }

  setSubmitting(true);

  const payload = {
    submissionId: submissionId,
    isEdit: isEditing,
    name: name,
    church: selectedChurch.value,
    guests: guests,
    phoneNumber: phoneInput.value.trim()
  };

  try {
    const data = await submitWithRetry(payload);
    const ticket = {
      submissionId: submissionId,
      number: data.number,
      name: name,
      church: selectedChurch.value,
      guests: guests,
      phone: phoneInput.value.trim()
    };
    currentTicket = ticket;
    saveTicket(ticket);
    isEditing = false;
    cancelEditBtn.classList.add("hidden");
    displayResult(ticket);
  } catch (err) {
    console.error(err);
    showError(isEditing
      ? "We couldn't save your changes. Check your connection and tap Save again, or see the front desk."
      : "We couldn't submit your registration. Check your connection and tap Submit again, or see the front desk.");
  } finally {
    setSubmitting(false);
  }
});

// Uses textContent (no HTML injection)
function displayResult(ticket) {
  resultName.textContent = ticket.name;
  resultNumber.textContent = "#" + ticket.number;
  resultGuests.textContent = ticket.guests + (Number(ticket.guests) === 1 ? " guest" : " guests");

  loadingText.classList.add("hidden");
  formContainer.classList.add("hidden");
  resultContainer.classList.remove("hidden");
}

// Reset to start fresh on same device
if (new URLSearchParams(location.search).has("reset")) {
  clearTicket();
  history.replaceState(null, "", location.pathname);
}

// Restore the ticket if the attendee refreshed or reopened the page
(function restoreTicket() {
  const t = loadTicket();
  if (t && t.submissionId && t.number !== undefined && t.name) {
    submissionId = t.submissionId; // same key, so edits still match their row
    currentTicket = t;
    displayResult(t);
  }
})();
