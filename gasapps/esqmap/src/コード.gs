/**
 * esqmap - 地図マーキングアプリ (GAS Webアプリ版) バックエンド
 *
 * データベース: スプレッドシートの `Marks` シート (無ければ1番目のシート)
 * カラム: id | title | memo | shape | color | lat | lng | createdAt | updatedAt
 */

const SHEET_NAME = 'Marks';
const HEADERS = ['id', 'title', 'memo', 'shape', 'color', 'lat', 'lng', 'createdAt', 'updatedAt'];
const NUM_COLS = HEADERS.length;
const SHAPES = ['small-circle', 'house'];
const COLORS = ['#ffffff', '#9ca3af', '#111827'];
const MAX_TITLE_LENGTH = 100;
const MAX_MEMO_LENGTH = 2000;
const LOCK_TIMEOUT_MS = 10000;
const SPREADSHEET_ID_KEY = 'SPREADSHEET_ID';

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

function doGet(e) {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('esqmap')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover');
}

// ---------------------------------------------------------------------------
// API (google.script.run)
// ---------------------------------------------------------------------------

/**
 * 全マークを取得する。
 * @return {Object[]} マークの配列
 */
function getAllMarks() {
  const sheet = getSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const values = sheet.getRange(2, 1, lastRow - 1, NUM_COLS).getValues();
  return values
    .filter(function (row) { return row[0] !== '' && row[0] !== null; })
    .map(rowToMark_);
}

/**
 * マークを新規作成する。
 * @param {Object} data {title, memo, shape, color, lat, lng}
 * @return {Object} 作成されたマーク (id 払い出し済み)
 */
function createMark(data) {
  const fields = sanitize_(data, false);
  return withLock_(function () {
    const sheet = getSheet_();
    ensureHeader_(sheet);
    const now = new Date().toISOString();
    const mark = {
      id: Utilities.getUuid(),
      title: fields.title,
      memo: fields.memo,
      shape: fields.shape,
      color: fields.color,
      lat: fields.lat,
      lng: fields.lng,
      createdAt: now,
      updatedAt: now
    };
    sheet.appendRow(markToRow_(mark));
    SpreadsheetApp.flush();
    return mark;
  });
}

/**
 * マークを更新する。行番号はキャッシュせず、呼び出し時に id から動的に特定する。
 * @param {string} id
 * @param {Object} data 更新するフィールド (部分更新可)
 * @return {Object} 更新後のマーク
 */
function updateMark(id, data) {
  const markId = sanitizeId_(id);
  const fields = sanitize_(data, true);
  return withLock_(function () {
    const sheet = getSheet_();
    const row = findRowById_(sheet, markId);
    if (row < 0) throw new Error('NOT_FOUND: マークが見つかりません (id=' + markId + ')');
    const range = sheet.getRange(row, 1, 1, NUM_COLS);
    const current = rowToMark_(range.getValues()[0]);
    const updated = Object.assign({}, current, fields, {
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString()
    });
    range.setValues([markToRow_(updated)]);
    SpreadsheetApp.flush();
    return updated;
  });
}

/**
 * マークを削除する。既に存在しない場合も成功扱い (冪等)。
 * @param {string} id
 * @return {{id: string, deleted: boolean}}
 */
function deleteMark(id) {
  const markId = sanitizeId_(id);
  return withLock_(function () {
    const sheet = getSheet_();
    const row = findRowById_(sheet, markId);
    if (row < 0) return { id: markId, deleted: false };
    sheet.deleteRow(row);
    SpreadsheetApp.flush();
    return { id: markId, deleted: true };
  });
}

// ---------------------------------------------------------------------------
// 初期セットアップ (スクリプトエディタから1度だけ手動実行)
// ---------------------------------------------------------------------------

/**
 * データ用スプレッドシートと Marks シートを準備し、ID をスクリプトプロパティに保存する。
 * - コンテナバインド: バインド先スプレッドシートを使用
 * - スタンドアロン: 新規スプレッドシートを作成
 */
function setup() {
  const props = PropertiesService.getScriptProperties();
  let ss;
  const savedId = props.getProperty(SPREADSHEET_ID_KEY);
  if (savedId) {
    ss = SpreadsheetApp.openById(savedId);
  } else {
    ss = SpreadsheetApp.getActiveSpreadsheet() || SpreadsheetApp.create('esqmap データ');
    props.setProperty(SPREADSHEET_ID_KEY, ss.getId());
  }

  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    const first = ss.getSheets()[0];
    if (first.getLastRow() === 0) {
      first.setName(SHEET_NAME);
      sheet = first;
    } else {
      sheet = ss.insertSheet(SHEET_NAME, 0);
    }
  }
  ensureHeader_(sheet);
  Logger.log('セットアップ完了: %s', ss.getUrl());
}

// ---------------------------------------------------------------------------
// 内部関数
// ---------------------------------------------------------------------------

function getSpreadsheet_() {
  const id = PropertiesService.getScriptProperties().getProperty(SPREADSHEET_ID_KEY);
  const ss = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('スプレッドシートが見つかりません。スクリプトエディタで setup() を実行してください。');
  return ss;
}

function getSheet_() {
  const ss = getSpreadsheet_();
  return ss.getSheetByName(SHEET_NAME) || ss.getSheets()[0];
}

function ensureHeader_(sheet) {
  if (sheet.getLastRow() > 0) return;
  sheet.getRange(1, 1, 1, NUM_COLS).setValues([HEADERS]).setFontWeight('bold');
  sheet.setFrozenRows(1);
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_TIMEOUT_MS)) {
    throw new Error('BUSY: サーバーが混み合っています。しばらくしてから再度お試しください。');
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

/** id 列 (A列) を TextFinder で完全一致検索し、現在の行番号を返す。見つからなければ -1。 */
function findRowById_(sheet, id) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;
  const cell = sheet.getRange(2, 1, lastRow - 1, 1)
    .createTextFinder(id)
    .matchEntireCell(true)
    .matchCase(true)
    .findNext();
  return cell ? cell.getRow() : -1;
}

function rowToMark_(row) {
  const shape = toStr_(row[3]);
  const color = toStr_(row[4]).toLowerCase();
  return {
    id: toStr_(row[0]),
    title: toStr_(row[1]),
    memo: toStr_(row[2]),
    shape: SHAPES.indexOf(shape) >= 0 ? shape : SHAPES[0],
    color: COLORS.indexOf(color) >= 0 ? color : COLORS[0],
    lat: Number(row[5]),
    lng: Number(row[6]),
    createdAt: toStr_(row[7]),
    updatedAt: toStr_(row[8])
  };
}

/** 文字列は先頭に ' を付けて書き込み、数式化や日付・数値への自動変換を防ぐ。 */
function markToRow_(mark) {
  return [
    asText_(mark.id),
    asText_(mark.title),
    asText_(mark.memo),
    asText_(mark.shape),
    asText_(mark.color),
    mark.lat,
    mark.lng,
    asText_(mark.createdAt),
    asText_(mark.updatedAt)
  ];
}

function asText_(value) {
  const s = toStr_(value);
  return s === '' ? '' : "'" + s;
}

// google.script.run は Date を返せないため、文字列に正規化する
function toStr_(value) {
  if (value instanceof Date) return value.toISOString();
  return value === null || value === undefined ? '' : String(value);
}

function sanitizeId_(id) {
  const s = toStr_(id).trim();
  if (!s) throw new Error('INVALID: id が指定されていません');
  return s;
}

/**
 * クライアントからの入力を検証・正規化する。
 * @param {Object} data
 * @param {boolean} partial true の場合、未指定フィールドは結果に含めない
 */
function sanitize_(data, partial) {
  if (!data || typeof data !== 'object') throw new Error('INVALID: データが不正です');
  const out = {};
  const has = function (key) { return data[key] !== undefined && data[key] !== null; };

  if (has('title') || !partial) out.title = toStr_(data.title).trim().slice(0, MAX_TITLE_LENGTH);
  if (has('memo') || !partial) out.memo = toStr_(data.memo).slice(0, MAX_MEMO_LENGTH);

  if (has('shape') || !partial) {
    if (SHAPES.indexOf(data.shape) < 0) throw new Error('INVALID: shape が不正です');
    out.shape = data.shape;
  }
  if (has('color') || !partial) {
    const color = toStr_(data.color).toLowerCase();
    if (COLORS.indexOf(color) < 0) throw new Error('INVALID: color が不正です');
    out.color = color;
  }
  if (has('lat') || !partial) {
    const lat = Number(data.lat);
    if (!isFinite(lat) || lat < -90 || lat > 90) throw new Error('INVALID: lat が不正です');
    out.lat = lat;
  }
  if (has('lng') || !partial) {
    const lng = Number(data.lng);
    if (!isFinite(lng) || lng < -180 || lng > 180) throw new Error('INVALID: lng が不正です');
    out.lng = lng;
  }
  return out;
}
