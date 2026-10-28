const COUNTER_START = 1;

const CHURCH_OPTIONS = ["KCPC Member", "Other Church", "Non-Church"];
const MAX_GUESTS = 20;

const SHEET_NAME = "Responses";
const LOCK_TIME = 10000;

function doPost(e) {
  let data;
  try {
    data = JSON.parse(e.postData.contents);
  } catch (err) {
    return respond({ status: "error", message: "Bad request" });
  }

  // ---- Validate & sanitize BEFORE taking the lock ----
  const clean = (s, max) => String(s || "").trim().substring(0, max);
  const name = clean(data.name, 80);
  const church = CHURCH_OPTIONS.indexOf(data.church) !== -1 ? data.church : "";
  const guests = Number(data.guests);
  const phone = clean(data.phoneNumber, 20);
  const submissionId = clean(data.submissionId, 64);

  if (!name || !church || !submissionId ||
      !Number.isInteger(guests) || guests < 1 || guests > MAX_GUESTS ||
      phone.replace(/\D/g, "").length !== 10) {
    return respond({ status: "error", message: "Invalid input" });
  }

  const cache = CacheService.getScriptCache();
  const cacheKey = "sub_" + submissionId;

  // Fast path for retries (no lock needed)
  const already = cache.get(cacheKey);
  if (already) return respond(JSON.parse(already));

  // Wait for the lock; if we can't get it, tell the client to retry
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_TIME)) {
    return respond({ status: "busy" });
  }

  try {
    // Re-check inside the lock (two identical retries racing each other)
    const again = cache.get(cacheKey);
    if (again) return respond(JSON.parse(again));

    const props = PropertiesService.getScriptProperties();
    const number = Number(props.getProperty("NEXT_NUMBER") || COUNTER_START);

    // Bump the counter FIRST: a crash leaves a gap, never a duplicate number
    props.setProperty("NEXT_NUMBER", String(number + 1));

    // Columns: Number | Name | Church | Number of Guest | Phone Number
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
    if (!sheet) throw new Error("Sheet not found: " + SHEET_NAME);
    const range = sheet.getRange(sheet.getLastRow() + 1, 1, 1, 5);
    range.setValues([[number, name, church, guests, phone]]);

    const result = { status: "success", number: number };
    cache.put(cacheKey, JSON.stringify(result), 21600); // remember for 6 hours
    return respond(result);

  } catch (err) {
    return respond({ status: "error", message: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function respond(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// Run this manually ONLY to reset numbering (e.g., after load testing).
function resetCounter() {
  PropertiesService.getScriptProperties().deleteProperty("NEXT_NUMBER");
}
