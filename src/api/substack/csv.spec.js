import {test, describe} from 'node:test';
import assert from 'node:assert/strict';
import {parseCsv} from './csv.js';

describe('parseCsv — basics', () => {
  test('splits the header from the rows', () => {
    assert.deepEqual(parseCsv('a,b\n1,2'), {header: ['a', 'b'], rows: [['1', '2']]});
  });

  test('an empty input has no header and no rows', () => {
    assert.deepEqual(parseCsv(''), {header: [], rows: []});
    assert.deepEqual(parseCsv('   '), {header: [], rows: []});
  });

  test('a header with no data rows yields an empty rows list', () => {
    assert.deepEqual(parseCsv('a,b'), {header: ['a', 'b'], rows: []});
  });

  test('a trailing newline does not become an empty row', () => {
    assert.deepEqual(parseCsv('a,b\n1,2\n').rows, [['1', '2']]);
  });

  test('handles CRLF line endings', () => {
    assert.deepEqual(parseCsv('a,b\r\n1,2\r\n'), {header: ['a', 'b'], rows: [['1', '2']]});
  });

  test('an empty field is an empty string, not undefined', () => {
    assert.deepEqual(parseCsv('a,b,c\n1,,3').rows, [['1', '', '3']]);
  });

  test('keeps a trailing empty field', () => {
    assert.deepEqual(parseCsv('a,b\n1,').rows, [['1', '']]);
  });
});

describe('parseCsv — quoting', () => {
  // The reason this parser exists at all: subscriber names and place names contain commas, and a
  // split(',') silently shifts every field after one of them onto the wrong column.
  test('a comma inside quotes does not split the field', () => {
    assert.deepEqual(
      parseCsv('name,country\n"Smith, John",IT').rows,
      [['Smith, John', 'IT']]
    );
  });

  test('strips the surrounding quotes', () => {
    assert.deepEqual(parseCsv('a\n"plain"').rows, [['plain']]);
  });

  test('a doubled quote inside a quoted field becomes one quote', () => {
    assert.deepEqual(parseCsv('a\n"say ""hi"" now"').rows, [['say "hi" now']]);
  });

  test('a newline inside quotes stays inside the field', () => {
    assert.deepEqual(parseCsv('a,b\n"line one\nline two",x').rows, [['line one\nline two', 'x']]);
  });

  test('a quoted header cell is unquoted too', () => {
    assert.deepEqual(parseCsv('"a,1",b').header, ['a,1', 'b']);
  });

  test('an unterminated quote consumes the rest of the input rather than throwing', () => {
    // Malformed input should degrade, not explode: the caller gets something inspectable.
    assert.deepEqual(parseCsv('a,b\n"never closed,x').rows, [['never closed,x']]);
  });

  test('a quote in the middle of an unquoted field is kept literally', () => {
    assert.deepEqual(parseCsv('a\n12" pizza').rows, [['12" pizza']]);
  });
});

describe('parseCsv — real Substack shapes', () => {
  // Shaped after a real export: the header carries human labels, values are display-formatted
  // (a currency string, not a number), and the column order is the server's, not the caller's.
  test('parses an export row with a formatted currency and ISO dates', () => {
    const csv = [
      'Email,Name,Start date,Emails opened (30d),Revenue,Activity',
      'a@b.c,Daniel,2026-07-29T22:07:50.299Z,2,"€0.00",5',
    ].join('\n');

    const {header, rows} = parseCsv(csv);

    assert.deepEqual(header, ['Email', 'Name', 'Start date', 'Emails opened (30d)', 'Revenue', 'Activity']);
    assert.deepEqual(rows, [['a@b.c', 'Daniel', '2026-07-29T22:07:50.299Z', '2', '€0.00', '5']]);
  });

  test('a row with fewer cells than the header is still returned', () => {
    // Not padded or rejected here: the caller decides, and silently inventing cells would hide a
    // malformed export.
    assert.deepEqual(parseCsv('a,b,c\n1,2').rows, [['1', '2']]);
  });
});
