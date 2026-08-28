const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');

const MAX_REASONABLE_WAVE_QTY = 1000000;

function standardizeWaveId(id) {
  if (!id) return '';
  const num = String(id).replace(/^WAVE-?/i, '').replace(/^W-?/i, '').replace(/^0+/, '');
  const paddedNum = (num === '' ? '0' : num).padStart(10, '0');
  return `Wave-${paddedNum}`;
}

function parseNumericQty(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return Math.abs(Math.round(value)) <= MAX_REASONABLE_WAVE_QTY ? Math.round(value) : 0;
  const cleaned = String(value).replace(/,/g, '').replace(/\s/g, '').replace(/[^\d.-]/g, '');
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) && Math.abs(Math.round(parsed)) <= MAX_REASONABLE_WAVE_QTY ? Math.round(parsed) : 0;
}

function getWaveNumberNoZero(id) {
  return String(id ?? '').replace(/^WAVE-?/i, '').replace(/^W-?/i, '').replace(/^0+/, '') || '0';
}

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// ⚙️ การตั้งค่า Google Sheets เป็น Database
// ==========================================
const keyFilePath = path.join(__dirname, 'key.json');
let sheets = null;
let isSheetsConfigured = false;

// ⚠️ ใช้ SPREADSHEET_ID ของคุณ
const SPREADSHEET_ID = '1TL-tj-BrvYM7i_wNHlA0x641_VOqfT9SLpmm2NZATOo';

if (fs.existsSync(keyFilePath)) {
  const sheetsAuth = new google.auth.GoogleAuth({
    keyFile: keyFilePath,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  sheets = google.sheets({ version: 'v4', auth: sheetsAuth });
  isSheetsConfigured = true;
  console.log('✅ โหลดการตั้งค่า Google Sheets สำเร็จ');
} else {
  console.warn('⚠️ ไม่พบไฟล์ key.json ระบบจะทำงานผ่าน Memory ชั่วคราว');
}

// ==========================================
// 🛠️ Google Sheets Helper Functions
// ==========================================
const WAVES_HEADERS = [
  'Wave_Number', 'Planned_Pick_Date', 'Planned_Pick_Time', 'Planned_Load_Date', 'Planned_Load_Time', 
  'Trip_No', 'Transporter', 'Vehicle_Type', 'Vehicle_Booking_No', 'Branch_Name', 'Branch_Code', 
  'Order_Number', 'Owner_Code', 'Order_Type', 'Is_HUB', 'Time_Change_Count', 'Total_Qty', 
  'Status_Allocate', 'User_Allocate', 'Time_Allocate', 
  'Status_Print', 'User_Print', 'Time_Print', 
  'Status_Pick', 'User_Pick', 'Picked_Complete_Timestamp', 
  'Status_Check', 'User_Check', 'QC_Complete_Timestamp', 
  'Status_Truck', 'User_Truck', 'Hist_Truck_Time', 
  'Status_Load', 'User_Load', 'Hist_Load_Time', 'Time_Load_Start', 'Dock_Door', 'License_Plate', 'Is_Urgent'
];

const SUMMARY_HEADERS = [
  'Wave_Number', 'Planned_Load_Date', 'Planned_Load_Time', 'Transporter', 'Vehicle_Type', 'Owner_Code', 'Total_Qty',
  'Allocate_Status', 'Allocate_OnTime',
  'Print_Status', 'Print_OnTime',
  'Pick_Status', 'Pick_OnTime',
  'QC_Status', 'QC_OnTime',
  'Truck_Status', 'Truck_OnTime',
  'Load_Status', 'Load_OnTime'
];

async function readSheet(sheetName, headersList) {
  if (!isSheetsConfigured) return [];
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!A:ZZ`,
    });
    const rows = res.data.values;
    if (!rows || rows.length < 2) return [];
    
    const actualHeaders = rows[0];
    return rows.slice(1).map(row => {
      let obj = {};
      actualHeaders.forEach((h, i) => {
        obj[h] = row[i] !== undefined ? row[i] : null;
      });
      return obj;
    });
  } catch (err) {
    console.warn(`⚠️ อ่านแผ่นงาน ${sheetName} ไม่สำเร็จ`);
    return [];
  }
}

async function writeSheet(sheetName, objectsArray, headersList) {
  if (!isSheetsConfigured) return;
  try {
    const values = [headersList];
    objectsArray.forEach(obj => {
      values.push(headersList.map(h => obj[h] !== undefined && obj[h] !== null ? String(obj[h]) : ''));
    });

    await sheets.spreadsheets.values.clear({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!A1:ZZ`,
    });

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!A1`,
      valueInputOption: 'USER_ENTERED',
      resource: { values },
    });
  } catch (err) {
    console.error(`⚠️ เขียนข้อมูลลง ${sheetName} ไม่สำเร็จ:`, err.message);
  }
}

async function appendSheet(sheetName, valuesArray) {
  if (!isSheetsConfigured) return;
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!A:A`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      resource: { values: valuesArray },
    });
  } catch (err) {}
}

// ==========================================
// 📊 Dashboard Summary On-Time Logic
// ==========================================
async function updateDashboardSummary(dbWaves) {
  if (!isSheetsConfigured) return;
  
  const summaryData = dbWaves.map(w => {
    let targetMs = null;
    if (w.Planned_Load_Date) {
      const timeStr = w.Planned_Load_Time || '00:00';
      // แปลงเวลาให้เป็น Timestamp (สมมติโซนเวลาไทย +07:00)
      const d = new Date(`${w.Planned_Load_Date}T${timeStr}:00+07:00`);
      if(!isNaN(d.getTime())) targetMs = d.getTime();
    }

    // เช็ค SLA: ลบเวลาถอยหลังจากเป้าหมายโหลด
    const checkSLA = (actualTimeStr, minusMins) => {
      if (!actualTimeStr || actualTimeStr === '-' || actualTimeStr === '') return 'Pending';
      const actualDate = new Date(actualTimeStr);
      if (isNaN(actualDate.getTime())) return 'Pending';
      if (!targetMs) return 'No_Plan'; // ไม่มีเวลาเป้าหมายให้คำนวณ
      
      const slaLimitTime = targetMs - (minusMins * 60000);
      return actualDate.getTime() <= slaTime ? 'On-Time' : 'Late';
    };

    return {
      Wave_Number: w.Wave_Number,
      Planned_Load_Date: w.Planned_Load_Date,
      Planned_Load_Time: w.Planned_Load_Time,
      Transporter: w.Transporter,
      Vehicle_Type: w.Vehicle_Type,
      Owner_Code: w.Owner_Code,
      Total_Qty: w.Total_Qty,
      Allocate_Status: w.Status_Allocate,
      Allocate_OnTime: checkSLA(w.Time_Allocate, 180), // 3 ชั่วโมงก่อนโหลด
      Print_Status: w.Status_Print,
      Print_OnTime: checkSLA(w.Time_Print, 120), // 2 ชั่วโมงก่อนโหลด
      Pick_Status: w.Status_Pick,
      Pick_OnTime: checkSLA(w.Picked_Complete_Timestamp, 90), // 1.5 ชั่วโมงก่อนโหลด
      QC_Status: w.Status_Check,
      QC_OnTime: checkSLA(w.QC_Complete_Timestamp, 30), // 30 นาทีก่อนโหลด
      Truck_Status: w.Status_Truck,
      Truck_OnTime: checkSLA(w.Hist_Truck_Time, 15), // รถเข้า 15 นาทีก่อนโหลด
      Load_Status: w.Status_Load,
      Load_OnTime: checkSLA(w.Hist_Load_Time, 0) // โหลดเสร็จตรงเวลา
    };
  });

  await writeSheet('Dashboard_Summary', summaryData, SUMMARY_HEADERS);
}

// ==========================================
// การตั้งค่าเริ่มต้น & In-Memory Data
// ==========================================
const CURRENT_SHIFT_SETTINGS = { morningStart: '07:00', morningEnd: '16:00', nightStart: '19:00', nightEnd: '04:00' };
const defaultSettings = { slas: { '4W': 30, '6W': 45, '10W': 60, TRACTOR: 90 }, penaltyRate: 100, shifts: { ...CURRENT_SHIFT_SETTINGS }, maxLimits: { DM02: 35000, DP02: 25000, Other: 100000 } };
let mockWaves = [];
const dockOverlay = new Map();
const liveStatusOverlay = new Map();
const WMS204_FILE = path.join(__dirname, 'wms204-store.json');
let wms204Store = { updatedAt: null, rows: {} };

function loadWms204Store() {
  try { if (fs.existsSync(WMS204_FILE)) wms204Store = JSON.parse(fs.readFileSync(WMS204_FILE, 'utf8')); } catch (err) {}
}
function saveWms204Store() {
  try { fs.writeFileSync(WMS204_FILE, JSON.stringify(wms204Store, null, 2), 'utf8'); } catch (err) {}
}
loadWms204Store();

// ==========================================
// 🚀 API Endpoints
// ==========================================

let employeeCache = null;
let lastCacheTime = 0;

app.post('/api/verify-employee', async (req, res) => {
  const empId = String(req.body.employeeId || '').trim();
  if (!empId) return res.json({ success: false, message: 'กรุณาระบุรหัสพนักงาน' });
  if (empId === '171080') return res.json({ success: true, name: 'Jooner' });

  if (isSheetsConfigured) {
    const now = Date.now();
    if (!employeeCache || now - lastCacheTime > 3600000) {
      try {
        const response = await sheets.spreadsheets.values.get({ spreadsheetId: '1AWOeqhCqmBlSfGI5FWJVU4F77lDGNWBUH-TYpJeiYnI', range: 'บันทึกเวลาทำงาน!B25:C' });
        if (response.data.values) {
          employeeCache = {};
          response.data.values.forEach(row => { if (row[0] && row[1]) employeeCache[String(row[0]).trim()] = String(row[1]).trim(); });
          lastCacheTime = now;
        }
      } catch (err) {}
    }
    if (employeeCache && employeeCache[empId]) return res.json({ success: true, name: employeeCache[empId] });
  }

  const backupTeam = { 'EMP01': 'วันดี', 'EMP02': 'จิรวรรณ', 'EMP03': 'ศุภนิดา' };
  if (backupTeam[empId]) res.json({ success: true, name: backupTeam[empId] });
  else res.json({ success: false, message: 'ไม่พบรหัสพนักงาน' });
});

app.get('/api/waves/live', async (req, res) => {
  try {
    let resultData = isSheetsConfigured ? await readSheet('Waves', WAVES_HEADERS) : mockWaves;
    
    resultData = resultData.map(row => {
      const cleanId = standardizeWaveId(row.Wave_Number);
      row.Wave_Number = cleanId;
      const wms = wms204Store.rows[cleanId];
      if (wms) {
        row.WMS_Status = wms.status;
        row.WMS_Allocated_Qty = wms.allocQ;
        row.WMS_Total_Qty = wms.totalQ;
      }
      return row;
    });

    res.json(resultData);
  } catch (err) { res.json([]); }
});

app.post('/api/waves/update-status', async (req, res) => {
  try {
    const payload = req.body;
    if (!payload || payload.length === 0) return res.json({ success: true });

    let dbWaves = isSheetsConfigured ? await readSheet('Waves', WAVES_HEADERS) : mockWaves;
    let hasChanges = false;

    payload.forEach((incomingWave) => {
      const cleanId = getWaveNumberNoZero(incomingWave.id).padStart(10, '0');
      let targetRow = dbWaves.find(w => getWaveNumberNoZero(w.Wave_Number).padStart(10, '0') === cleanId);

      if (targetRow) {
        hasChanges = true;
        if (incomingWave.totalPieces !== undefined) targetRow.Total_Qty = Math.round(Number(incomingWave.totalPieces)) || 0;
        if (incomingWave.transporter) targetRow.Transporter = incomingWave.transporter;
        if (incomingWave.vehicleType) targetRow.Vehicle_Type = incomingWave.vehicleType;
        if (incomingWave.bookingNo) targetRow.Vehicle_Booking_No = incomingWave.bookingNo;
        if (incomingWave.licensePlate) targetRow.License_Plate = incomingWave.licensePlate;
        if (incomingWave.isUrgent !== undefined) targetRow.Is_Urgent = String(incomingWave.isUrgent);

        if (incomingWave.planUpdate) {
          targetRow.Planned_Pick_Date = incomingWave.plannedPickDate;
          targetRow.Planned_Pick_Time = incomingWave.plannedPickTime;
          targetRow.Planned_Load_Date = incomingWave.plannedLoadDate;
          targetRow.Planned_Load_Time = incomingWave.plannedLoadTime;
        }

        (incomingWave.steps || []).forEach(s => {
          let key = s.key;
          let capKey = key.charAt(0).toUpperCase() + key.slice(1);
          targetRow[`Status_${capKey}`] = s.status;
          targetRow[`User_${capKey}`] = s.status === 'pending' || s.status === 'reverted' ? '' : (s.actionUser || '');

          let timeCol = key === 'pick' ? 'Picked_Complete_Timestamp' : (key === 'check' ? 'QC_Complete_Timestamp' : (key === 'truck' ? 'Hist_Truck_Time' : (key === 'load' ? 'Hist_Load_Time' : `Time_${capKey}`)));

          if (s.status === 'reverted' || s.status === 'pending') {
            targetRow[timeCol] = '';
          } else if (s.actualTime && s.actualTime !== '-') {
             let d = s.actualTimestamp && s.actualTimestamp !== '-' && s.actualTimestamp !== 'null' ? new Date(Number(s.actualTimestamp)) : new Date();
             targetRow[timeCol] = d.toISOString();
          }

          if (key === 'load') {
            if (s.status === 'pending' || s.status === 'reverted') {
              targetRow.Dock_Door = ''; targetRow.Time_Load_Start = '';
              dockOverlay.delete(incomingWave.id);
            } else {
              if (s.dockInfo && s.dockInfo !== '-') targetRow.Dock_Door = s.dockInfo;
              if (s.doingDateObj && s.doingDateObj !== '-' && s.doingDateObj !== 'null') targetRow.Time_Load_Start = new Date(Number(s.doingDateObj)).toISOString();
              dockOverlay.set(incomingWave.id, { dockDoor: targetRow.Dock_Door, loadStatus: s.status, licensePlate: targetRow.License_Plate, loadStartTime: s.doingDateObj, updatedAt: Date.now() });
            }
          }
        });
      }
    });

    if (hasChanges && isSheetsConfigured) {
      await writeSheet('Waves', dbWaves, WAVES_HEADERS);
      await updateDashboardSummary(dbWaves); // 📊 สร้างและเขียน On-Time ทันที
    }

    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: err.toString() }); }
});

app.post('/api/waves/bulk-insert', async (req, res) => {
  try {
    const data = req.body;
    if (!data || data.length === 0) return res.json({ success: false, message: 'ไม่มีข้อมูลในไฟล์' });

    let dbWaves = isSheetsConfigured ? await readSheet('Waves', WAVES_HEADERS) : mockWaves;
    let updatedCount = 0;
    
    data.forEach(r => {
        let cleanId = getWaveNumberNoZero(r.Wave_Number).padStart(10, '0');
        let existing = dbWaves.find(w => getWaveNumberNoZero(w.Wave_Number).padStart(10, '0') === cleanId);
        
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
            existing.Total_Qty = r.Total_Qty || existing.Total_Qty;
            updatedCount++;
        } else {
            dbWaves.push({
                Wave_Number: standardizeWaveId(cleanId),
                Planned_Pick_Date: r.Planned_Pick_Date || '2026-06-18',
                Planned_Pick_Time: r.Planned_Pick_Time || '',
                Planned_Load_Date: r.Planned_Load_Date || '2026-06-18',
                Planned_Load_Time: r.Planned_Load_Time || '12:00',
                Trip_No: r.Trip_No || '1',
                Transporter: r.Transporter || 'ไม่ระบุ',
                Vehicle_Type: r.Vehicle_Type || '-',
                Vehicle_Booking_No: r.Vehicle_Booking_No || '-',
                Owner_Code: r.Owner_Code || 'Other',
                Total_Qty: r.Total_Qty || 0,
                Status_Allocate: 'pending', Status_Print: 'pending', Status_Pick: 'pending', 
                Status_Check: 'pending', Status_Truck: 'pending', Status_Load: 'pending'
            });
        }
    });

    if (isSheetsConfigured) {
      await writeSheet('Waves', dbWaves, WAVES_HEADERS);
      await updateDashboardSummary(dbWaves); // 📊 อัปเดต Summary เมื่อมีนำเข้าแผน
    }

    res.json({ success: true, inserted: data.length, plannedWavesUpdated: updatedCount });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/waves/delete-id', async (req, res) => {
  try {
    let cleanId = getWaveNumberNoZero(req.body.waveId);
    let dbWaves = isSheetsConfigured ? await readSheet('Waves', WAVES_HEADERS) : mockWaves;
    
    let originalLength = dbWaves.length;
    dbWaves = dbWaves.filter(w => getWaveNumberNoZero(w.Wave_Number) !== cleanId);
    
    if (dbWaves.length !== originalLength && isSheetsConfigured) {
       await writeSheet('Waves', dbWaves, WAVES_HEADERS);
       await updateDashboardSummary(dbWaves);
    }
    res.json({ success: true });
  } catch (err) { res.json({ success: false, message: err.toString() }); }
});

app.post('/api/waves/delete', async (req, res) => {
  try {
    const dateStr = String(req.body.dateStr || '').trim();
    let dbWaves = isSheetsConfigured ? await readSheet('Waves', WAVES_HEADERS) : mockWaves;
    
    let originalLength = dbWaves.length;
    dbWaves = dbWaves.filter((w) => String(w.Planned_Pick_Date).slice(0, 10) !== dateStr);
    
    if (dbWaves.length !== originalLength && isSheetsConfigured) {
       await writeSheet('Waves', dbWaves, WAVES_HEADERS);
       await updateDashboardSummary(dbWaves);
    }
    res.json({ success: true });
  } catch (err) { res.json({ success: false, message: err.toString() }); }
});

// ==========================================
// 🔴 DOCK & LOGS
// ==========================================
app.get('/api/dock/status', (req, res) => res.json(Object.fromEntries(dockOverlay)));
app.post('/api/dock/clear', (req, res) => { dockOverlay.delete(String(req.body.waveId)); res.json({ success: true }); });

app.post('/api/logs/save', async (req, res) => {
  try {
    if (!isSheetsConfigured) return res.json({ success: true });
    await appendSheet('System_Logs', [[new Date(req.body.ts).toISOString(), req.body.user || '', req.body.waveId || '', req.body.action || '']]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false }); }
});

app.get('/api/logs', async (req, res) => {
  try {
    if (!isSheetsConfigured) return res.json([]);
    const rows = await readSheet('System_Logs', ['Timestamp', 'User', 'Wave_ID', 'Action']);
    const logs = rows.map(r => ({ ts: r.Timestamp, user: r.User, waveId: r.Wave_ID, action: r.Action })).filter(l => l.ts).reverse().slice(0, 300);
    res.json(logs);
  } catch (err) { res.status(500).json([]); }
});

// ==========================================
// ⚙️ WMS 204 & Settings
// ==========================================
const SETTINGS_FILE = path.join(__dirname, 'settings.json');
if (fs.existsSync(SETTINGS_FILE)) { try { Object.assign(defaultSettings, JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))); } catch (e) {} }

app.get('/api/settings', (req, res) => res.json(defaultSettings));
app.post('/api/settings/save', (req, res) => {
  Object.assign(defaultSettings, req.body);
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(defaultSettings, null, 4), 'utf8');
  res.json({ success: true });
});

app.get('/api/version', (req, res) => res.json({ version: '1.4.0' }));
app.get('/api/last-204-time', (req, res) => res.json({ time: defaultSettings.last204Time || 'ยังไม่ได้อัปเดต' }));
app.post('/api/update-204-time', (req, res) => {
  defaultSettings.last204Time = new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(defaultSettings, null, 4), 'utf8');
  res.json({ success: true, time: defaultSettings.last204Time });
});

app.post('/api/wms-204/bulk', (req, res) => {
  try {
    const records = Array.isArray(req.body && req.body.records) ? req.body.records : [];
    records.forEach(r => {
      wms204Store.rows[standardizeWaveId(r.id)] = { status: r.status, allocQ: parseNumericQty(r.allocQ), totalQ: parseNumericQty(r.totalQ), pieces: parseNumericQty(r.pieces), updatedAt: new Date().toISOString() };
    });
    saveWms204Store();
    res.json({ success: true, count: Object.keys(wms204Store.rows).length });
  } catch (err) { res.status(500).json({ success: false }); }
});

app.get(/.*/, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(port, () => console.log(`🚀 DC Node.js Server is running at http://localhost:${port}`));
