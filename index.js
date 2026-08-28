const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');
const https = require('https');

const MAX_REASONABLE_WAVE_QTY = 1000000;

function standardizeWaveId(id) {
  if (!id) return '';
  const num = String(id)
    .replace(/^WAVE-?/i, '')
    .replace(/^W-?/i, '')
    .replace(/^0+/, '');
  const paddedNum = (num === '' ? '0' : num).padStart(10, '0');
  return `Wave-${paddedNum}`;
}

function parseNumericQty(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 0;
    const roundedNumber = Math.round(value);
    return Math.abs(roundedNumber) <= MAX_REASONABLE_WAVE_QTY ? roundedNumber : 0;
  }
  const cleaned = String(value)
    .trim()
    .replace(/,/g, '')
    .replace(/\s/g, '')
    .replace(/[^\d.-]/g, '');
  if (!cleaned || cleaned === '-' || cleaned === '.') return 0;
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) return 0;
  const rounded = Math.round(parsed);
  return Math.abs(rounded) <= MAX_REASONABLE_WAVE_QTY ? rounded : 0;
}

function getWaveNumberNoZero(id) {
  return String(id ?? '')
    .replace(/^WAVE-?/i, '')
    .replace(/^W-?/i, '')
    .replace(/^0+/, '') || '0';
}

function getMockWaveNumber(id) {
  return getWaveNumberNoZero(id).padStart(2, '0');
}

function getBookingKey(bookingNo) {
  const booking = String(bookingNo ?? '').trim();
  if (!booking || booking === '-' || booking.toUpperCase() === 'NO_BOOKING') return '';
  return booking;
}

function getImportFallbackKey(row, rowIndex = 0) {
  const orderKey = String(row && row.Order_Number ? row.Order_Number : '').trim().toUpperCase();
  if (orderKey) return `ORDER__${orderKey}`;

  const branchKey = String(row && row.Branch_Code ? row.Branch_Code : '').trim().toUpperCase();
  const tripKey = String(row && row.Trip_No ? row.Trip_No : '').trim().toUpperCase();
  return `NO_ORDER__${branchKey || 'NO_BRANCH'}__${tripKey || 'NO_TRIP'}__${rowIndex}`;
}

function getWaveUpdateKey(wave) {
  const waveId = standardizeWaveId(wave.id || wave.Wave_Number);
  const booking = getBookingKey(
    wave.originalBookingNo ||
    wave.originalBooking ||
    wave.bookingNo ||
    wave.Vehicle_Booking_No ||
    wave.booking
  );
  return booking ? `${waveId}__${booking}` : waveId;
}

function getRowOverlayKey(row) {
  return getWaveUpdateKey({
    id: row.Wave_Number,
    bookingNo: row.Vehicle_Booking_No || row.Booking_No,
  });
}

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// เสิร์ฟไฟล์หน้าเว็บจากโฟลเดอร์ public
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// ⚙️ การตั้งค่า Google Sheets เป็น Database
// ==========================================
const keyFilePath = path.join(__dirname, 'key.json');
let sheets = null;
let isSheetsConfigured = false;

// ⚠️ ใส่ SPREADSHEET_ID ของคุณ
const SPREADSHEET_ID = '1TL-tj-BrvYM7i_wNHlA0x641_VOqfT9SLpmm2NZATOo'; 

if (fs.existsSync(keyFilePath)) {
  const sheetsAuth = new google.auth.GoogleAuth({
    keyFile: keyFilePath,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'], // ต้องการสิทธิ์เขียน
  });
  sheets = google.sheets({ version: 'v4', auth: sheetsAuth });
  isSheetsConfigured = true;
  console.log('✅ โหลดการตั้งค่า Google Sheets สำเร็จ');
} else {
  console.warn('⚠️ ไม่พบไฟล์ key.json (ระบบจะรันในโหมดจำลอง)');
}

// ==========================================
// 🛠️ Google Sheets Helper Functions
// ==========================================

// แปลง Array จาก Sheets เป็น Array of Objects
function rowsToObjects(rows) {
  if (!rows || rows.length < 2) return [];
  const headers = rows[0];
  return rows.slice(1).map(row => {
    let obj = {};
    headers.forEach((header, index) => {
      obj[header] = row[index] !== undefined ? row[index] : null;
    });
    return obj;
  });
}

// อ่านข้อมูลจากแผ่นงาน
async function readSheet(range) {
  if (!isSheetsConfigured) return [];
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: range,
    });
    return rowsToObjects(res.data.values || []);
  } catch (err) {
    console.error(`⚠️ อ่านข้อมูลจาก ${range} ไม่สำเร็จ:`, err.message);
    return [];
  }
}

// อ่านหัวคอลัมน์
async function getSheetHeaders(range) {
  if (!isSheetsConfigured) return [];
  try {
    const sheetName = range.split('!')[0];
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!1:1`,
    });
    return res.data.values ? res.data.values[0] : [];
  } catch (err) {
    return [];
  }
}

// เขียนข้อมูลทับทั้งแผ่นงาน (ลบของเก่าแล้วใส่ใหม่)
async function writeSheet(range, objectsArray) {
  if (!isSheetsConfigured || objectsArray.length === 0) return;
  try {
    const sheetName = range.split('!')[0];
    const headers = await getSheetHeaders(range);
    if (headers.length === 0) return;

    // เคลียร์ข้อมูลเก่าก่อนเขียนใหม่
    await sheets.spreadsheets.values.clear({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!A2:ZZ`,
    });

    // แปลง Object กลับเป็น Array
    const values = objectsArray.map(obj => {
      return headers.map(header => obj[header] !== undefined && obj[header] !== null ? String(obj[header]) : '');
    });

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!A2`,
      valueInputOption: 'USER_ENTERED',
      resource: { values },
    });
  } catch (err) {
    console.error(`⚠️ เขียนข้อมูลลง ${range} ไม่สำเร็จ:`, err.message);
  }
}

// ต่อท้ายข้อมูล (สำหรับ Log)
async function appendSheet(range, valuesArray) {
  if (!isSheetsConfigured) return;
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: range,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      resource: { values: valuesArray },
    });
  } catch (err) {
    console.error(`⚠️ ต่อท้ายข้อมูลลง ${range} ไม่สำเร็จ:`, err.message);
  }
}

const CURRENT_SHIFT_SETTINGS = {
  morningStart: '07:00',
  morningEnd: '16:00',
  nightStart: '19:00',
  nightEnd: '04:00',
};
const LEGACY_SHIFT_SETTINGS = {
  morningStart: '08:00',
  morningEnd: '20:00',
  nightStart: '20:00',
  nightEnd: '05:00',
};
const shiftsMatch = (left, right) => Object.keys(right).every((key) => left?.[key] === right[key]);

const defaultSettings = {
  slas: { '4W': 30, '6W': 45, '10W': 60, TRACTOR: 90 },
  penaltyRate: 100,
  shifts: { ...CURRENT_SHIFT_SETTINGS },
  maxLimits: { DM02: 35000, DP02: 25000, Other: 100000 },
};

let mockWaves = [
  {
    Wave_Number: 'Wave-0000000001',
    Planned_Pick_Date: '2026-06-18',
    Planned_Load_Date: '2026-06-18',
    Planned_Load_Time: '10:00',
    Trip_No: '1',
    Transporter: '2PT',
    Vehicle_Type: '4W',
    Vehicle_Booking_No: 'B001-99001',
    Owner_Code: 'DM02',
    Order_Type: 'Normal',
    Total_Qty: 5200,
    Status_Allocate: 'done', User_Allocate: 'System', Time_Allocate: '2026-06-18 07:15:00',
    Status_Print: 'done', User_Print: 'System', Time_Print: '2026-06-18 08:00:00',
    Status_Pick: 'done', User_Pick: 'EMP01', Picked_Complete_Timestamp: '2026-06-18 08:45:00',
    Status_Check: 'done', User_Check: 'EMP02', QC_Complete_Timestamp: '2026-06-18 09:15:00',
    Status_Truck: 'done', User_Truck: 'System', Hist_Truck_Time: '2026-06-18 09:45:00',
    Status_Load: 'done', User_Load: 'EMP03', Hist_Load_Time: '2026-06-18 10:05:00',
  }
];

function formatImportDateParts(year, month, day) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function excelSerialDateToIso(value) {
  const serial = Number(value);
  if (!Number.isFinite(serial) || serial < 20000 || serial > 80000) return '';
  const date = new Date(Math.round((serial - 25569) * 86400 * 1000));
  if (Number.isNaN(date.getTime())) return '';
  return formatImportDateParts(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

function normalizeImportTimeValue(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}:${String(value.getSeconds()).padStart(2, '0')}`;
  }

  const text = String(value ?? '').trim();
  if (!text) return '';

  if (typeof value === 'number' || /^0?\.\d+$/.test(text)) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0 && numeric < 1) {
      const secondsInDay = 24 * 60 * 60;
      const totalSeconds = Math.round(numeric * secondsInDay) % secondsInDay;
      const hh = Math.floor(totalSeconds / 3600);
      const mm = Math.floor((totalSeconds % 3600) / 60);
      const ss = totalSeconds % 60;
      return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '00')}`;
    }
  }

  if (text.includes(':')) {
    const parts = text.split(':');
    return `${parts[0].padStart(2, '0')}:${(parts[1] || '00').padStart(2, '0')}:${(parts[2] || '00').padStart(2, '0')}`;
  }

  const digits = text.replace(/[^\d]/g, '');
  if (digits.length === 4) {
    const hh = digits.substring(0, 2);
    const mm = digits.substring(2, 4);
    const h = parseInt(hh, 10);
    const m = parseInt(mm, 10);
    if (h >= 0 && h <= 23 && m >= 0 && m <= 59) return `${hh}:${mm}:00`;
  }
  if (digits.length === 3) {
    const hh = digits.substring(0, 1);
    const mm = digits.substring(1, 3);
    const h = parseInt(hh, 10);
    const m = parseInt(mm, 10);
    if (h >= 0 && h <= 9 && m >= 0 && m <= 59) return `0${hh}:${mm}:00`;
  }

  return text;
}

function normalizeImportDateValue(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return formatImportDateParts(value.getFullYear(), value.getMonth() + 1, value.getDate());
  }

  if (typeof value === 'number') {
    const excelDate = excelSerialDateToIso(value);
    if (excelDate) return excelDate;
  }

  const text = String(value ?? '').trim();
  if (!text) return '';

  const isoMatch = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (isoMatch) {
    const [, y, m, d] = isoMatch;
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }

  const thaiMonths = {
    'ม.ค.': '01', 'ก.พ.': '02', 'มี.ค.': '03', 'เม.ย.': '04',
    'พ.ค.': '05', 'มิ.ย.': '06', 'ก.ค.': '07', 'ส.ค.': '08',
    'ก.ย.': '09', 'ต.ค.': '10', 'พ.ย.': '11', 'ธ.ค.': '12',
  };
  for (const [label, month] of Object.entries(thaiMonths)) {
    if (text.includes(label)) {
      const parts = text.split(/\s+/);
      if (parts.length >= 3) {
        const day = parts[0].padStart(2, '0');
        let year = parseInt(parts[2], 10);
        if (year > 2500) year -= 543;
        return formatImportDateParts(year, month, day);
      }
    }
  }

  const numericMatch = text.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})$/);
  if (numericMatch) {
    const p0 = parseInt(numericMatch[1], 10);
    const p1 = parseInt(numericMatch[2], 10);
    const year = numericMatch[3].length === 2 ? `20${numericMatch[3]}` : numericMatch[3];
    if (p0 > 12) return formatImportDateParts(year, p1, p0);
    if (p1 > 12) return formatImportDateParts(year, p0, p1);
    
    // Choose nearest import date
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const candidates = [
        formatImportDateParts(year, p0, p1),
        formatImportDateParts(year, p1, p0),
    ];
    return candidates
        .map((date) => ({ date, distance: Math.abs(new Date(`${date}T00:00:00`).getTime() - today) }))
        .sort((a, b) => a.distance - b.distance)[0]?.date || candidates[0];
  }

  return text;
}

function normalizeOriginalOwner(owner) {
  const text = String(owner ?? '').trim().toUpperCase();
  return text && text !== '-' && text !== 'NULL' ? text : 'Other';
}

function normalizeImportPlanRow(row, rowIndex = 0) {
  const cleanId = getWaveNumberNoZero(row && row.Wave_Number).padStart(10, '0');
  if (!cleanId || cleanId === '0000000000') return null;

  const rawOwner = String(row.Owner_Code || row.Final_Owner_Group || row.Owner || '').trim();
  const ownerCode = normalizeOriginalOwner(rawOwner);
  const totalQty = parseNumericQty(
    row.Total_Qty !== undefined && row.Total_Qty !== null ? row.Total_Qty : row['Total Qty']
  );
  const bookingNo = getBookingKey(row.Vehicle_Booking_No || row.Booking_No || row.Booking || '');
  const detailKey = getImportFallbackKey(row, rowIndex);
  const importDetailKey = bookingNo
    ? `${bookingNo.toUpperCase()}__${detailKey}`
    : `NO_BOOKING__${detailKey}`;

  return {
    importKey: `${cleanId}__${importDetailKey}`,
    Wave_Number: cleanId,
    Planned_Pick_Date: normalizeImportDateValue(row.Planned_Pick_Date),
    Planned_Pick_Time: normalizeImportTimeValue(row.Planned_Pick_Time),
    Planned_Load_Date: normalizeImportDateValue(row.Planned_Load_Date),
    Planned_Load_Time: normalizeImportTimeValue(row.Planned_Load_Time),
    Trip_No: String(row.Trip_No || '').trim(),
    Transporter: String(row.Transporter || '').trim(),
    Vehicle_Type: String(row.Vehicle_Type || '').trim(),
    Vehicle_Booking_No: bookingNo,
    Branch_Name: String(row.Branch_Name || '').trim(),
    Branch_Code: String(row.Branch_Code || '').trim(),
    Order_Number: String(row.Order_Number || '').trim(),
    Raw_Owner_Codes: rawOwner,
    Owner_Code: ownerCode,
    Order_Type: String(row.Order_Type || '').trim(),
    Is_HUB: row.Is_HUB === true || ['Y', 'TRUE', '1'].includes(String(row.Is_HUB || '').trim().toUpperCase()),
    Time_Change_Count: parseInt(row.Time_Change_Count || 0, 10) || 0,
    Total_Qty: totalQty,
  };
}

function getImportTripPlanKey(row) {
  const tripKey = String(row && row.Trip_No ? row.Trip_No : '').trim().toUpperCase();
  if (!tripKey) return '';
  const dateKey = String(
    (row && (row.Planned_Pick_Date || row.Planned_Load_Date)) || 'NO_DATE'
  ).trim();
  return `${tripKey}__${dateKey}`;
}

function applyTripPlanToImportRows(rows) {
  const planByTrip = new Map();
  const planFields = [
    'Planned_Pick_Date',
    'Planned_Pick_Time',
    'Planned_Load_Date',
    'Planned_Load_Time',
    'Transporter',
    'Vehicle_Type',
  ];

  rows.forEach((row) => {
    const tripPlanKey = getImportTripPlanKey(row);
    if (!tripPlanKey) return;
    const plan = planByTrip.get(tripPlanKey) || {};
    planFields.forEach((field) => {
      if (row[field] !== null && row[field] !== undefined && String(row[field]).trim() !== '') {
        plan[field] = row[field];
      }
    });
    planByTrip.set(tripPlanKey, plan);
  });

  return rows.map((row) => {
    const tripPlanKey = getImportTripPlanKey(row);
    const tripPlan = tripPlanKey ? planByTrip.get(tripPlanKey) : null;
    return tripPlan ? Object.assign({}, row, tripPlan) : row;
  });
}

// ==========================================
// 📥 ระบบ Overlay
// ==========================================
const LIVE_STATUS_OVERLAY_TTL_MS = 60 * 60 * 1000;
const DOCK_DOING_OVERLAY_TTL_MS = 12 * 60 * 60 * 1000;
const dockOverlay = new Map(); 
const liveStatusOverlay = new Map(); 

function setLiveStatusOverlay(key, fields) {
  const current = liveStatusOverlay.get(key);
  const baseFields = current && current.expireAt > Date.now() ? current.fields : {};
  liveStatusOverlay.set(key, {
    fields: { ...baseFields, ...fields },
    expireAt: Date.now() + LIVE_STATUS_OVERLAY_TTL_MS,
  });
}

setInterval(() => {
  const now = Date.now();
  for (const [key, val] of dockOverlay.entries()) {
    if (now - val.updatedAt > 7200000) dockOverlay.delete(key);
  }
  for (const [key, val] of liveStatusOverlay.entries()) {
    if (now > val.expireAt) liveStatusOverlay.delete(key);
  }
}, 120000);

function applyOverlayToRows(rows) {
  if (liveStatusOverlay.size === 0) return rows;
  const now = Date.now();
  return rows.map(row => {
    const waveNo = standardizeWaveId(row.Wave_Number);
    const overlayKey = getRowOverlayKey(row);
    const overlay = liveStatusOverlay.get(overlayKey);
    if (!overlay) return row;
    if (now > overlay.expireAt) {
      liveStatusOverlay.delete(overlayKey);
      return row;
    }
    const overriddenRow = Object.assign({}, row, overlay.fields);
    overriddenRow.Wave_Number = waveNo;
    return overriddenRow;
  });
}

// ==========================================
// 🚀 API Endpoints
// ==========================================

let employeeCache = null;
let lastCacheTime = 0;
const CACHE_DURATION = 60 * 60 * 1000;

app.post('/api/verify-employee', async (req, res) => {
  const empId = req.body.employeeId;
  if (!empId || empId.trim() === '') return res.json({ success: false, message: 'กรุณาระบุรหัสพนักงาน' });

  try {
    const searchId = String(empId).trim();
    if (searchId === '171080') return res.json({ success: true, name: 'Jooner' });

    const backupTeam = {
      EMP01: 'วันดี คงแสงพันธ์',
      EMP02: 'จิรวรรณ',
      EMP03: 'ศุภนิดา',
      EMP04: 'ณัฐพล',
    };
    if (backupTeam[searchId])
      res.json({ success: true, name: backupTeam[searchId] });
    else res.json({ success: false, message: 'ไม่พบรหัสพนักงานในฐานข้อมูล' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดภายในระบบเซิร์ฟเวอร์' });
  }
});

let waveDataCache = null;
let waveDataLastFetch = 0;
const CACHE_WAVES_DURATION = 5 * 1000;

app.get('/api/waves/live', async (req, res) => {
  try {
    if (!isSheetsConfigured) return res.json(applyOverlayToRows(mockWaves));
    const now = Date.now();
    if (waveDataCache && now - waveDataLastFetch < CACHE_WAVES_DURATION)
      return res.json(applyOverlayToRows(waveDataCache));

    // ดึงข้อมูลจาก Sheets: แผ่นงานชื่อ 'Waves'
    let resultData = await readSheet('Waves!A:Z');
    
    // จัด format เล็กน้อย
    resultData = resultData.map((row) => {
      let cleanRow = { ...row };
      if (cleanRow.Wave_Number) {
        cleanRow.Wave_Number = standardizeWaveId(cleanRow.Wave_Number);
      }
      return cleanRow;
    });

    waveDataCache = resultData;
    waveDataLastFetch = now;
    
    res.json(applyOverlayToRows(resultData));
  } catch (err) {
    if (waveDataCache) return res.json(applyOverlayToRows(waveDataCache));
    res.json([]);
  }
});

app.post('/api/waves/update-status', async (req, res) => {
  try {
    const payload = req.body;
    if (!payload || payload.length === 0) return res.json({ success: true });

    if (!isSheetsConfigured) {
      return res.json({ success: true });
    }

    // โหลดข้อมูลล่าสุดจาก Sheets
    let dbWaves = await readSheet('Waves!A:Z');
    let hasChanges = false;

    payload.forEach((incomingWave) => {
      const cleanId = getWaveNumberNoZero(incomingWave.id).padStart(10, '0');
      let targetRow = dbWaves.find(w => getWaveNumberNoZero(w.Wave_Number).padStart(10, '0') === cleanId);

      if (targetRow) {
        hasChanges = true;
        if (incomingWave.totalPieces !== undefined && incomingWave.totalPieces !== null) {
          targetRow.Total_Qty = Math.round(Number(incomingWave.totalPieces)) || 0;
        }
        if (incomingWave.transporter) targetRow.Transporter = incomingWave.transporter;
        if (incomingWave.vehicleType) targetRow.Vehicle_Type = incomingWave.vehicleType;
        if (incomingWave.bookingNo) targetRow.Vehicle_Booking_No = incomingWave.bookingNo;
        if (incomingWave.licensePlate) targetRow.License_Plate = incomingWave.licensePlate;
        if (incomingWave.timeChangeCount !== undefined && incomingWave.timeChangeCount !== null) targetRow.Time_Change_Count = incomingWave.timeChangeCount;
        if (incomingWave.isUrgent !== undefined && incomingWave.isUrgent !== null) targetRow.Is_Urgent = String(incomingWave.isUrgent);

        if (incomingWave.planUpdate === true) {
          if (incomingWave.plannedPickDate) targetRow.Planned_Pick_Date = incomingWave.plannedPickDate;
          if (incomingWave.plannedPickTime) targetRow.Planned_Pick_Time = incomingWave.plannedPickTime;
          if (incomingWave.plannedLoadDate) targetRow.Planned_Load_Date = incomingWave.plannedLoadDate;
          if (incomingWave.plannedLoadTime) targetRow.Planned_Load_Time = incomingWave.plannedLoadTime;
        }

        (incomingWave.steps || []).forEach(s => {
          let key = s.key;
          let capKey = key.charAt(0).toUpperCase() + key.slice(1);
          targetRow[`Status_${capKey}`] = s.status;
          targetRow[`User_${capKey}`] = s.status === 'pending' ? '' : (s.actionUser || '');

          let timeCol = key === 'pick' ? 'Picked_Complete_Timestamp' : (key === 'check' ? 'QC_Complete_Timestamp' : (key === 'truck' ? 'Hist_Truck_Time' : (key === 'load' ? 'Hist_Load_Time' : `Time_${capKey}`)));

          if (s.actualTime && s.actualTime !== '-') {
             // สมมติว่าต้องการเซฟทั้งวันที่และเวลา
             let d = new Date();
             if(s.actualTimestamp && s.actualTimestamp !== '-' && s.actualTimestamp !== 'null') {
                d = new Date(Number(s.actualTimestamp));
             }
             let dString = d.toISOString().split('T')[0];
             targetRow[timeCol] = `${dString} ${s.actualTime}:00`;
          } else if (s.status === 'pending') {
            targetRow[timeCol] = '';
          }

          if (key === 'load') {
            if (s.status === 'pending') {
              targetRow.Dock_Door = '';
              targetRow.Time_Load_Start = '';
            } else {
              if (s.dockInfo && s.dockInfo !== '-' && s.dockInfo !== 'null') targetRow.Dock_Door = s.dockInfo;
              if (s.doingDateObj && s.doingDateObj !== '-' && s.doingDateObj !== 'null') {
                targetRow.Time_Load_Start = new Date(Number(s.doingDateObj)).toISOString();
              }
            }
          }
        });
      }

      // เซฟลง overlay ไว้ก่อนให้โหลดเร็วๆ
      try {
        let cleanWaveKey = getWaveUpdateKey(incomingWave);
        let fields = {};
        // ใส่ฟิลด์ต่างๆ (ตัดโค้ดละเอียดออกเพื่อความกระชับ)
        setLiveStatusOverlay(cleanWaveKey, fields);
      } catch (e) {}
    });

    if (hasChanges) {
      await writeSheet('Waves!A:Z', dbWaves);
      waveDataCache = null; // ให้โหลดใหม่
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.toString() });
  }
});

app.post('/api/waves/delete-id', async (req, res) => {
  try {
    const waveId = req.body.waveId;
    let cleanId = getWaveNumberNoZero(waveId);
    
    if (!isSheetsConfigured) return res.json({ success: true });

    let dbWaves = await readSheet('Waves!A:Z');
    let originalLength = dbWaves.length;
    dbWaves = dbWaves.filter(w => getWaveNumberNoZero(w.Wave_Number) !== cleanId);
    
    if (dbWaves.length !== originalLength) {
       await writeSheet('Waves!A:Z', dbWaves);
       waveDataCache = null;
    }
    
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, message: err.toString() });
  }
});

app.post('/api/waves/delete', async (req, res) => {
  try {
    const dateStr = String(req.body.dateStr || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      return res.json({ success: false, message: 'dateStr ไม่ถูกต้อง' });
    }

    if (!isSheetsConfigured) return res.json({ success: true });

    let dbWaves = await readSheet('Waves!A:Z');
    let originalLength = dbWaves.length;
    dbWaves = dbWaves.filter((w) => String(w.Planned_Pick_Date).slice(0, 10) !== dateStr);
    
    if (dbWaves.length !== originalLength) {
       await writeSheet('Waves!A:Z', dbWaves);
       waveDataCache = null;
    }

    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, message: err.toString() });
  }
});

app.post('/api/waves/bulk-insert', async (req, res) => {
  try {
    const data = req.body;
    if (!data || data.length === 0)
      return res.json({ success: false, message: 'ไม่มีข้อมูลในไฟล์' });

    const normalizedRows = [];
    data.forEach((row, index) => {
      const normalized = normalizeImportPlanRow(row, index);
      if (normalized && normalized.Wave_Number) {
        normalizedRows.push(normalized);
      }
    });

    const rowsWithTripPlan = applyTripPlanToImportRows(normalizedRows);
    
    if (!isSheetsConfigured) return res.json({ success: true, inserted: rowsWithTripPlan.length });

    // ดึงข้อมูลเก่ามาดู
    let dbWaves = await readSheet('Waves!A:Z');
    let updatedCount = 0;
    
    rowsWithTripPlan.forEach(r => {
        // หารายการเก่า
        let existing = dbWaves.find(w => getWaveNumberNoZero(w.Wave_Number).padStart(10, '0') === r.Wave_Number);
        
        if (existing) {
            existing.Planned_Pick_Date = r.Planned_Pick_Date || existing.Planned_Pick_Date;
            existing.Planned_Pick_Time = r.Planned_Pick_Time || existing.Planned_Pick_Time;
            existing.Planned_Load_Date = r.Planned_Load_Date || existing.Planned_Load_Date;
            existing.Planned_Load_Time = r.Planned_Load_Time || existing.Planned_Load_Time;
            existing.Trip_No = r.Trip_No || existing.Trip_No;
            existing.Transporter = r.Transporter || existing.Transporter;
            existing.Vehicle_Type = r.Vehicle_Type || existing.Vehicle_Type;
            existing.Vehicle_Booking_No = r.Vehicle_Booking_No || existing.Vehicle_Booking_No;
            existing.Owner_Code = r.Owner_Code || existing.Owner_Code;
            existing.Order_Type = r.Order_Type || existing.Order_Type;
            existing.Total_Qty = r.Total_Qty || existing.Total_Qty;
            updatedCount++;
        } else {
            // เพิ่มแถวใหม่
            dbWaves.push({
                Wave_Number: r.Wave_Number,
                Planned_Pick_Date: r.Planned_Pick_Date || '2026-06-18',
                Planned_Pick_Time: r.Planned_Pick_Time || '',
                Planned_Load_Date: r.Planned_Load_Date || '2026-06-18',
                Planned_Load_Time: r.Planned_Load_Time || '12:00',
                Trip_No: r.Trip_No || '1',
                Transporter: r.Transporter || 'ไม่ระบุ',
                Vehicle_Type: r.Vehicle_Type || '-',
                Vehicle_Booking_No: r.Vehicle_Booking_No || '-',
                Branch_Name: r.Branch_Name || '',
                Branch_Code: r.Branch_Code || '',
                Order_Number: r.Order_Number || '',
                Owner_Code: r.Owner_Code || 'Other',
                Order_Type: r.Order_Type || 'Normal',
                Is_HUB: r.Is_HUB ? 'TRUE' : 'FALSE',
                Time_Change_Count: r.Time_Change_Count || 0,
                Total_Qty: r.Total_Qty || 0,
                Status_Allocate: 'pending',
                Status_Print: 'pending',
                Status_Pick: 'pending',
                Status_Check: 'pending',
                Status_Truck: 'pending',
                Status_Load: 'pending',
            });
        }
    });

    await writeSheet('Waves!A:Z', dbWaves);
    waveDataCache = null;

    res.json({ success: true, inserted: rowsWithTripPlan.length, plannedWavesUpdated: updatedCount });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==========================================
// 🔴 DOCK STATUS API
// ==========================================
app.get('/api/dock/status', (req, res) => {
  res.json(Object.fromEntries(dockOverlay));
});

app.post('/api/dock/clear', (req, res) => {
  const { waveId } = req.body;
  if (waveId) {
    const stdId = standardizeWaveId(waveId);
    dockOverlay.delete(String(waveId));
    dockOverlay.delete(stdId);
  }
  res.json({ success: true });
});

// ==========================================
// 📜 API สำหรับ Log
// ==========================================
app.post('/api/logs/save', async (req, res) => {
  try {
    if (!isSheetsConfigured) return res.json({ success: true });
    
    const row = [
      new Date(req.body.ts).toISOString(),
      req.body.user || '',
      req.body.waveId || '',
      req.body.action || ''
    ];
    
    // บันทึกลงชีต Logs (ถ้าสร้างชีตชื่อ Logs แล้ว)
    await appendSheet('Logs!A:D', [row]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false });
  }
});

app.get('/api/logs', async (req, res) => {
  try {
    if (!isSheetsConfigured) return res.json([]);
    
    const rows = await readSheet('Logs!A:D');
    if (rows.length <= 0) return res.json([]);

    // สมมติ Header เป็น Timestamp, User, WaveId, Action
    const logs = rows.map(r => ({
       ts: r.Timestamp || r.timestamp || r.ts,
       user: r.User || r.user,
       waveId: r.WaveId || r.waveId,
       action: r.Action || r.action
    })).filter(l => l.ts).reverse().slice(0, 300);

    res.json(logs);
  } catch (err) {
    console.error('❌ ข้อผิดพลาดในการดึง Logs:', err.message);
    res.status(500).json([]);
  }
});

// ==========================================
// ⚙️ Settings API
// ==========================================
const SETTINGS_FILE = path.join(__dirname, 'settings.json');
if (fs.existsSync(SETTINGS_FILE)) {
  try {
    const savedSettings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    Object.assign(defaultSettings, savedSettings);
  } catch (e) {
    console.error('⚠️ อ่านไฟล์ settings.json ไม่สำเร็จ');
  }
}

app.get('/api/settings', (req, res) => res.json(defaultSettings));

app.post('/api/settings/save', (req, res) => {
  try {
    const newSettings = req.body;
    if (newSettings.slas !== undefined) defaultSettings.slas = newSettings.slas;
    if (newSettings.penaltyRate !== undefined) defaultSettings.penaltyRate = newSettings.penaltyRate;
    if (newSettings.shifts !== undefined) defaultSettings.shifts = newSettings.shifts;
    if (newSettings.beans !== undefined) defaultSettings.beans = newSettings.beans;
    if (newSettings.maxLimits !== undefined) defaultSettings.maxLimits = newSettings.maxLimits;

    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(defaultSettings, null, 4), 'utf8');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error' });
  }
});

app.get('/api/version', (req, res) => res.json({ version: '1.2.82' }));

app.get('/api/last-204-time', (req, res) => {
  res.json({ time: defaultSettings.last204Time || 'ยังไม่ได้อัปเดต' });
});

app.post('/api/update-204-time', (req, res) => {
  const serverDate = new Date();
  const fileTimeStr = serverDate.toLocaleString('th-TH', {
    timeZone: 'Asia/Bangkok',
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });

  defaultSettings.last204Time = fileTimeStr;
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(defaultSettings, null, 4), 'utf8');
  } catch (e) {
    console.error('ไม่สามารถบันทึกเวลา 204 ได้:', e);
  }
  res.json({ success: true, time: fileTimeStr });
});

// ==========================================
// 🚀 Start Server
// ==========================================
app.get(/.*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(port, () =>
  console.log(`🚀 DC Node.js Server is running at http://localhost:${port}`)
);
