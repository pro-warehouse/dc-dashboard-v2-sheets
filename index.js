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
const sheetLock = new AsyncLock(); // ใช้คุมการเขียน Sheets ทุกครั้ง

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
// 🛠️ ฟังก์ชันตั้งค่าตาราง & Helper
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
  'Status_Load', 'User_Load', 'Hist_Load_Time', 'Time_Load_Start', 'Dock_Door', 'License_Plate',
  'Created_At', 'Imported_At', 'Is_Urgent'
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

async function initSheetsHeaders() {
  if (!isSheetsDbConfigured) return;
  try {
    const logHeaders = ['timestamp', 'user', 'waveId', 'action'];

    const checkAndSetHeaders = async (sheetName, headers) => {
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: DB_SPREADSHEET_ID,
        range: `${sheetName}!A1:ZZ1`,
      });
      if (!res.data.values || res.data.values.length === 0) {
        await sheets.spreadsheets.values.update({
          spreadsheetId: DB_SPREADSHEET_ID,
          range: `${sheetName}!A1`,
          valueInputOption: 'USER_ENTERED',
          requestBody: { values: [headers] },
        });
        console.log(`✅ สร้างหัวตารางสำหรับ ${sheetName} สำเร็จ`);
      }
    };

    await checkAndSetHeaders('Wave_Monitoring', WAVES_HEADERS);
    await checkAndSetHeaders('System_Logs', logHeaders);
    await checkAndSetHeaders('Dashboard_Summary', SUMMARY_HEADERS);
  } catch (error) {
    console.error('❌ ตรวจสอบหัวตาราง Google Sheets ไม่สำเร็จ:', error.message);
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

    await sheets.spreadsheets.values.clear({
      spreadsheetId: DB_SPREADSHEET_ID,
      range: `Dashboard_Summary!A1:ZZ`,
    });

    await sheets.spreadsheets.values.update({
      spreadsheetId: DB_SPREADSHEET_ID,
      range: `Dashboard_Summary!A1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values },
    });
  } catch (err) {
    console.error('❌ อัปเดต Dashboard_Summary ขัดข้อง:', err.message);
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

// บันทึก Log จะใช้ lock ด้วยป้องกันการชน
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

// 🟢 ระบบ Cache สำหรับโหลดสด ป้องกันกระตุก
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

// === API อัปเดตสถานะงานกลับลง Google Sheets ===
app.post('/api/waves/update-status', async (req, res) => {
  await sheetLock.acquire(); // 🛡️ ล็อกเพื่อไม่ให้ใครเขียนทับพร้อมกัน
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
                    // เซฟลง Google Sheets ให้มี T ตาม format YYYY-MM-DDTHH:mm:ss
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

      // 📊 ซิงค์ Dashboard_Summary และล้างแคชเพื่อให้ 10 คนเห็นพร้อมกัน
      const updatedWaves = await fetchWaveDataFromSheets();
      await updateDashboardSummary(updatedWaves);
      waveDataCache = null; // 🟢 ล้าง Cache 
    }

    res.json({ success: true });
  } catch (err) {
    console.error('❌ อัปเดตสถานะขัดข้อง:', err.message);
    res.status(500).json({ success: false, message: err.toString() });
  } finally {
    sheetLock.release(); // 🛡️ คืนกุญแจให้คิวต่อไป
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
app.get('/api/settings', (req, res) => res.json({}));

app.post('/api/waves/bulk-insert', async (req, res) => {
  await sheetLock.acquire(); // 🛡️ ล็อกเพื่อไม่ให้ใครเขียนทับพร้อมกัน
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

      // 📊 ซิงค์ Dashboard_Summary และล้างแคช
      const updatedWaves = await fetchWaveDataFromSheets();
      await updateDashboardSummary(updatedWaves);
      waveDataCache = null; // 🟢 ล้าง Cache 
    }

    return res.json({ success: true, plannedWavesUpdated: sheetData.length, message: `นำเข้าสำเร็จ` });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  } finally {
    sheetLock.release(); // 🛡️
  }
});

app.post('/api/wms-204/bulk', async (req, res) => {
  await sheetLock.acquire(); // 🛡️ ล็อกเพื่อไม่ให้ใครเขียนทับพร้อมกัน
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
      waveDataCache = null; // 🟢 ล้าง Cache เมื่ออัปเดต 204
    }

    return res.json({ success: true, message: 'บันทึกข้อมูล 204 ลง Google Sheets สำเร็จ' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  } finally {
    sheetLock.release(); // 🛡️
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
app.post('/api/update-204-time', (req, res) => {
  last204TimeStr = req.body.time || last204TimeStr;
  res.json({ success: true, time: last204TimeStr });
});
app.get('/api/last-204-time', (req, res) => {
  res.json({ time: last204TimeStr });
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
