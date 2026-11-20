import {expect, test} from 'bun:test';
import * as c from '../src/terrain/domain/core';

// Domain assertions kept from the deleted legacy scripts app/tests/terrain.mjs
// and app/tests/workflow.mjs (their api.server.ts / SQLite parts were dead).
const field = {id: 'f1', role: 'field'}, other = {id: 'f2', role: 'field'}, admin = {id: 'a', role: 'admin'};
const manager = {id: 'm', role: 'manager'}, doctor = {id: 'd', role: 'doctor'};
const own = {field_id: 'f1', status: 'ongoing', report_status: 'draft'};

test('mission access and edit rights by role', () => {
  for (const u of [admin, manager, field]) expect(c.canMission(u as any, own as any)).toBeTruthy();
  for (const u of [other, doctor]) expect(c.canMission(u as any, own as any)).toBeFalsy();
  expect(c.canEdit(other as any, own as any)).toBeFalsy();
  expect(c.canEdit(doctor as any, own as any)).toBeFalsy();
  for (const status of ['planned', 'cancelled']) expect(c.canEdit(field as any, {...own, status} as any)).toBeFalsy();
  for (const report_status of ['submitted', 'approved']) expect(c.canEdit(field as any, {...own, status: 'completed', report_status} as any)).toBeFalsy();
  for (const report_status of ['draft', 'changes']) expect(c.canEdit(field as any, {...own, status: 'completed', report_status} as any)).toBeTruthy();
});

test('Alger dates, weeks and centime arithmetic', () => {
  expect(c.dayInAlger('2026-11-13T23:15:00.000Z')).toBe('2026-11-14');
  expect(c.weekStart('2026-11-15')).toBe('2026-11-09');
  expect(c.shiftDay('2028-02-28', 1)).toBe('2028-02-29');
  expect(c.ticketTotal([{qty: 3, unit_price: 180050}, {qty: 2, unit_price: 150000}] as any)).toBe(840150);
});

test('stock equation and report checks', () => {
  const tickets = [{status: 'valid', lines: [{product_id: 'p', qty: 3, unit_price: 180000}]}, {status: 'void', lines: [{product_id: 'p', qty: 100, unit_price: 180000}]}];
  const count = {product_id: 'p', opening: 10, received: 2, other_out: 1, closing: 8, note: ''};
  expect(c.soldBy(tickets as any)).toEqual({p: 3});
  expect(c.expected({...count, damaged: 5} as any, 3)).toBe(8);
  expect(c.reportIssues([count] as any, tickets as any, false)).toEqual([]);
  expect(c.reportIssues([{...count, closing: 7}] as any, tickets as any, false).length).toBe(1);
  expect(c.reportIssues([{...count, closing: 7, note: 'Comptage à recontrôler'}] as any, tickets as any, false).length).toBe(0);
  expect(c.reportIssues([{...count, closing: null}] as any, tickets as any, false).length).toBe(1);
  expect(c.reportIssues([{...count, closing: 11}] as any, [], false).length).toBeGreaterThan(0);
  expect(c.reportIssues([{...count, closing: 11}] as any, [], true)).toEqual([]);
  expect(c.reportIssues([], [], true)).toEqual([]);
  expect(c.reportIssues([], [{status: 'valid', lines: [{product_id: 'p', qty: 2, unit_price: 100}]}] as any, false)).toEqual([]);
  expect(c.reportIssues([], [], false).length).toBeGreaterThan(0);
  expect(c.reportIssues([{product_id: 'p', opening: 5, received: 0, other_out: 0, closing: null, note: ''}] as any, [], true).length).toBeGreaterThan(0);
});

test('expiry follow-up, CSV safety and brands', () => {
  expect(c.expiryState('2026-11-13', '2026-11-14')).toBe('expired');
  expect(c.expiryState('2026-11-15', '2026-11-14')).toBe('soon');
  expect(c.expiryState('')).toBe('unknown');
  expect(c.csv([['=1+1']])).toContain("'=1+1");
  expect(c.csv([['a"b']])).toContain('a""b');
  expect(Object.keys(c.BRANDS)).toEqual(['TOUCHE', 'BELNCO', 'NOOM']);
});

test('attendance alerts and clock rules', () => {
  const at = '2026-11-14T07:00:00.000Z'; // 08:00 Alger
  const m = {id: 'm1', field_id: 'f1', day: '2026-11-14', start_at: at, end_at: '2026-11-14T16:00:00.000Z', status: 'planned', actual_start: null, late_grace_minutes: 15};
  expect(c.attendance(m as any, at)).toBeNull();
  expect(c.attendance(m as any, '2026-11-14T07:14:59Z')).toBeNull();
  expect(c.attendance(m as any, '2026-11-14T07:15:00Z')).toBeNull();
  expect(c.attendance(m as any, '2026-11-14T07:16:00Z')).toEqual({kind: 'missing_start', minutes: 16} as any);
  expect(c.attendance({...m, status: 'ongoing', actual_start: '2026-11-14T11:00:00Z'} as any, '2026-11-14T12:00:00Z')).toEqual({kind: 'late_start', minutes: 240} as any);
  expect(c.delayLabel(240)).toBe('4 h');
  expect(c.attendance({...m, status: 'cancelled'} as any, '2026-11-14T15:00:00Z')).toBeNull();
  expect(c.attendance({...m, actual_start: '2026-11-14T06:45:00Z', status: 'ongoing'} as any, '2026-11-14T12:00:00Z')).toBeNull();
  expect(c.attendance({...m, late_grace_minutes: 0} as any, '2026-11-14T07:01:00Z')).toEqual({kind: 'missing_start', minutes: 1} as any);
  const running = {...m, status: 'ongoing', actual_start: '2026-11-14T06:45:00Z'};
  expect(c.attendance(running as any, '2026-11-14T16:15:00Z')).toBeNull();
  expect(c.attendance(running as any, '2026-11-14T16:16:00Z')).toEqual({kind: 'missing_end', minutes: 16} as any);
  expect(c.attendance({...running, actual_start: '2026-11-14T11:00:00Z'} as any, '2026-11-16T16:00:00Z')).toEqual({kind: 'missing_end', minutes: 2880} as any);
  expect(c.attendance({...running, status: 'completed', actual_end: '2026-11-14T16:00:00Z'} as any, '2026-11-14T18:00:00Z')).toBeNull();
  expect(c.clockIssue(field as any, m as any, 'checkin', at)).toBeNull();
  for (const u of [{id: 'f2', role: 'field'}, {id: 'f1', role: 'admin'}, {id: 'f1', role: 'doctor'}]) expect(c.clockIssue(u as any, m as any, 'checkin', at)).toBeTruthy();
  expect(c.clockIssue(field as any, m as any, 'checkin', '2026-11-15T07:00:00Z')).toBeTruthy();
  expect(c.clockIssue(field as any, m as any, 'checkout', at)).toBeTruthy();
  expect(c.clockIssue(field as any, {...m, status: 'ongoing', actual_start: at} as any, 'checkout', at)).toBeNull();
  expect(c.clockIssue(field as any, {...m, status: 'completed', actual_start: at} as any, 'checkout', at)).toBeTruthy();
});
