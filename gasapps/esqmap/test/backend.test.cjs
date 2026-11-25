const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../src/コード.gs'), 'utf8');
const oldHeaders = ['id', 'title', 'memo', 'shape', 'color', 'lat', 'lng', 'createdAt', 'updatedAt'];
const newHeaders = ['letter', 'region', 'class', 'type', 'rank'];

function harness(initialRows, maxColumns = 14) {
  const rows = initialRows.map(row => row.slice());
  let locked = false;
  const sheet = {
    getLastRow: () => rows.length,
    getLastColumn: () => Math.max(0, ...rows.map(row => row.length)),
    getMaxColumns: () => maxColumns,
    insertColumnsAfter: (_, count) => { maxColumns += count; },
    getRange(row, col, height = 1, width = 1) {
      return {
        getValues: () => Array.from({ length: height }, (_, r) =>
          Array.from({ length: width }, (_, c) => (rows[row + r - 1] || [])[col + c - 1] ?? '')),
        setValues(values) {
          values.forEach((valueRow, r) => valueRow.forEach((value, c) => {
            rows[row + r - 1] ||= [];
            rows[row + r - 1][col + c - 1] = typeof value === 'string' && value.startsWith("'") ? value.slice(1) : value;
          }));
          return this;
        },
        setValue(value) { return this.setValues([[value]]); },
        setFontWeight() { return this; },
        createTextFinder(value) {
          return {
            matchEntireCell() { return this; },
            matchCase() { return this; },
            findNext() {
              const index = rows.findIndex((r, i) => i >= row - 1 && r[col - 1] === value);
              return index < 0 ? null : { getRow: () => index + 1 };
            }
          };
        }
      };
    },
    appendRow(row) {
      rows.push(row.map(value => typeof value === 'string' && value.startsWith("'") ? value.slice(1) : value));
    },
    deleteRow(row) { rows.splice(row - 1, 1); },
    setFrozenRows() {}
  };
  const ss = { getSheetByName: () => sheet, getSheets: () => [sheet] };
  const context = vm.createContext({
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, flush() {} },
    LockService: { getScriptLock: () => ({
      tryLock: () => { assert.equal(locked, false); locked = true; return true; },
      releaseLock: () => { locked = false; }
    }) },
    Utilities: { getUuid: () => 'new-id' }
  });
  vm.runInContext(source, context);
  return { api: context, rows };
}

test('旧シートを移行し、新しい項目を作成・部分更新して再読込する', () => {
  const oldRow = ['old-id', '001', 'old', 'house', '#ffffff', 35, 139, '2020-01-01', '2020-01-02'];
  const { api, rows } = harness([oldHeaders, oldRow], 9);
  const old = api.getAllMarks()[0];
  assert.deepEqual(rows[0], oldHeaders.concat(newHeaders));
  assert.deepEqual(rows[1], oldRow);
  assert.equal(old.type, '-');
  assert.equal(old.rank, '0');
  api.createMark({ title: '0002', letter: 'あ', region: '東京', class: '001', type: '', rank: '',
    memo: '=1+1', shape: 'small-circle', color: '#ffffff', lat: 35, lng: 139 });
  api.updateMark('old-id', { letter: 'い', region: '大阪', class: '002', type: 'K', rank: 3, lat: 36 });
  const marks = api.getAllMarks();
  assert.deepEqual(Array.from(marks, mark => [mark.title, mark.letter, mark.region, mark.class, mark.type, mark.rank, mark.lat]),
    [['001', 'い', '大阪', '002', 'K', '3', 36], ['0002', 'あ', '東京', '001', '-', '0', 35]]);
  assert.equal(marks[1].memo, '=1+1');
  assert.equal(marks[0].memo, 'old');
  api.updateMark('old-id', { type: null, rank: null });
  assert.equal(api.getAllMarks()[0].type, '-');
  assert.equal(api.getAllMarks()[0].rank, '0');
});

test('不正なヘッダーやヘッダーのない既存データを上書きしない', () => {
  const wrongHeader = harness([oldHeaders.concat('other')]);
  assert.throws(() => wrongHeader.api.getAllMarks(), /ヘッダーが不正/);
  assert.equal(wrongHeader.rows[0][9], 'other');
  const orphanData = harness([oldHeaders, ['id', '', '', '', '', 1, 2, '', '', 'existing']]);
  assert.throws(() => orphanData.api.getAllMarks(), /ヘッダーのない列/);
  assert.equal(orphanData.rows[1][9], 'existing');
  assert.equal(orphanData.rows[0][9], undefined);
});

test('型とランクの不正値を拒否する', () => {
  const { api } = harness([oldHeaders]);
  assert.throws(() => api.updateMark('id', { type: 'X' }), /type が不正/);
  assert.throws(() => api.updateMark('id', { rank: '4' }), /rank が不正/);
  const invalidSheet = harness([oldHeaders.concat(newHeaders),
    ['id', '', '', 'house', '#ffffff', 1, 2, '', '', '', '', '', 'Z', '9']]);
  assert.throws(() => invalidSheet.api.getAllMarks(), /シートの rank が不正/);
});
