const COUNTER_START = 1;

const CHURCH_OPTIONS = ["KCPC Member", "Other Church", "Non-Church"];
const MAX_GUESTS = 20;

const SHEET_NAME = "Responses";
const LOCK_TIME = 10000;

const HEADERS = ["Number", "Name", "Church", "Number of Guest", "Phone Number", "Edit Key"];
const NUM_COLS = HEADERS.length;

function doPost(e) {
  let data;
  try {
    data = JSON.parse(e.postData.contents);
  } catch (err) {
    return respond({ status: "error", message: "Bad request" });
  }
  if (!data || typeof data !== "object") {
    return respond({ status: "error", message: "Bad request" });
  }

  // ---- Validate & sanitize before taking the lock ----
  const clean = (s, max) =>
    String(s == null ? "" : s).replace(/[\u0000-\u001f\u007f]/g, " ").trim().substring(0, max);

  const name = clean(data.name, 80);
  const church = CHURCH_OPTIONS.indexOf(data.church) !== -1 ? data.church : "";
  const guests = Number(data.guests);
  const digits = String(data.phoneNumber == null ? "" : data.phoneNumber).replace(/\D/g, "");
  const phone = digits.length === 10
    ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`
    : "";
  const submissionId = clean(data.submissionId, 64);
  const isEdit = data.isEdit === true;

  if (!name || !church || !phone ||
      !/^[A-Za-z0-9_-]{8,64}$/.test(submissionId) ||
      !Number.isInteger(guests) || guests < 1 || guests > MAX_GUESTS) {
    return respond({ status: "error", message: "Invalid input" });
  }

  // Wait for the lock; if we can't get it, tell the client to retry
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_TIME)) {
    return respond({ status: "busy" });
  }

  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
    if (!sheet) throw new Error("Sheet not found: " + SHEET_NAME);

    // Write headers if the sheet is completely empty
    if (sheet.getLastRow() === 0) {
      sheet.getRange(1, 1, 1, NUM_COLS).setValues([HEADERS]);
    }
    const lastRow = sheet.getLastRow();

    // One read: find this submission's row and the highest number in use
    let rowIndex = -1;
    let existingNumber = 0;
    let maxNumber = 0;
    if (lastRow >= 2) {
      const rows = sheet.getRange(2, 1, lastRow - 1, NUM_COLS).getValues();
      for (let i = 0; i < rows.length; i++) {
        const n = Number(rows[i][0]);
        if (Number.isFinite(n) && n > maxNumber) maxNumber = n;
        if (rowIndex === -1 && String(rows[i][NUM_COLS - 1]) === submissionId) {
          rowIndex = i + 2;
          existingNumber = n;
        }
      }
    }

    // ---- EXISTING ROW: an edit, or a retry of a create whose response was lost ----
    // Update in place; the number never changes and no second row is created
    if (rowIndex !== -1) {
      const range = sheet.getRange(rowIndex, 2, 1, 4); // Name..Phone
      range.setNumberFormats([["@", "@", "General", "@"]]); // text cells can't become formulas
      range.setValues([[name, church, guests, phone]]);
      SpreadsheetApp.flush();
      return respond({ status: "success", number: existingNumber });
    }

    // An edit with no matching row must never create a new registration
    if (isEdit) {
      return respond({ status: "error", message: "Registration not found" });
    }

    // ---- CREATE ----
    const props = PropertiesService.getScriptProperties();
    const stored = Number(props.getProperty("NEXT_NUMBER")) || COUNTER_START;
    // Never go below what the sheet already uses, even if the counter was reset by mistake
    const number = Math.max(stored, maxNumber + 1, COUNTER_START);

    const range = sheet.getRange(lastRow + 1, 1, 1, NUM_COLS);
    range.setNumberFormats([["General", "@", "@", "General", "@", "@"]]);
    range.setValues([[number, name, church, guests, phone, submissionId]]);
    SpreadsheetApp.flush();

    // Counter is updated AFTER the row is safely written; if this line fails,
    // the next request recomputes the number from the sheet
    props.setProperty("NEXT_NUMBER", String(number + 1));

    return respond({ status: "success", number: number });

  } catch (err) {
    return respond({ status: "error", message: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function doGet() {
  return respond({ status: "ok" });
}

function respond(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// Run once manually: writes the headers, hides the Edit Key column, freezes the header row
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
  sheet.getRange(1, 1, 1, NUM_COLS).setValues([HEADERS]);
  sheet.setFrozenRows(1);
  sheet.hideColumns(NUM_COLS);
}

// Run manually ONLY to restart numbering after deleting test rows.
// With rows still in the sheet, the next number stays above the highest existing one.
function resetCounter() {
  PropertiesService.getScriptProperties().deleteProperty("NEXT_NUMBER");
}
