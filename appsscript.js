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

  // ---- Validate & sanitize before taking the lock ----
  const clean = (s, max) => String(s || "").trim().substring(0, max);
  const name = clean(data.name, 80);
  const church = CHURCH_OPTIONS.indexOf(data.church) !== -1 ? data.church : "";
  const guests = Number(data.guests);
  const digits = String(data.phoneNumber || "").replace(/\D/g, "");
  const phone = digits.length === 10
    ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`
    : "";
  const submissionId = clean(data.submissionId, 64);
  const isEdit = data.isEdit === true;

  if (!name || !church || !phone || !submissionId ||
      !Number.isInteger(guests) || guests < 1 || guests > MAX_GUESTS) {
    return respond({ status: "error", message: "Invalid input" });
  }

  const cache = CacheService.getScriptCache();
  const cacheKey = "sub_" + submissionId;

  // Fast path for create retries (no lock needed). Edits skip this.
  if (!isEdit) {
    const already = cache.get(cacheKey);
    if (already) return respond(JSON.parse(already));
  }

  // Wait for the lock; if we can't get it, tell the client to retry
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_TIME)) {
    return respond({ status: "busy" });
  }

  try {
    if (!isEdit) {
      const again = cache.get(cacheKey);
      if (again) return respond(JSON.parse(again));
    }

    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
    if (!sheet) throw new Error("Sheet not found: " + SHEET_NAME);

    // Find an existing row for this key (row 1 is the header)
    const lastRow = sheet.getLastRow();
    let rowIndex = -1;
    if (lastRow >= 2) {
      const keys = sheet.getRange(2, 6, lastRow - 1, 1).getValues();
      for (let i = 0; i < keys.length; i++) {
        if (String(keys[i][0]) === submissionId) { rowIndex = i + 2; break; }
      }
    }

	// ---- EDIT ----
    // Update the existing row in place; the number never changes
    if (isEdit) {
      if (rowIndex === -1) {
        return respond({ status: "error", message: "Registration not found" });
      }
      const number = Number(sheet.getRange(rowIndex, 1).getValue());
      const range = sheet.getRange(rowIndex, 2, 1, 4); // Name..Phone
      range.setNumberFormats([["@", "@", "General", "@"]]);
      range.setValues([[name, church, guests, phone]]);
      return respond({ status: "success", number: number });
    }

    // ---- CREATE ----
    // Durable duplicate check (covers retries after the cache expires)
    if (rowIndex !== -1) {
      return respond({ status: "success", number: Number(sheet.getRange(rowIndex, 1).getValue()) });
    }

    const props = PropertiesService.getScriptProperties();
    const number = Number(props.getProperty("NEXT_NUMBER") || COUNTER_START);

    // Bump the counter first: a crash leaves a gap, never a duplicate number
    props.setProperty("NEXT_NUMBER", String(number + 1));

    const range = sheet.getRange(lastRow + 1, 1, 1, 6);
	// Prevent formulas to be inputted in text cells
    range.setNumberFormats([["General", "@", "@", "General", "@", "@"]]);
    range.setValues([[number, name, church, guests, phone, submissionId]]);

    const result = { status: "success", number: number };
	// Cache for 6 hours
    cache.put(cacheKey, JSON.stringify(result), 21600);
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

// Run this manually to reset numbering (e.g., after load testing).
function resetCounter() {
  PropertiesService.getScriptProperties().deleteProperty("NEXT_NUMBER");
}
