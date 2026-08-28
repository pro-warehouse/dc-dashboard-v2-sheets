const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');
const https = require('https');

const MAX_REASONABLE_WAVE_QTY = 1000000;

// === 1. ตั้งค่า Google Sheets ===
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
  console.log('✅ เชื่อมต่อ Google Sheets สำเร็จ');
  
  // เรียกฟังก์ชันสร้างหัวตารางอัตโนมัติเมื่อเริ่มเปิดเซิร์ฟเวอร์
  initSheetsHeaders();
} else {
  console.warn('⚠️ ไม่พบไฟล์ key.json');
}

// === 2. ฟังก์ชันสร้างหัวตารางอัตโนมัติ ===
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
      'Created_At', 'Imported_At'
    ];
    const logHeaders = ['timestamp', 'user', 'waveId', 'action'];

    const checkAndSetHeaders = async (sheetName, headers) => {
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: DB_SPREADSHEET_ID,
        range: `${sheetName}!A1:Z1`,
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

    await checkAndSetHeaders('Wave_Monitoring', waveHeaders);
    await checkAndSetHeaders('System_Logs', logHeaders);
  } catch (error) {
    console.error('❌ สร้างหัวตาราง Google Sheets ไม่สำเร็จ:', error.message);
  }
}

// === 3. Helper Functions ===
function standardizeWaveId(id) {
  if (!id) return '';
  const num = String(id).replace(/^WAVE-?/i, '').replace(/^W-?/i, '').replace(/^0+/, '');
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
  const cleaned = String(value).trim().replace(/,/g, '').replace(/\s/g, '').replace(/[^\d.-]/g, '');
  if (!cleaned || cleaned === '-' || cleaned === '.') return 0;
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) return 0;
  const rounded = Math.round(parsed);
  return Math.abs(rounded) <= MAX_REASONABLE_WAVE_QTY ? rounded : 0;
}

function getWaveNumberNoZero(id) {
  return String(id ?? '').replace(/^WAVE-?/i, '').replace(/^W-?/i, '').replace(/^0+/, '') || '0';
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
  const booking = getBookingKey(wave.originalBookingNo || wave.originalBooking || wave.bookingNo || wave.Vehicle_Booking_No || wave.booking);
  return booking ? `${waveId}__${booking}` : waveId;
}

function getRowOverlayKey(row) {
  return getWaveUpdateKey({ id: row.Wave_Number, bookingNo: row.Vehicle_Booking_No || row.Booking_No });
}

// === เริ่ม Express App ===