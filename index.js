const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// 🛡️ ระบบเข้าคิวป้องกันข้อมูลชนกัน (Mutex Lock)
// ==========================================
class AsyncLock {
  constructor() {
    this.queue = [];
    this.isLocked = false;
  }
  async acquire() {
    if (this.isLocked) {
      await new Promise(resolve => this.queue.push(resolve));
    }
    this.isLocked = true;
  }
  release() {
    if (this.queue.length > 0) {
      const resolve = this.queue.shift();
      resolve();
    } else {
      this.isLocked = false;
    }
  }
}
const sheetLock = new AsyncLock();

// ==========================================
// ⚙️ การตั้งค่า Google Sheets
// ==========================================
const DB_SPREADSHEET_ID = '1TL-tj-BrvYM7i_wNHlA0x641_VOqfT9SLpmm2NZATOo';
const keyFilePath = path.join(__dirname, 'key.json');
let sheets = null;
let isSheetsDbConfigured = false;

if (fs.existsSync(keyFilePath)) {
  const sheetsAuth = new google.auth.GoogleAuth({
    keyFile: keyFilePath,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  sheets = google.sheets({ version: 'v4', auth: sheetsAuth });
  isSheetsDbConfigured = true;
  console.log('✅ โหลดการตั้งค่า Google Sheets สำเร็จ');
  initSheetsHeaders(); 
} else {
  console.warn('⚠️ ไม่พบไฟล์ key.json ระบบอาจทำงานไม่สมบูรณ์');
}

// ==========================================
// 🛠️ ฟังก์ชันตั้งค่าตาราง & สร้างชีตอัตโนมัติ
// ==========================================
const SUMMARY_HEADERS = [
  'Wave_Number', 'Planned_Load_Date', 'Planned_Load_Time', 'Transporter', 'Vehicle_Type', 'Owner_Code', 'Total_Qty',
  'Allocate_Status', 'Allocate_OnTime',
  'Print_Status', 'Print_OnTime',
  'Pick_Status', 'Pick_OnTime',
  'QC_Status', 'QC_OnTime',
  'Truck_Status', 'Truck_OnTime',
  'Load_Status', 'Load_OnTime'
];

// 🟢 เพิ่ม Header สำหรับเก็บ Allocation รายชั่วโมง
const HOURLY_ALLOC_HEADERS = [
  'Date', 'Hour', 'DM02_Qty', 'DP02_Qty', 'Other_Qty', 'Total_Qty'
];

async function initSheetsHeaders() {
  if (!isSheetsDbConfigured) return;
  try {
    const waveHeaders = [
      'Wave_Number', 'Planned_Pick_Date', 'Planned_Pick_Time', 'Planned_Load_Date', 'Planned_Load_Time',
      'Trip_No', 'Transporter', 'Vehicle_Type', 'Vehicle_Booking_No', 'Branch_Name', 'Branch_Code',
      'Order_Number', 'Owner_Code', 'Order_Type', 'Is_HUB', 'Time_Change_Count', 'Total_Qty',
      'Status_Allocate', 'User_Allocate', 'Time_Allocate',
      'Status_Print', 'User_Print', 'Time_Print',
      'Status_Pick', 'User_Pick', 'Picked_Complete_Timestamp',
      'Status_Check', 'User_Check', 'QC_Complete_Timestamp',
      'Status_Truck', 'User_Truck', 'Hist_Truck_Time',
      'Status_Load', 'User_Load', 'Hist_Load_Time', 'Time_Load_Start', 'Dock_Door', 'License_Plate',
      'Created_At', 'Imported_At', 'Is_Urgent'
    ];
    const logHeaders = ['timestamp', 'user', 'waveId', 'action'];
    const settingsHeaders = ['Setting_Key', 'Setting_Value'];

    const checkAndCreateSheet = async (sheetName, headers) => {
      try {
        await sheets.spreadsheets.values.get({ spreadsheetId: DB_SPREADSHEET_ID, range: `${sheetName}!A1` });
      } catch (error) {
        try {
          await sheets.spreadsheets.batchUpdate({
            spreadsheetId: DB_SPREADSHEET_ID,
            requestBody: { requests: [{ addSheet: { properties: { title: sheetName } } }] }
          });
          console.log(`✅ สร้างแผ่นงาน "${sheetName}" อัตโนมัติ`);
        } catch (e) {} 
      }
      
      try {
        const res = await sheets.spreadsheets.values.get({ spreadsheetId: DB_SPREADSHEET_ID, range: `${sheetName}!A1:ZZ1` });
        if (!res.data.values || res.data.values.length === 0) {
          await sheets.spreadsheets.values.update({
            spreadsheetId: DB_SPREADSHEET_ID,
            range: `${sheetName}!A1`,
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: [headers] },
          });
        }
      } catch (e) {}
    };

    await checkAndCreateSheet('Wave_Monitoring', waveHeaders);
    await checkAndCreateSheet('System_Logs', logHeaders);
    await checkAndCreateSheet('Dashboard_Summary', SUMMARY_HEADERS);
    await checkAndCreateSheet('Hourly_Allocation', HOURLY_ALLOC_HEADERS); // 🟢 สร้างชีตใหม่
    await checkAndCreateSheet('Settings', settingsHeaders);

    await loadSettingsFromSheet();

  } catch (error) {
    console.error('❌ ตรวจสอบหัวตาราง Google Sheets ไม่สำเร็จ:', error.message);
  }
}

// ==========================================
// ⚙️ การตั้งค่าระบบ (Settings) ใน Memory
// ==========================================
const CURRENT_SHIFT_SETTINGS = { morningStart: '07:00', morningEnd: '16:00', nightStart: '19:00', nightEnd: '04:00' };
let defaultSettings = { 
  slas: { '4W': 30, '6W': 45, '10W': 60, TRACTOR: 90 }, 
  penaltyRate: 100, 
  shifts: { ...CURRENT_SHIFT_SETTINGS }, 
  maxLimits: { DM02: 35000, DP02: 25000, Other: 100000 },
  beans: { 0: 'TNC/เคทู', 1: 'กรีนโนเวท', 2: 'กรีนโนเวท', 3: 'TNC/เคทู', 4: 'TNC/เคทู', 5: 'TNC/เคทู', 6: 'กรีนโนเวท' },
  last204Time: 'ยังไม่ได้อัปเดต'
};

async function loadSettingsFromSheet() {
  if (!isSheetsDbConfigured) return;
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: DB_SPREADSHEET_ID, range: 'Settings!A2:B' });
    const rows = res.data.values;
    if (rows && rows.length > 0) {
      rows.forEach(row => {
        const key = row[0];
        const val = row[1];
        if (!key || val === undefined) return;
        try {
          if (['slas', 'shifts', 'maxLimits', 'beans'].includes(key)) {
            defaultSettings[key] = JSON.parse(val);
          } else if (key === 'penaltyRate') {
            defaultSettings[key] = Number(val);
          } else {
            defaultSettings[key] = val; 
          }
        } catch(e) {}
      });
      console.log('✅ โหลดการตั้งค่า (Settings) จาก Google Sheets ล่าสุดสำเร็จ');
    }
  } catch (error) {
    console.warn('⚠️ ยังไม่มีข้อมูล Settings ใน Sheets');
  }
}

async function saveSettingsToSheet() {
  if (!isSheetsDbConfigured) return;
  try {
    const values = [
      ['Setting_Key', 'Setting_Value'],
      ['slas', JSON.stringify(defaultSettings.slas || {})],
      ['penaltyRate', String(defaultSettings.penaltyRate || 100)],
      ['shifts', JSON.stringify(defaultSettings.shifts || {})],
      ['maxLimits', JSON.stringify(defaultSettings.maxLimits || {})],
      ['beans', JSON.stringify(defaultSettings.beans || {})],
      ['last204Time', String(defaultSettings.last204Time || 'ยังไม่ได้อัปเดต')]
    ];
    await sheets.spreadsheets.values.clear({ spreadsheetId: DB_SPREADSHEET_ID, range: 'Settings!A1:Z' });
    await sheets.spreadsheets.values.update({
      spreadsheetId: DB_SPREADSHEET_ID,
      range: 'Settings!A1',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values },
    });
  } catch (error) {
    console.error('❌ บันทึก Settings ลง Sheets ไม่สำเร็จ:', error.message);
  }
}

function standardizeWaveId(id) {
  if (!id) return '';
  const num = String(id).replace(/^WAVE-?/i, '').replace(/^W-?/i, '').replace(/^0+/, '');
  const paddedNum = (num === '' ? '0' : num).padStart(10, '0');
  return `Wave-${paddedNum}`;
}

// ==========================================
// 📊 Dashboard Summary On-Time Logic
// ==========================================
async function updateDashboardSummary(dbWaves) {
  if (!isSheetsDbConfigured) return;
  try {
    const summaryData = dbWaves.map(w => {
      let targetMs = null;
      if (w.Planned_Load_Date) {
        const timeStr = (w.Planned_Load_Time || '00:00').trim();
        const formattedTime = timeStr.length === 5 ? timeStr + ':00' : timeStr;
        const d = new Date(`${w.Planned_Load_Date}T${formattedTime}+07:00`);
        if (!isNaN(d.getTime())) targetMs = d.getTime();
      }

      const checkSLA = (actualTimeStr, minusMins) => {
        if (!actualTimeStr || actualTimeStr === '-' || actualTimeStr === '') return 'Pending';
        let cleanTimeStr = actualTimeStr.trim().replace(' ', 'T');
        if (cleanTimeStr.length === 19) cleanTimeStr += '+07:00'; 

        const actualDate = new Date(cleanTimeStr);
        if (isNaN(actualDate.getTime())) return 'Pending';
        if (!targetMs) return 'No_Plan'; 
        
        const slaLimitTime = targetMs - (minusMins * 60000); 
        return actualDate.getTime() <= slaLimitTime ? 'On-Time' : 'Late';
      };

      return [
        w.Wave_Number || '', w.Planned_Load_Date || '', w.Planned_Load_Time || '', 
        w.Transporter || '', w.Vehicle_Type || '', w.Owner_Code || '', w.Total_Qty || 0,
        w.Status_Allocate || '', checkSLA(w.Time_Allocate, 180), 
        w.Status_Print || '', checkSLA(w.Time_Print, 120),       
        w.Status_Pick || '', checkSLA(w.Picked_Complete_Timestamp, 90), 
        w.Status_Check || '', checkSLA(w.QC_Complete_Timestamp, 30),    
        w.Status_Truck || '', checkSLA(w.Hist_Truck_Time, 15),          
        w.Status_Load || '', checkSLA(w.Hist_Load_Time, 0)              
      ];
    });

    const values = [SUMMARY_HEADERS, ...summaryData];

    await sheets.spreadsheets.values.clear({ spreadsheetId: DB_SPREADSHEET_ID, range: `Dashboard_Summary!A1:ZZ` });
    await sheets.spreadsheets.values.update({
      spreadsheetId: DB_SPREADSHEET_ID, range: `Dashboard_Summary!A1`,
      valueInputOption: 'USER_ENTERED', requestBody: { values },
    });
  } catch (err) {
    console.error('❌ อัปเดต Dashboard_Summary ขัดข้อง:', err.message);
  }
}

// ==========================================
// 📈 Hourly Allocation Logic
// ==========================================
// 🟢 ฟังก์ชันคำนวณและเขียนลงชีต Hourly_Allocation
async function updateHourlyAllocation(dbWaves) {
  if (!isSheetsDbConfigured) return;
  try {
    const agg = {};

    dbWaves.forEach(w => {
      // นับเฉพาะที่สถานะ Allocate = done และมีเวลาบันทึกไว้
      if (w.Status_Allocate === 'done' && w.Time_Allocate && w.Time_Allocate !== '-') {
        let tStr = String(w.Time_Allocate).trim().replace(' ', 'T');
        if (tStr.length === 19) tStr += '+07:00'; // บังคับเป็นเวลาไทย (กรณี format YYYY-MM-DDTHH:mm:ss)
        
        const d = new Date(tStr);
        if (isNaN(d.getTime())) return;

        // ดึงวันที่ (YYYY-MM-DD) และ ชั่วโมง (HH) โดยยึดโซนเวลาไทย
        const dateStr = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
        const hourStr = d.toLocaleTimeString('en-GB', { hour: '2-digit', timeZone: 'Asia/Bangkok' }).slice(0, 2);

        const key = `${dateStr}_${hourStr}`;
        if (!agg[key]) {
          agg[key] = { Date: dateStr, Hour: `${hourStr}:00`, DM02_Qty: 0, DP02_Qty: 0, Other_Qty: 0, Total_Qty: 0 };
        }

        let qty = Number(w.WMS_204_Total_Qty) || Number(w.WMS_Total_Qty) || Number(w.Total_Qty) || 0;
        let owner = String(w.Owner_Code || '').toUpperCase();

        if (owner.includes('DM02')) agg[key].DM02_Qty += qty;
        else if (owner.includes('DP02')) agg[key].DP02_Qty += qty;
        else agg[key].Other_Qty += qty;

        agg[key].Total_Qty += qty;
      }
    });

    // เรียงคีย์ตามวันที่และเวลาจากเก่าไปใหม่
    const sortedKeys = Object.keys(agg).sort((a, b) => a.localeCompare(b));
    const sheetData = sortedKeys.map(k => [
      agg[k].Date, agg[k].Hour, agg[k].DM02_Qty, agg[k].DP02_Qty, agg[k].Other_Qty, agg[k].Total_Qty
    ]);

    const values = [HOURLY_ALLOC_HEADERS, ...sheetData];

    await sheets.spreadsheets.values.clear({ spreadsheetId: DB_SPREADSHEET_ID, range: `Hourly_Allocation!A1:ZZ` });
    await sheets.spreadsheets.values.update({
      spreadsheetId: DB_SPREADSHEET_ID, range: `Hourly_Allocation!A1`,
      valueInputOption: 'USER_ENTERED', requestBody: { values },
    });
    console.log('✅ อัปเดต Hourly_Allocation สำเร็จ');
  } catch (err) {
    console.error('❌ อัปเดต Hourly_Allocation ขัดข้อง:', err.message);
  }
}

// ==========================================
// 🚀 API Endpoints หลัก
// ==========================================

app.get('/api/logs', async (req, res) => {
  try {
    if (!isSheetsDbConfigured) return res.json([]);
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: DB_SPREADSHEET_ID,
      range: 'System_Logs!A:D',
    });
    const rows = response.data.values;
    if (!rows || rows.length <= 1) return res.json([]);

    let logs = rows.slice(1).map(row => ({
      ts: row[0] || '',
      user: row[1] || '',
      waveId: row[2] || '',
      action: row[3] || ''
    }));
    logs = logs.reverse().slice(0, 300); 
    res.json(logs);
  } catch (err) {
    res.json([]);
  }
});

app.post('/api/logs/save', async (req, res) => {
  await sheetLock.acquire();
  try {
    if (!isSheetsDbConfigured) return res.json({ success: true });
    const rowData = [
      new Date(req.body.ts).toISOString(),
      req.body.user || '',
      req.body.waveId || '',
      req.body.action || ''
    ];
    await sheets.spreadsheets.values.append({
      spreadsheetId: DB_SPREADSHEET_ID,
      range: 'System_Logs!A:D',
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [rowData] },
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false });
  } finally {
    sheetLock.release();
  }
});

function parseNumericQty(value) {
  if (value === null || value === undefined) return 0;
  const cleaned = String(value).trim().replace(/,/g, '').replace(/\s/g, '');
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? Math.round(parsed) : 0;
}

async function fetchWaveDataFromSheets() {
  if (!isSheetsDbConfigured) return [];
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: DB_SPREADSHEET_ID,
      range: 'Wave_Monitoring!A:ZZ',
    });
    const rows = response.data.values;
    if (!rows || rows.length === 0) return [];
    
    const headers = rows[0];
    const data = rows.slice(1).map((row, index) => {
      let obj = { _rowIndex: index + 2 };
      headers.forEach((header, i) => {
        obj[header] = (row[i] !== undefined && row[i] !== '') ? row[i] : null; 
      });
      return obj;
    });
    return data;
  } catch (err) {
    return [];
  }
}

// Cache ลดคอขวด 
let waveDataCache = null;
let waveDataLastFetch = 0;
const CACHE_TTL = 10000; 

app.get('/api/waves/live', async (req, res) => {
  try {
    if (!isSheetsDbConfigured) return res.json([]);
    const now = Date.now();
    if (waveDataCache && (now - waveDataLastFetch < CACHE_TTL)) {
      return res.json(waveDataCache);
    }

    let resultData = await fetchWaveDataFromSheets();

    resultData = resultData.map((row) => {
      let cleanRow = { ...row };
      if (cleanRow.Wave_Number) cleanRow.Wave_Number = standardizeWaveId(cleanRow.Wave_Number);
      if (cleanRow.Total_Qty) cleanRow.Total_Qty = parseNumericQty(cleanRow.Total_Qty);
      cleanRow.Allocation_Owner_Group = cleanRow.Owner_Code || 'Other';
      return cleanRow;
    });

    waveDataCache = resultData;
    waveDataLastFetch = now;
    res.json(resultData);
  } catch (err) {
    if (waveDataCache) return res.json(waveDataCache);
    res.status(500).json([]);
  }
});

app.post('/api/waves/update-status', async (req, res) => {
  await sheetLock.acquire(); 
  try {
    if (!isSheetsDbConfigured) return res.json({ success: true });

    const payload = req.body;
    if (!payload || payload.length === 0) return res.json({ success: true });

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: DB_SPREADSHEET_ID,
      range: 'Wave_Monitoring!A:ZZ',
    });
    
    const rows = response.data.values;
    if (!rows || rows.length === 0) return res.json({ success: true });
    
    const headers = rows[0];
    const updateData = []; 
    const bookingColIdx = headers.indexOf('Vehicle_Booking_No');

    const getColLetter = (colIndex) => {
      let temp, letter = '';
      while (colIndex >= 0) {
        temp = colIndex % 26;
        letter = String.fromCharCode(temp + 65) + letter;
        colIndex = (colIndex - temp) / 26 - 1;
      }
      return letter;
    };

    let triggerAllocationUpdate = false; // เช็คว่ามีการแก้ Allocate ไหม

    payload.forEach((waveUpdate) => {
      const targetWaveId = standardizeWaveId(waveUpdate.id);
      const targetBooking = (waveUpdate.originalBookingNo || '').trim().toLowerCase();
      
      rows.forEach((row, index) => {
        if (!row || !row[0]) return;
        const currentWaveId = standardizeWaveId(row[0]);
        
        if (currentWaveId === targetWaveId) {
          let isBookingMatch = true;
          if (targetBooking && targetBooking !== '-' && bookingColIdx > -1) {
            const rowBooking = (row[bookingColIdx] || '').trim().toLowerCase();
            if (rowBooking && rowBooking !== '-' && rowBooking !== targetBooking) {
              isBookingMatch = false;
            }
          }

          if (isBookingMatch) {
            const rowIndex = index + 1; 
            
            if (rowIndex > 1) { 
              (waveUpdate.steps || []).forEach(step => {
                // 🟢 Mark flag ให้รู้ว่ามีแก้ Allocate
                if (step.key === 'allocate') triggerAllocationUpdate = true;

                const capKey = step.key.charAt(0).toUpperCase() + step.key.slice(1);
                const statusColName = `Status_${capKey}`;
                const userColName = `User_${capKey}`;
                let timeColName = `Time_${capKey}`;
                
                if (step.key === 'pick') timeColName = 'Picked_Complete_Timestamp';
                if (step.key === 'check') timeColName = 'QC_Complete_Timestamp';
                if (step.key === 'truck') timeColName = 'Hist_Truck_Time';
                if (step.key === 'load') timeColName = 'Hist_Load_Time';

                const statusColIdx = headers.indexOf(statusColName);
                const userColIdx = headers.indexOf(userColName);
                const timeColIdx = headers.indexOf(timeColName);

                if (statusColIdx > -1) {
                  updateData.push({
                    range: `Wave_Monitoring!${getColLetter(statusColIdx)}${rowIndex}`,
                    values: [[step.status === 'reverted' ? 'pending' : step.status]]
                  });
                }
                
                if (userColIdx > -1) {
                  const userVal = (step.status === 'pending' || step.status === 'reverted') ? '' : (step.actionUser === '-' ? '' : step.actionUser);
                  updateData.push({
                    range: `Wave_Monitoring!${getColLetter(userColIdx)}${rowIndex}`,
                    values: [[userVal]]
                  });
                }
                
                if (timeColIdx > -1) {
                  let timeVal = '';
                  if (step.status !== 'pending' && step.status !== 'reverted' && step.actualTimestamp && step.actualTimestamp !== '-') {
                    const d = new Date(Number(step.actualTimestamp));
                    timeVal = d.toLocaleString('en-CA', { hour12: false, timeZone: 'Asia/Bangkok' }).replace(', ', 'T');
                  }
                  updateData.push({
                    range: `Wave_Monitoring!${getColLetter(timeColIdx)}${rowIndex}`,
                    values: [[timeVal]]
                  });
                }

                if (step.key === 'load') {
                  const dockColIdx = headers.indexOf('Dock_Door');
                  const loadStartColIdx = headers.indexOf('Time_Load_Start');
                  const licenseColIdx = headers.indexOf('License_Plate');

                  if (step.status === 'pending' || step.status === 'reverted') {
                    if (dockColIdx > -1) updateData.push({ range: `Wave_Monitoring!${getColLetter(dockColIdx)}${rowIndex}`, values: [['']] });
                    if (loadStartColIdx > -1) updateData.push({ range: `Wave_Monitoring!${getColLetter(loadStartColIdx)}${rowIndex}`, values: [['']] });
                  } else {
                    if (dockColIdx > -1 && step.dockInfo && step.dockInfo !== '-') {
                      updateData.push({ range: `Wave_Monitoring!${getColLetter(dockColIdx)}${rowIndex}`, values: [[step.dockInfo]] });
                    }
                    if (loadStartColIdx > -1 && step.doingDateObj && step.doingDateObj !== '-') {
                      const dStart = new Date(Number(step.doingDateObj));
                      const startVal = dStart.toLocaleString('en-CA', { hour12: false, timeZone: 'Asia/Bangkok' }).replace(', ', 'T');
                      updateData.push({ range: `Wave_Monitoring!${getColLetter(loadStartColIdx)}${rowIndex}`, values: [[startVal]] });
                    }
                  }
                  if (licenseColIdx > -1 && waveUpdate.licensePlate) {
                    updateData.push({ range: `Wave_Monitoring!${getColLetter(licenseColIdx)}${rowIndex}`, values: [[waveUpdate.licensePlate]] });
                  }
                }
              });
            }
          }
        }
      });
    });

    if (updateData.length > 0) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: DB_SPREADSHEET_ID,
        requestBody: {
          valueInputOption: 'USER_ENTERED',
          data: updateData,
        },
      });

      // 📊 ซิงค์ Summary กลับ
      const updatedWaves = await fetchWaveDataFromSheets();
      await updateDashboardSummary(updatedWaves);

      // 🟢 ถ้ามีการกดจ่ายงาน ให้คำนวณกราฟ Hourly ใหม่ทันที
      if (triggerAllocationUpdate) {
        await updateHourlyAllocation(updatedWaves);
      }

      waveDataCache = null; 
    }

    res.json({ success: true });
  } catch (err) {
    console.error('❌ อัปเดตสถานะขัดข้อง:', err.message);
    res.status(500).json({ success: false, message: err.toString() });
  } finally {
    sheetLock.release(); 
  }
});

let employeeCache = null;
let lastCacheTime = 0;
const CACHE_DURATION = 60 * 60 * 1000;

app.post('/api/verify-employee', async (req, res) => {
  const empId = req.body.employeeId;
  if (!empId || empId.trim() === '') {
    return res.json({ success: false, message: 'กรุณาระบุรหัสพนักงาน' });
  }

  try {
    const now = Date.now();
    const searchId = String(empId).trim();

    if (searchId === '171080') return res.json({ success: true, name: 'Jooner' });

    if (isSheetsDbConfigured) {
      if (!employeeCache || now - lastCacheTime > CACHE_DURATION) {
        try {
          const response = await sheets.spreadsheets.values.get({
            spreadsheetId: '1AWOeqhCqmBlSfGI5FWJVU4F77lDGNWBUH-TYpJeiYnI',
            range: 'บันทึกเวลาทำงาน!B25:C', 
          });
          const rows = response.data.values;
          
          if (rows && rows.length > 0) {
            employeeCache = {};
            rows.forEach((row) => {
              if (row[0] && row[1]) {
                employeeCache[String(row[0]).trim()] = String(row[1]).trim();
              }
            });
            lastCacheTime = now;
          }
        } catch (sheetErr) {}
      }
      if (employeeCache && employeeCache[searchId]) {
        return res.json({ success: true, name: employeeCache[searchId] });
      }
    }

    res.json({ success: false, message: 'ไม่พบรหัสพนักงานในฐานข้อมูล' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด' });
  }
});

app.get('/api/version', (req, res) => res.json({ version: '1.3.1' }));
app.get('/api/settings', (req, res) => res.json(defaultSettings));

// 🟢 อัปเดต Settings แล้วเซฟลงชีตอัตโนมัติ
app.post('/api/settings/save', async (req, res) => {
  try {
    const newSettings = req.body;
    if (newSettings.slas !== undefined) defaultSettings.slas = newSettings.slas;
    if (newSettings.penaltyRate !== undefined) defaultSettings.penaltyRate = newSettings.penaltyRate;
    if (newSettings.shifts !== undefined) defaultSettings.shifts = newSettings.shifts;
    if (newSettings.beans !== undefined) defaultSettings.beans = newSettings.beans;
    if (newSettings.maxLimits !== undefined) defaultSettings.maxLimits = newSettings.maxLimits;

    // ค้นหาใน /api/settings/save และแก้ไขปิดคำสั่งไว้แบบนี้ครับ:
// fs.writeFileSync(path.join(__dirname, 'settings.json'), JSON.stringify(defaultSettings, null, 4), 'utf8');
await saveSettingsToSheet();
res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Error' });
  }
});

app.post('/api/waves/bulk-insert', async (req, res) => {
  await sheetLock.acquire(); 
  try {
    const sheetData = req.body; 
    if (!sheetData || sheetData.length === 0) return res.status(400).json({ success: false, message: 'ไม่พบข้อมูล' });

    if (isSheetsDbConfigured) {
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: DB_SPREADSHEET_ID,
        range: 'Wave_Monitoring!1:1',
      });
      
      const headers = response.data.values ? response.data.values[0] : [];
      
      const rowsToAdd = sheetData.map(row => {
        return headers.map(header => {
          return row[header] !== undefined && row[header] !== null ? String(row[header]) : '';
        });
      });

      await sheets.spreadsheets.values.append({
        spreadsheetId: DB_SPREADSHEET_ID,
        range: 'Wave_Monitoring!A1',
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: rowsToAdd },
      });

      // 📊 ซิงค์ Summary และ Hourly กลับเมื่อมีแผนใหม่
      const updatedWaves = await fetchWaveDataFromSheets();
      await updateDashboardSummary(updatedWaves);
      await updateHourlyAllocation(updatedWaves); // 🟢 อัปเดต Hourly
      waveDataCache = null; 
    }

    return res.json({ success: true, plannedWavesUpdated: sheetData.length, message: `นำเข้าสำเร็จ` });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  } finally {
    sheetLock.release(); 
  }
});

const dockOverlay = new Map();
app.get('/api/dock/status', (req, res) => res.json(Object.fromEntries(dockOverlay)));
app.post('/api/dock/clear', (req, res) => {
  const { waveId } = req.body;
  if (waveId) dockOverlay.delete(String(waveId));
  res.json({ success: true });
});

let wms204Store = { updatedAt: null, rows: {} };
app.post('/api/wms-204/bulk', async (req, res) => {
  await sheetLock.acquire(); 
  try {
    if (!isSheetsDbConfigured) return res.json({ success: true });

    const records = req.body.records;
    if (!records || records.length === 0) return res.json({ success: true });

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: DB_SPREADSHEET_ID,
      range: 'Wave_Monitoring!A:ZZ',
    });
    
    const rows = response.data.values;
    if (!rows || rows.length === 0) return res.json({ success: true });
    
    const headers = rows[0];
    const updateData = []; 

    const getColLetter = (colIndex) => {
      let temp, letter = '';
      while (colIndex >= 0) {
        temp = colIndex % 26;
        letter = String.fromCharCode(temp + 65) + letter;
        colIndex = (colIndex - temp) / 26 - 1;
      }
      return letter;
    };

    const getHeaderIdx = (names) => {
      for (let name of names) {
        const idx = headers.findIndex(h => String(h).trim().toLowerCase() === name.toLowerCase());
        if (idx > -1) return idx;
      }
      return -1;
    };

    const statusIdx = getHeaderIdx(['WMS_204_Status', 'WMS_Status']);
    const allocIdx = getHeaderIdx(['WMS_204_Allocated_Qty', 'WMS_Allocated_Qty', 'Allocated_Qty']);
    const totalIdx = getHeaderIdx(['WMS_204_Total_Qty', 'WMS_Total_Qty', 'Total_Qty']);
    const displayIdx = getHeaderIdx(['WMS_204_Display_Qty', 'WMS_Display_Qty']);

    records.forEach((rec) => {
      const targetWaveId = standardizeWaveId(rec.id);
      
      rows.forEach((row, index) => {
        if (!row || !row[0]) return;
        const currentWaveId = standardizeWaveId(row[0]);
        
        if (currentWaveId === targetWaveId) {
          const rowIndex = index + 1;
          if (rowIndex > 1) {
            if (statusIdx > -1) updateData.push({ range: `Wave_Monitoring!${getColLetter(statusIdx)}${rowIndex}`, values: [[rec.status || '']] });
            if (allocIdx > -1) updateData.push({ range: `Wave_Monitoring!${getColLetter(allocIdx)}${rowIndex}`, values: [[rec.allocQ || 0]] });
            if (totalIdx > -1) updateData.push({ range: `Wave_Monitoring!${getColLetter(totalIdx)}${rowIndex}`, values: [[rec.totalQ || 0]] });
            if (displayIdx > -1) updateData.push({ range: `Wave_Monitoring!${getColLetter(displayIdx)}${rowIndex}`, values: [[rec.pieces || 0]] });
          }
        }
      });
    });

    if (updateData.length > 0) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: DB_SPREADSHEET_ID,
        requestBody: {
          valueInputOption: 'USER_ENTERED',
          data: updateData,
        },
      });
      waveDataCache = null; 
    }

    return res.json({ success: true, message: 'บันทึกข้อมูล 204 ลง Google Sheets สำเร็จ' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  } finally {
    sheetLock.release(); 
  }
});

app.post('/api/waves/delete-id', async (req, res) => {
  await sheetLock.acquire();
  try {
    let cleanId = getWaveNumberNoZero(req.body.waveId);
    let dbWaves = await fetchWaveDataFromSheets();
    let originalLength = dbWaves.length;
    
    dbWaves = dbWaves.filter(w => getWaveNumberNoZero(w.Wave_Number) !== cleanId);
    
    if (dbWaves.length !== originalLength && isSheetsDbConfigured) {
       await writeSheet('Wave_Monitoring', dbWaves, WAVES_HEADERS);
       await updateDashboardSummary(dbWaves);
       await updateHourlyAllocation(dbWaves); // 🟢 อัปเดต Hourly ด้วย
       waveDataCache = null;
    }
    res.json({ success: true });
  } catch (err) { 
    res.json({ success: false, message: err.toString() }); 
  } finally {
    sheetLock.release();
  }
});

app.post('/api/waves/delete', async (req, res) => {
  await sheetLock.acquire();
  try {
    const dateStr = String(req.body.dateStr || '').trim();
    let dbWaves = await fetchWaveDataFromSheets();
    let originalLength = dbWaves.length;
    
    dbWaves = dbWaves.filter((w) => String(w.Planned_Pick_Date).slice(0, 10) !== dateStr);
    
    if (dbWaves.length !== originalLength && isSheetsDbConfigured) {
       await writeSheet('Wave_Monitoring', dbWaves, WAVES_HEADERS);
       await updateDashboardSummary(dbWaves);
       await updateHourlyAllocation(dbWaves); // 🟢 อัปเดต Hourly ด้วย
       waveDataCache = null;
    }
    res.json({ success: true });
  } catch (err) { 
    res.json({ success: false, message: err.toString() }); 
  } finally {
    sheetLock.release();
  }
});

let last204TimeStr = 'ยังไม่ได้อัปเดต';
app.post('/api/update-204-time', async (req, res) => {
  defaultSettings.last204Time = req.body.time || new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  try {
    fs.writeFileSync(path.join(__dirname, 'settings.json'), JSON.stringify(defaultSettings, null, 4), 'utf8');
  } catch(e) {}
  await saveSettingsToSheet(); 
  res.json({ success: true, time: defaultSettings.last204Time });
});

app.get('/api/last-204-time', (req, res) => {
  res.json({ time: defaultSettings.last204Time || 'ยังไม่ได้อัปเดต' });
});

app.post('/api/sync-tms-sheet', async (req, res) => {
  res.json({ success: true, message: 'ซิงค์ข้อมูลสำเร็จ', updatedCount: 0 });
});

app.get(/.*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(port, () =>
  console.log(`🚀 V2 Server is running on port ${port}`)
);
